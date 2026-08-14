import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { getPromptInput, fillPrompt, getGenerateButton } from './composer.js';

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

// Navigate to a specific generation's /edit/{id} page. Prefers clicking the
// matching gallery tile link (real SPA nav) if it's present in the current
// DOM; falls back to a hard page.goto for an id/url not currently rendered
// (e.g. found via a prior listGenerations call whose tiles have since
// scrolled out). Flow's SPA can bounce back to the gallery on a bad/stale id
// — verified live — so the landing URL is always checked afterward.
export async function navigateToGeneration(page, { id, url } = {}) {
  if (!id && !url) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'navigateToGeneration requires either id or url.');
  }

  if (id) {
    const tileLink = page.locator(`a[href*="/edit/${id}"]`).first();
    if (await tileLink.isVisible().catch(() => false)) {
      await tileLink.click();
      await page.waitForTimeout(1000);
      if (/\/edit\//.test(page.url())) return page.url();
    }
  }

  const targetUrl = url
    ? (url.startsWith('http') ? url : `https://labs.google/fx${url.startsWith('/fx') ? url.slice(3) : url}`)
    : (() => {
        const projectId = page.url().split('/project/')[1]?.split(/[/?#]/)[0];
        if (!projectId) {
          throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not determine current project id to build edit URL.');
        }
        return `https://labs.google/fx/en/tools/flow/project/${projectId}/edit/${id}`;
      })();

  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });

  if (!/\/edit\//.test(page.url())) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
      `Navigated to ${targetUrl} but Flow redirected back to ${page.url()} — edit view did not load.`);
  }

  return page.url();
}

// Follow-up (in-place) edit on the generation currently open on an /edit/
// page — same Slate composer as the bottom bar, confirmed live: clicking
// Create there updates the image without navigating away from /edit/{id}.
// Caller must already be on an /edit/ page (checked here, not silently
// handled — navigating there is a distinct, explicit step via
// navigateToGeneration).
export async function followUpEdit(page, instruction, { timeoutMs } = {}) {
  if (!/\/edit\//.test(page.url())) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      'followUpEdit requires the page to already be on a generation\'s /edit/ page.');
  }

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

  const baselineIds = await getVisibleMediaIds(page);
  logger.info('Clicking Create for follow-up edit — credits will be spent', { instruction });
  await generateBtn.click();

  const newIds = await waitForNewMedia(page, baselineIds, { timeoutMs });
  if (newIds.length === 0) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
      'Follow-up edit completed but no new media was detected in the DOM.');
  }

  return newIds;
}
