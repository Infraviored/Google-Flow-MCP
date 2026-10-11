import { logger } from '../utils/logger.js';
import { fetchProjectContents, projectIdFromUrl, mediaIdsOfProject, waitForNewProjectMedia } from './flow-api.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getPromptInput, fillPrompt, getGenerateButton } from './composer.js';
import { humanClick } from './safe-actions.js';

// Open a generation's /edit/ page the way a person does: from the project
// gallery, by clicking its tile. A hard page.goto straight to /edit/{id}
// loads fine, but an edit submitted from there was rejected by Flow's
// reCAPTCHA ("unusual activity"); after a tile click it went through.
// Tiles carry no ids — they are matched by their thumbnail token (flow-api.js).
export async function navigateToGeneration(page, { id, url } = {}) {
  if (!id && !url) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'navigateToGeneration requires either id or url.');
  }
  if (url) {
    const projectId = projectIdFromUrl(url);
    id = url.split('/edit/')[1]?.split(/[/?#]/)[0];
    if (!projectId || !id) throw new FlowError(ErrorCodes.INVALID_PARAMS, `Not an edit URL: ${url}`);
    if (projectIdFromUrl(page.url()) !== projectId) {
      await page.goto(`https://flow.google.com/project/${projectId}`, { waitUntil: 'load', timeout: 30000 });
    }
  }
  if (page.url().includes(`/edit/${id}`)) return page.url();

  const projectId = projectIdFromUrl(page.url());
  if (!projectId) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Not inside a project — cannot open a generation by id.');
  if (page.url().includes('/edit/')) {
    await page.goto(`https://flow.google.com/project/${projectId}`, { waitUntil: 'load', timeout: 30000 });
  }

  const { generations, media } = await fetchProjectContents(page, projectId);
  const gen = generations.find(g => g.editId === id);
  if (!gen) throw new FlowError(ErrorCodes.INVALID_PARAMS, `Generation ${id} is not in project ${projectId}.`);
  const token = media.find(m => m.mediaId === gen.primaryMediaId)?.thumbToken;

  const tile = token ? page.locator(`img[src*="${token}"]`).first() : null;
  let found = false;
  for (let i = 0; tile && i < 30 && !found; i++) {
    found = await tile.isVisible().catch(() => false);
    if (!found) { await page.mouse.wheel(0, 600); await page.waitForTimeout(400); }
  }
  if (found) {
    await humanClick(page, tile);
    await page.waitForURL(new RegExp(`/edit/${id}`), { timeout: 15000 }).catch(() => {});
  }
  if (!page.url().includes(`/edit/${id}`)) {
    logger.warn('Gallery tile not found or click did not open it — loading the edit URL directly', { id });
    await page.goto(`https://flow.google.com/project/${projectId}/edit/${id}`, { waitUntil: 'load', timeout: 30000 });
  }
  if (!/\/edit\//.test(page.url())) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Could not open generation ${id} — Flow shows ${page.url()}.`);
  }
  await page.waitForTimeout(1000);
  return page.url();
}

// Flow reports the outcome of a 2K upscale in a transient toast rather than in
// anything the download machinery can observe, so a failed upscale used to look
// exactly like a slow one: the caller waited out the full 60s download timeout
// and then blamed the timeout. Reading the toast turns that into a ~2s answer
// with Flow's own wording attached.
//
// Deliberately does NOT target a hashed class — those change on every Flow
// deploy. The live-region roles are semantic and stable, with a whole-document
// scan as the last resort.
export async function readUpscaleToast(page) {
  return await page.evaluate(() => {
    const pattern = /Upscal(?:ing|e)[^.!]*(Failed|complete)/i;
    const regions = Array.from(document.querySelectorAll('[role="status"], [role="alert"], [aria-live]'));
    for (const el of regions) {
      const m = (el.innerText || '').match(pattern);
      if (m) return { state: m[1].toLowerCase() === 'failed' ? 'failed' : 'complete', text: m[0].trim() };
    }
    const m = (document.body.innerText || '').match(pattern);
    if (m) return { state: m[1].toLowerCase() === 'failed' ? 'failed' : 'complete', text: m[0].trim() };
    return null;
  }).catch(() => null);
}

// One follow-up step on an /edit/ page. New steps are detected through Flow's
// project listing (media rows carry their workflow id), not the DOM — the page
// has no media ids in it any more. Returns the new media rows ({mediaId, dimensions, …}).
async function clickCreateAndWait(page, instruction, timeoutMs) {
  const projectId = projectIdFromUrl(page.url());
  const editId = page.url().split('/edit/')[1]?.split(/[/?#]/)[0];
  const promptInput = await getPromptInput(page);
  if (!promptInput) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find the follow-up edit composer on the edit page.');
  }
  await fillPrompt(page, promptInput, instruction);

  const generateBtn = getGenerateButton(page);
  const visible = await generateBtn.isVisible().catch(() => false);
  if (!visible) throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Create button not found on edit page.');
  const disabled = await generateBtn.isDisabled().catch(() => false);
  if (disabled) throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Create button is disabled on edit page.');

  const baseline = await mediaIdsOfProject(page, projectId);
  logger.info('Clicking Create for follow-up edit — credits will be spent', { instruction });
  await humanClick(page, generateBtn);

  // An edit can return more than one variant (the composer's xN setting);
  // they land a few seconds apart, so settle briefly after the first.
  let fresh = await waitForNewProjectMedia(page, projectId, baseline, { expected: 1, editId, timeoutMs });
  if (fresh.length) {
    await page.waitForTimeout(8000);
    const { media } = await fetchProjectContents(page, projectId);
    fresh = media.filter(m => !baseline.has(m.mediaId) && m.editId === editId);
  }
  if (fresh.length === 0) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
      'Follow-up edit finished but no new step appeared on this generation. It may have been blocked; check it in Flow.');
  }
  return fresh;
}

export async function followUpEdit(page, instruction, { timeoutMs } = {}) {
  if (!/\/edit\//.test(page.url())) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      'followUpEdit requires the page to already be on a generation\'s /edit/ page.');
  }
  const projectId = projectIdFromUrl(page.url());
  const editId = page.url().split('/edit/')[1]?.split(/[/?#]/)[0];
  const before = await fetchProjectContents(page, projectId);
  const current = before.media.find(m => m.mediaId === before.generations.find(g => g.editId === editId)?.primaryMediaId);
  const beforeSize = current?.dimensions || null;

  const aspect = (d) => d.width / d.height;
  let fresh = await clickCreateAndWait(page, instruction, timeoutMs);
  const afterSize = fresh[0].dimensions;

  // Confirmed live (old Flow): an edit can silently change the canvas's aspect
  // ratio. Retry once with an explicit ratio-lock clause before giving up.
  if (beforeSize && afterSize && Math.abs(aspect(beforeSize) - aspect(afterSize)) > 0.01) {
    logger.warn('Follow-up edit changed the image aspect ratio — retrying once with an explicit ratio-lock clause', {
      instruction, beforeSize, afterSize,
    });
    const lockedInstruction = `${instruction} Keep the exact same aspect ratio and pixel dimensions as the image before this edit — do not change the canvas shape.`;
    fresh = await clickCreateAndWait(page, lockedInstruction, timeoutMs);
    const retrySize = fresh[0].dimensions;
    if (retrySize && Math.abs(aspect(beforeSize) - aspect(retrySize)) > 0.01) {
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        `Follow-up edit changed the image aspect ratio even after a ratio-lock retry ` +
        `(before: ${beforeSize.width}x${beforeSize.height}, after: ${retrySize.width}x${retrySize.height}). ` +
        `The edit was still applied (new_media_ids below) — caller must decide whether to keep or discard it.`,
        { newMediaIds: fresh.map(m => m.mediaId), beforeSize, afterSize: retrySize });
    }
  }

  return fresh.map(m => m.mediaId);
}
