import fs from 'fs';
import path from 'path';
import { downloadsPath, cacheDir, projectCachePath, outputDir } from './paths.js';
import { readJson, writeJsonAtomic, withFileLock } from './atomic-json.js';
import { logger } from './logger.js';

// The local fact store for downloads and generate-time sidecars (model/ratio).
//
// Flow itself owns generations, titles, ordered steps, prompts, and media items.
// This file joins disposable project API caches with local downloads.json facts.
// Downloads hang off the STEP (media id) rather than the generation, and paths
// are strictly absolute.

const EMPTY_DOWNLOADS = {
  version: 1,
  byMediaId: {},
  unattributed: {},
  generations: {},
};

export function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function inferVariant(prompt) {
  if (!prompt) return null;
  if (/pure black|background to (?:pure )?black|on black/i.test(prompt)) return 'black';
  if (/pure white|background to (?:pure )?white|on white/i.test(prompt)) return 'white';
  return null;
}

function loadDownloads() {
  const data = readJson(downloadsPath(), null);
  if (!data || typeof data !== 'object') return structuredClone(EMPTY_DOWNLOADS);
  return {
    version: 1,
    byMediaId: data.byMediaId || {},
    unattributed: data.unattributed || {},
    generations: data.generations || {},
    updatedAt: data.updatedAt || null,
  };
}

function mutateDownloads(fn) {
  return withFileLock(downloadsPath(), () => {
    const data = loadDownloads();
    const out = fn(data);
    data.updatedAt = new Date().toISOString();
    writeJsonAtomic(downloadsPath(), data);
    return out;
  });
}

// Sidecar for generate-time facts that aren't present in Flow's API payload.
export function recordGeneration({ editId, model, ratio }) {
  if (!editId) return null;
  if (!model && !ratio) return null;
  return mutateDownloads((data) => {
    data.generations[editId] ||= {};
    if (model !== undefined && model !== null && model !== '') data.generations[editId].model = model;
    if (ratio !== undefined && ratio !== null && ratio !== '') data.generations[editId].ratio = ratio;
    return data.generations[editId];
  });
}

export function recordDownload({ editId, mediaId, path: filePath, resolution, bytes, method }) {
  if (!editId || !filePath) return null;
  const abs = path.resolve(filePath);
  return mutateDownloads((data) => {
    const now = new Date().toISOString();
    const rec = {
      path: abs,
      resolution: resolution || '1K',
      bytes: bytes ?? null,
      at: now,
      method: method || 'direct-api',
    };

    if (!mediaId) {
      data.unattributed[editId] ||= [];
      const existing = data.unattributed[editId].find((d) => d.path === abs);
      if (existing) Object.assign(existing, rec);
      else data.unattributed[editId].push(rec);
      return rec;
    }

    data.byMediaId[mediaId] ||= [];
    const existing = data.byMediaId[mediaId].find((d) => d.path === abs);
    if (existing) Object.assign(existing, rec);
    else data.byMediaId[mediaId].push(rec);
    return rec;
  });
}

export function saveProjectCache(contents) {
  if (!contents?.projectId) throw new Error('projectId is required to save project cache');
  const cacheFile = projectCachePath(contents.projectId);
  writeJsonAtomic(cacheFile, contents);
  logger.info('Saved project cache', {
    projectId: contents.projectId,
    workflows: contents.generations?.length,
    media: contents.media?.length,
  });
  return contents;
}

export function loadProjectCache(projectId) {
  if (!projectId) return null;
  return readJson(projectCachePath(projectId), null);
}

export function loadAllProjectCaches() {
  const dir = cacheDir();
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const caches = [];
    for (const file of files) {
      const cache = readJson(path.join(dir, file), null);
      if (cache && Array.isArray(cache.generations)) {
        caches.push(cache);
      }
    }
    return caches;
  } catch {
    return [];
  }
}

const PROMPT_PREVIEW_CHARS = 160;

export function view(editId, { fullPrompts = false, step = null } = {}) {
  const dlData = loadDownloads();
  const caches = loadAllProjectCaches();

  let targetGen = null;
  let targetProject = null;
  let targetMedia = [];

  for (const cache of caches) {
    const gen = (cache.generations || []).find((g) => g.editId === editId);
    if (gen) {
      targetGen = gen;
      targetProject = cache;
      targetMedia = (cache.media || []).filter((m) => m.editId === editId);
      break;
    }
  }

  if (!targetGen && !dlData.generations[editId] && !dlData.unattributed[editId]) {
    return null;
  }

  const sidecar = dlData.generations[editId] || {};
  const unattributed = dlData.unattributed[editId] || [];

  let stepMedia = targetMedia.filter((m) => !m.derived || m.prompt || m.dimensions);
  if (!stepMedia.length && targetMedia.length > 0) {
    stepMedia = targetMedia;
  }

  stepMedia.sort((a, b) => {
    if (a.step !== null && b.step !== null) return a.step - b.step;
    if (a.step !== null) return -1;
    if (b.step !== null) return 1;
    return Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0);
  });

  if (step !== null) {
    stepMedia = stepMedia.filter((s) => s.step === step);
  }

  const steps = stepMedia.map((s) => {
    const out = { mediaId: s.mediaId };
    if (typeof s.step === 'number') out.n = s.step;
    const showFull = fullPrompts || (step !== null && s.step === step);
    if (s.prompt) {
      out.prompt = showFull || s.prompt.length <= PROMPT_PREVIEW_CHARS
        ? s.prompt
        : s.prompt.slice(0, PROMPT_PREVIEW_CHARS) + '…';
      if (!showFull && s.prompt.length > PROMPT_PREVIEW_CHARS) out.promptChars = s.prompt.length;
    }
    const variant = inferVariant(s.prompt);
    if (variant) out.variant = variant;

    const stepDownloads = [...(dlData.byMediaId[s.mediaId] || [])];

    const isLatest = s === stepMedia[stepMedia.length - 1];
    for (const dm of targetMedia) {
      if (dm.derived && dm.mediaId !== s.mediaId) {
        if (dm.step === s.step || (isLatest && (dm.step === null || dm.step >= s.step))) {
          for (const d of dlData.byMediaId[dm.mediaId] || []) {
            if (!stepDownloads.some((x) => x.path === d.path)) {
              stepDownloads.push(d);
            }
          }
        }
      }
    }

    const dl = stepDownloads.map((d) => ({
      res: d.resolution,
      p: d.path,
      present: fs.existsSync(d.path),
    }));
    if (dl.length) out.dl = dl;
    return out;
  });

  const out = { editId, steps };
  if (targetGen?.title) out.title = targetGen.title;
  if (targetProject?.projectId) {
    out.editUrl = `https://labs.google/fx/en/tools/flow/project/${targetProject.projectId}/edit/${editId}`;
  }
  if (sidecar.model) out.model = sidecar.model;
  if (sidecar.ratio) out.ratio = sidecar.ratio;
  if (unattributed.length) {
    out.unattributed = unattributed.map((d) => ({
      res: d.resolution,
      p: d.path,
      present: fs.existsSync(d.path),
    }));
  }
  return out;
}

export function findByTitle(query) {
  const q = normalizeTitle(query);
  if (!q) return [];
  const caches = loadAllProjectCaches();
  const seen = new Set();
  const entries = [];

  for (const cache of caches) {
    for (const g of cache.generations || []) {
      if (!g.title || seen.has(g.editId)) continue;
      seen.add(g.editId);
      const titleKey = normalizeTitle(g.title);
      const media = (cache.media || []).filter((m) => m.editId === g.editId && (!m.derived || m.prompt));
      entries.push({
        editId: g.editId,
        title: g.title,
        titleKey,
        stepCount: media.length,
        createdAt: g.createdAt,
      });
    }
  }

  const shape = (g) => ({ editId: g.editId, title: g.title, stepCount: g.stepCount });

  const exact = entries.filter((g) => g.titleKey === q);
  if (exact.length) return exact.map(shape);

  const contains = entries.filter((g) => g.titleKey.includes(q) || q.includes(g.titleKey));
  if (contains.length) return contains.map(shape);

  const tokens = q.split(' ').filter(Boolean);
  const subset = entries.filter((g) => tokens.every((t) => g.titleKey.includes(t)));
  return subset.map(shape);
}

export function findByMediaId(mediaId) {
  if (!mediaId) return null;
  const caches = loadAllProjectCaches();
  for (const cache of caches) {
    const m = (cache.media || []).find((x) => x.mediaId === mediaId);
    if (m?.editId) {
      const gen = (cache.generations || []).find((g) => g.editId === m.editId);
      return gen || { editId: m.editId };
    }
  }
  return null;
}

export function listGenerationsIndexed({ limit = 20 } = {}) {
  const caches = loadAllProjectCaches();
  const seen = new Set();
  const all = [];

  for (const cache of caches) {
    for (const g of cache.generations || []) {
      if (seen.has(g.editId)) continue;
      seen.add(g.editId);
      const media = (cache.media || []).filter((m) => m.editId === g.editId && (!m.derived || m.prompt));
      all.push({
        editId: g.editId,
        title: g.title,
        stepCount: media.length,
        createdAt: g.createdAt || g.updatedAt || 0,
      });
    }
  }

  return all
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, limit)
    .map((g) => ({ editId: g.editId, title: g.title, stepCount: g.stepCount }));
}

export function listOrphanDownloads() {
  const dlData = loadDownloads();
  const known = new Set();
  for (const list of Object.values(dlData.byMediaId)) {
    for (const d of list || []) if (d.path) known.add(d.path);
  }
  for (const list of Object.values(dlData.unattributed)) {
    for (const d of list || []) if (d.path) known.add(d.path);
  }
  const dir = outputDir('image');
  try {
    return fs.readdirSync(dir)
      .map((f) => path.join(dir, f))
      .filter((p) => fs.statSync(p).isFile() && !known.has(p));
  } catch {
    return [];
  }
}

export function renderMarkdown(editIds = null) {
  const dlData = loadDownloads();
  const caches = loadAllProjectCaches();
  const allGenerations = new Map();

  for (const cache of caches) {
    for (const g of cache.generations || []) {
      if (!allGenerations.has(g.editId)) {
        allGenerations.set(g.editId, {
          editId: g.editId,
          title: g.title,
          editUrl: `https://labs.google/fx/en/tools/flow/project/${cache.projectId}/edit/${g.editId}`,
          createdAt: g.createdAt || g.updatedAt || 0,
          mediaIds: (cache.media || []).filter((m) => m.editId === g.editId).map((m) => m.mediaId),
        });
      }
    }
  }

  const ids = editIds || Array.from(allGenerations.keys());
  const rows = [];

  for (const id of ids) {
    const gen = allGenerations.get(id);
    const label = gen?.title || id.slice(0, 8);
    const titleCell = gen?.editUrl ? `[${label}](${gen.editUrl})` : label;
    const files = [];

    const mediaIds = gen ? gen.mediaIds : [];
    for (const mid of mediaIds) {
      for (const d of dlData.byMediaId[mid] || []) {
        const mark = fs.existsSync(d.path) ? '' : ' ⚠missing';
        files.push(`[${path.basename(d.path)}${d.resolution ? ` (${d.resolution})` : ''}](file://${d.path})${mark}`);
      }
    }
    for (const d of dlData.unattributed[id] || []) {
      const mark = fs.existsSync(d.path) ? '' : ' ⚠missing';
      files.push(`[${path.basename(d.path)}${d.resolution ? ` (${d.resolution})` : ''}](file://${d.path})${mark}`);
    }

    rows.push(`| ${titleCell} | ${files.length ? files.join('<br>') : '_not downloaded_'} |`);
  }

  if (!rows.length) return 'No generations recorded yet.';
  return ['| Generation | Files |', '|---|---|', ...rows].join('\n');
}

export function indexLocation() {
  return downloadsPath();
}
