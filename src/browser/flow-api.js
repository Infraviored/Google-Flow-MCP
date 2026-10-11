import fs from 'fs';
import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { rpc } from './rpc.js';

// Flow's own data, read through its batchexecute RPCs (see rpc.js). The
// gallery DOM carries no ids at all any more — tiles are bare <img> with
// opaque /asb/ thumbnail URLs and no links — so everything that needs to know
// "which generation is which" goes through here.

const tsIso = (t) => (Array.isArray(t) && t[0] ? new Date(t[0] * 1000 + Math.floor((t[1] || 0) / 1e6)).toISOString() : null);

function firstString(node, test) {
  if (typeof node === 'string') return test(node) ? node : null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = firstString(n, test);
      if (hit) return hit;
    }
  }
  return null;
}

// Workflow row: [workflowId, null, null, [title, createTs, null, null, primaryMediaId, stepId, updateTs], projectId]
function parseWorkflow(w) {
  const meta = w[3] || [];
  return {
    editId: w[0],
    title: meta[0] || null,
    createdAt: tsIso(meta[1]),
    updatedAt: tsIso(meta[6]),
    primaryMediaId: meta[4] || null,
  };
}

// Media row: [mediaId, projectId, workflowId, null, null, [createTs, …, thumbUrl, [null,null,[[prompt,…]]], …], [[…, prompt, …], null, [w, h]]]
function parseMedia(m) {
  const info = m[6] || [];
  const dims = Array.isArray(info[2]) && info[2].length === 2 ? { width: info[2][0], height: info[2][1] } : null;
  const prompt = m[5]?.[6]?.[2]?.[0]?.[0] ?? info[0]?.[7] ?? null;
  const isVideo = !!firstString(m, s => /\/video\//.test(s));
  const thumb = m[5]?.[5] || null;
  return {
    mediaId: m[0],
    editId: m[2],
    // The gallery tile's <img src> is flow.google.com/asb/<token>…, the same
    // token as this thumbnail — the only link between a tile and its id.
    thumbToken: thumb?.match(/\/asb\/([^/?=]+)/)?.[1] || null,
    stepId: null,
    prompt: prompt || null,
    createdAt: tsIso(m[5]?.[0]),
    dimensions: dims,
    kind: isVideo ? 'video' : 'image',
  };
}

export function projectIdFromUrl(url) {
  return url.split('/project/')[1]?.split(/[/?#]/)[0] || null;
}

export async function listProjectsApi(page) {
  const res = await rpc(page, 'UpteDb', ['projects/*', 21, null, null, null, null, [1]]);
  return (res?.[0] || []).map(p => ({
    id: p[0],
    name: p[1]?.[0] || null,
    createdAt: tsIso(p[1]?.[2]),
    thumbnail_url: p[1]?.[3] || null,
    url: `https://flow.google.com/project/${p[0]}`,
  }));
}

export async function fetchProjectContents(page, projectId) {
  if (!projectId) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'projectId is required to fetch project contents.');
  const res = await rpc(page, 'Zzl0ze', [`projects/${projectId}`, null, null, null, [1]]);
  const generations = (res?.[1] || []).map(parseWorkflow);
  const media = (res?.[2] || []).map(parseMedia);
  logger.info('Fetched project contents from Flow', { projectId, workflows: generations.length, media: media.length });
  return { projectId, generations, media };
}

// Signed, time-limited full-size URL on flow-content.google for one media item.
export async function getMediaUrl(page, mediaId) {
  const res = await rpc(page, 'as29s', [mediaId]);
  const url = firstString(res, s => s.startsWith('https://flow-content.google/'));
  if (!url) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `No download URL for media ${mediaId}`);
  return url;
}

// Downloads one media item at its stored resolution. Returns { path, contentType, size }.
export async function downloadMedia(page, mediaId, destPathNoExt) {
  const url = await getMediaUrl(page, mediaId);
  const res = await page.request.get(url, { timeout: 120000 });
  if (!res.ok()) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download of ${mediaId} failed: HTTP ${res.status()}`);
  const contentType = res.headers()['content-type'] || '';
  const ext = contentType.includes('png') ? '.png'
    : contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
    : contentType.includes('webp') ? '.webp'
    : contentType.includes('mp4') || contentType.startsWith('video/') ? '.mp4'
    : '.bin';
  const buffer = await res.body();
  const dest = destPathNoExt + ext;
  fs.writeFileSync(dest, buffer);
  logger.info('Media downloaded', { mediaId, size: buffer.length, path: dest });
  return { path: dest, contentType, size: buffer.length };
}

export async function mediaIdsOfProject(page, projectId) {
  const { media } = await fetchProjectContents(page, projectId);
  return new Set(media.map(m => m.mediaId));
}

// Poll the project until `expected` media items that were not in `baseline`
// exist. Flow only lists a media item once it has finished rendering, so a hit
// here is downloadable. If fewer than expected show up (a blocked or failed
// output), return what arrived once the count has been stable for `settleMs`.
export async function waitForNewProjectMedia(page, projectId, baseline, {
  expected = 1, kind = null, editId = null, timeoutMs = 180000, pollMs = 4000, settleMs = 30000,
} = {}) {
  const start = Date.now();
  // Flow's reCAPTCHA rejection shows as a "Failed" card, not in the API:
  // "We noticed some unusual activity … You have not been charged".
  const rejections = () => page.getByText('We noticed some unusual activity').count().catch(() => 0);
  const rejectedBefore = await rejections();
  let fresh = [];
  let lastCount = 0;
  let lastChange = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(pollMs);
    if (await rejections() > rejectedBefore) {
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
        'Flow rejected the request as unusual activity (its reCAPTCHA check). No credits were charged. ' +
        'Wait a few minutes and retry; repeated rejections mean the session needs a break.');
    }
    const { media, generations } = await fetchProjectContents(page, projectId).catch(() => ({ media: [], generations: [] }));
    fresh = media.filter(m => !baseline.has(m.mediaId) && (!kind || m.kind === kind) && (!editId || m.editId === editId));
    for (const m of fresh) m.title = generations.find(g => g.editId === m.editId)?.title || null;
    if (fresh.length !== lastCount) { lastCount = fresh.length; lastChange = Date.now(); }
    if (fresh.length >= expected) break;
    if (fresh.length > 0 && Date.now() - lastChange > settleMs) break;
  }
  logger.info('New media after generation', { expected, found: fresh.length, ms: Date.now() - start });
  return fresh;
}
