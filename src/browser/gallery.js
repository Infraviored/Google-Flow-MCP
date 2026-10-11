import { logger } from '../utils/logger.js';
import { fetchProjectContents, projectIdFromUrl, mediaIdsOfProject, waitForNewProjectMedia } from './flow-api.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { getPromptInput, fillPrompt, getGenerateButton } from './composer.js';
import { humanClick } from './safe-actions.js';

// Poll the DOM for new media ids appearing beyond a baseline set (post-Generate,
// on both fresh generation and in-place follow-up edits). Requires the new-id
// count to hold steady across two consecutive polls — a still-loading tile can
// briefly get an img src before its final content is ready. Extracted from
// generate-image.js so generate/edit share exactly one polling implementation.
export async function waitForNewMedia(page, baselineIds, { timeoutMs } = {}) {
  const genTimeoutMs = timeoutMs || get('generationTimeoutMs', 120000);
  const genStart = Date.now();
  let stableCount = 0;
  let lastNewCount = -1;

  while (Date.now() - genStart < genTimeoutMs) {
    await page.waitForTimeout(2000);

    const newIds = await page.evaluate((baseline) => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const ids = [];
      imgs.forEach(img => {
        const src = img.src || '';
        const match = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (match && img.width > 100 && !baseline.includes(match[1])) {
          ids.push(match[1]);
        }
      });
      return [...new Set(ids)];
    }, [...baselineIds]);

    if (newIds.length > 0 && newIds.length === lastNewCount) {
      stableCount++;
      if (stableCount >= 1) {
        logger.info('New media stable in DOM', { count: newIds.length });
        return newIds;
      }
    } else {
      stableCount = 0;
    }
    lastNewCount = newIds.length;
  }

  return [];
}

// A tile's <img src="...name=X"> id and its own /edit/{Y} route id are
// DIFFERENT ids for the same tile (confirmed live). Callers that just
// generated media (which only know the img-src ids) need this to find the
// corresponding /edit/ route ids for listing/navigation/title-backfill.
//
// IMPORTANT: the id must come from the tile's own <a href="…/edit/{id}">,
// NEVER from its data-tile-id="fe_id_{id}" attribute — confirmed live that
// these are two independent id namespaces that can differ for the exact same
// tile at the exact same instant (data-tile-id and the href's id were
// different values on a freshly-generated tile that was otherwise perfectly
// stable, not a transient/loading state). Only the href's id is ever
// resolvable via navigation — that's what every caller actually needs.
export async function mapMediaIdsToTileIds(page, mediaIds) {
  return page.evaluate((ids) => {
    const out = {};
    for (const mid of ids) {
      const img = document.querySelector(`img[src*="name=${mid}"]`);
      const tile = img && img.closest('[data-tile-id]');
      const href = tile && tile.querySelector('a[href*="/edit/"]')?.getAttribute('href');
      const match = href && href.match(/\/edit\/([a-f0-9-]+)/);
      if (match) out[mid] = match[1];
    }
    return out;
  }, mediaIds);
}

// A freshly-generated tile's href-embedded id can still take a moment to
// settle after waitForNewMedia detects the img — poll until the mapping
// holds steady across two consecutive checks before trusting it.
export async function waitForStableTileIds(page, mediaIds, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    const current = await mapMediaIdsToTileIds(page, mediaIds);
    const currentKey = JSON.stringify(current);
    if (last !== null && currentKey === last && Object.keys(current).length === mediaIds.length) {
      return current;
    }
    last = currentKey;
    await page.waitForTimeout(2000);
  }

  // Timed out — return whatever the last snapshot was rather than nothing.
  return JSON.parse(last || '{}');
}

export async function getVisibleMediaIds(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    const ids = [];
    imgs.forEach(img => {
      const match = (img.src || '').match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
      if (match && img.width > 100) ids.push(match[1]);
    });
    return [...new Set(ids)];
  });
}

// The edit page's title bar has an editable text input holding the generation's
// human-readable name (e.g. "Document writing via voice orb") — confirmed live via
// the rendered DOM. Used to name downloaded files after what they actually are,
// instead of an opaque uuid, so a wrong-file mixup (see verifyNewestTileIds) is
// visible at a glance in the filename itself rather than only discoverable by
// opening the file. Only meaningful on an /edit/ page; returns null elsewhere.
export async function getGenerationTitle(page) {
  return page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Editable text"]');
    return input ? input.value.trim() : null;
  }).catch(() => null);
}

// The edit page's "history" side panel (open by default, toggled by the
// "Hide history"/"Show history" button) lists every step of this generation's
// edit chain: each step's own thumbnail <img src="...name={mediaId}"> (its own
// individually fetchable media id, confirmed live still resolvable via
// media.getMediaUrlRedirect even after later edits superseded it — this is the
// real recovery path for the "flow_edit_generation destroys the pre-edit
// version" problem, not just a naming convenience) and the exact prompt/
// instruction text that produced it, next to a `button.reuse-prompt-button`
// (a stable, non-hashed class — unlike everything else in this file, safe to
// select directly). No screenshot needed to read any of this.
// A closed panel yields zero steps, which is indistinguishable from "this
// generation has no history" to every caller — the worst possible failure for
// something whose whole job is recording what exists. Open it first.
async function ensureHistoryPanelOpen(page) {
  const count = await page.locator('[id^="history-step-"]').count().catch(() => 0);
  if (count > 0) return true;
  // Only ever the "Show" affordance — clicking "Hide history" here would
  // actively close a panel that was already fine.
  const toggle = page.locator('button:has-text("Show history"), [aria-label*="show history" i]').first();
  if (!(await toggle.isVisible().catch(() => false))) return false;
  await toggle.click().catch(() => {});
  await page.waitForSelector('[id^="history-step-"]', { timeout: 3000 }).catch(() => {});
  return (await page.locator('[id^="history-step-"]').count().catch(() => 0)) > 0;
}

export async function listHistorySteps(page) {
  await ensureHistoryPanelOpen(page);

  // The panel virtualizes like the main grid does, so a long edit chain is
  // truncated to whatever happens to be mounted. Scroll it loop-until-dry,
  // same approach listGenerations already uses on the gallery scroller.
  let previous = -1;
  for (let i = 0; i < 10; i++) {
    const count = await page.locator('[id^="history-step-"]').count().catch(() => 0);
    if (count === previous) break;
    previous = count;
    await page.evaluate(() => {
      const first = document.querySelector('[id^="history-step-"]');
      const scroller = first?.closest('[data-testid="virtuoso-scroller"]')
        || first?.parentElement?.parentElement;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }).catch(() => {});
    await page.waitForTimeout(400);
  }

  const steps = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[id^="history-step-"]'));
    return nodes.map((step, index) => {
      const idMatch = step.id.match(/^history-step-fe_id_(.+)$/);
      // The thumbnail's src is the authoritative media id, NOT the element's
      // id suffix. The suffix is the data-tile-id namespace, which usually
      // carries the same value but does not have to: caught live on a
      // freshly-generated step whose suffix held a transient id that returned
      // 404 from getMediaUrlRedirect while the img src resolved 200. The img
      // src is self-validating — it is the URL the browser is already
      // successfully rendering — so it wins, and the suffix is only a fallback
      // for a step whose thumbnail has not mounted yet.
      const img = step.querySelector('img[src*="getMediaUrlRedirect"]');
      const mediaMatch = img && (img.src || '').match(/name=([a-f0-9-]+)/);
      const reuseBtn = step.querySelector('.reuse-prompt-button');
      const promptContainer = reuseBtn ? reuseBtn.closest('div')?.parentElement : null;
      const promptText = promptContainer?.firstElementChild?.textContent?.trim() || null;
      const fromId = idMatch ? idMatch[1] : null;
      const fromImg = mediaMatch ? mediaMatch[1] : null;
      return {
        index,
        tileId: fromId,
        mediaId: fromImg || fromId,
        // Signals a still-settling panel: the caller should treat this step as
        // provisional rather than record it as fact.
        mediaIdMismatch: !!(fromId && fromImg && fromId !== fromImg),
        unmounted: !fromImg,
        prompt: promptText,
      };
    });
  }).catch(() => []);

  // A step read before its thumbnail mounted carries an id we cannot trust —
  // recording it invents a phantom step that no download will ever attach to,
  // and whose id is not even fetchable. Drop those rather than store them.
  const provisional = steps.filter(s => s.unmounted || s.mediaIdMismatch);
  if (provisional.length) {
    logger.warn('Dropping history steps read before their thumbnail settled', {
      count: provisional.length,
      of: steps.length,
    });
  }
  return steps.filter(s => !s.unmounted && !s.mediaIdMismatch);
}

// Gallery grid tiles: [data-tile-id="fe_id_..."] wrapping an
// <a href=".../edit/{id}">. Newest-first. The id is ALWAYS taken from the
// <a href>, never from data-tile-id or the <img src> — confirmed live that
// all three can be different values for the same tile at the same instant;
// only the href's id is resolvable via navigation. Row caption title (class
// sc-cb61226a-2) is only mounted on the first tile of a multi-output batch —
// callers should backfill siblings from job history.
export async function listGenerations(page, { limit = 20 } = {}) {
  const scrapeOnce = () => page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('[data-tile-id]'));
    const seen = new Set();
    const out = [];
    for (const t of tiles) {
      const a = t.querySelector('a[href*="/edit/"]');
      const href = a ? a.getAttribute('href') : null;
      const match = href && href.match(/\/edit\/([a-f0-9-]+)/);
      if (!match) continue;
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const titleEl = t.querySelector('.sc-cb61226a-2');
      out.push({
        id,
        editUrl: href,
        title: titleEl ? titleEl.textContent.trim() : null,
      });
    }
    return out;
  });

  let results = await scrapeOnce();
  const seenIds = new Set(results.map(r => r.id));

  // Virtualized grid (react-virtuoso) — scroll to load older tiles until we
  // have enough or a scroll produces nothing new (loop-until-dry).
  const scroller = page.locator('[data-testid="virtuoso-scroller"]').first();
  let dryRounds = 0;
  while (results.length < limit && dryRounds < 2) {
    const scrolled = await scroller.evaluate(el => { el.scrollTop += 2000; return true; }).catch(() => false);
    if (!scrolled) break;
    await page.waitForTimeout(800);

    const batch = await scrapeOnce();
    const fresh = batch.filter(r => !seenIds.has(r.id));
    if (fresh.length === 0) {
      dryRounds++;
      continue;
    }
    dryRounds = 0;
    fresh.forEach(r => seenIds.add(r.id));
    results = results.concat(fresh);
  }

  return results.slice(0, limit);
}

// waitForNewMedia's "new" signal is just "wasn't in the img-src baseline snapshot" —
// unsound against Flow's virtualized gallery grid, where tiles scrolled out of view
// simply aren't mounted at all. Confirmed live: a generation call returned editIds for
// 3 real, legitimate, but OLD gallery entries (one positively identified by its exact
// prompt text) instead of the tile it had actually just created — the old tiles weren't
// in the baseline because they weren't rendered yet, then mounted (e.g. from a reflow)
// and got misread as "new". Since the grid is newest-first, a genuinely new id must
// appear within the leading `checkLimit` entries of a fresh listGenerations() scan;
// anything that doesn't is untrustworthy and must not be silently returned as if it
// were the caller's own result.
export async function verifyNewestTileIds(page, editIds, { checkLimit } = {}) {
  const limit = checkLimit || Math.max(editIds.length + 5, 10);
  const recent = await listGenerations(page, { limit });
  const recentIds = new Set(recent.map(r => r.id));
  const verifiedIds = editIds.filter(id => recentIds.has(id));
  const unverifiedIds = editIds.filter(id => !recentIds.has(id));
  return { verifiedIds, unverifiedIds, allVerified: unverifiedIds.length === 0 };
}

// Navigate to a specific generation's /edit/{id} page. Prefers clicking the
// matching gallery tile link (real SPA nav) if it's present in the current
// DOM; falls back to a hard page.goto for an id/url not currently rendered
// (e.g. found via a prior listGenerations call whose tiles have since
// scrolled out). Flow's SPA can bounce back to the gallery on a bad/stale id
// — verified live — so the landing URL is always checked afterward.
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

// The edit-page composer ("What do you want to change?") has no ratio/
// settings control at all in its DOM (confirmed live) — applySettings can't
// lock the aspect ratio the way it does for fresh generations. Read the main
// hero <img>'s natural pixel size (same "img.width > 100" filter used in
// download-latest.js to pick the hero image over thumbnail-strip images) so
// followUpEdit can detect when Flow silently changed the canvas shape.
async function getMainPreviewImageSize(page) {
  return await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    let best = null;
    for (const img of imgs) {
      if (img.width > 100 && img.naturalWidth > 0 && (!best || img.width > best.width)) {
        best = { width: img.naturalWidth, height: img.naturalHeight };
      }
    }
    return best;
  }).catch(() => null);
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

// Same virtualized/mount-order risk as verifyNewestTileIds, but for the edit page's
// version-history side panel instead of the main gallery grid: its small thumbnail
// <img>s can mount/reflow independently of an actual new edit, so waitForNewMedia's
// baseline-diff can misattribute an OLD sibling version as the result of THIS edit.
// The one thing that can't lie about "what did this edit actually produce" is the main
// (largest-rendered) preview image's own current src — read its media id directly.
export async function getMainPreviewMediaId(page) {
  return await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    let best = null;
    let bestWidth = 0;
    for (const img of imgs) {
      const match = (img.src || '').match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
      if (match && img.width > 100 && img.width > bestWidth) {
        best = match[1];
        bestWidth = img.width;
      }
    }
    return best;
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
