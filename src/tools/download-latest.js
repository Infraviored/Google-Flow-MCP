import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { resolveDownloadPath } from '../utils/file-manager.js';
import { navigateToGeneration, listGenerations, getGenerationTitle } from '../browser/gallery.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Always surfaced on a successful download so the calling agent can't skip
// it: report the exact path to the human, then ask (don't just do it)
// whether to open it with their OS default viewer (e.g. `xdg-open` on
// Linux, `open` on macOS).
const REPORT_AND_OFFER_TO_OPEN_HINT =
  'Report this exact filePath to the user, then ask if they want it opened now with their OS default image viewer — do not open it without asking.';

// Build a filename base from the generation's own on-page title plus a short id
// suffix (still unique across re-downloads/edits of the same title) — sanitized
// to filesystem-safe characters. Returns null if there's no usable title, so
// callers fall back to their existing opaque-id naming.
function titleToFilenameBase(title, shortId) {
  const cleaned = (title || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return cleaned ? `${cleaned}_${shortId}` : null;
}

export async function handleDownloadLatest(args = {}) {
  const page = getPage();
  const resolution = (args?.resolution || '1K').toUpperCase();

  if (resolution === '4K') {
    throw new FlowError(
      ErrorCodes.NOT_SUPPORTED,
      '4K resolution download requires a paid plan upgrade and is not available via automation.'
    );
  }

  // Optional explicit target generation — navigate there first; both the 1K and
  // 2K paths below then simply operate on "whatever's on screen now", same as
  // their existing default (no id) behavior.
  if (args?.id) {
    await navigateToGeneration(page, { id: args.id });
  }

  if (resolution === '2K') {
    logger.info('Attempting 2K upscaled UI download');
    try {
      // The Download button with the 1K/2K/4K menu only exists on a specific
      // generation's /edit/{mediaId} page, not on the gallery grid — navigate there
      // first if we're not already on one. Grid is newest-first (confirmed live),
      // so "latest" is the first tile from listGenerations.
      if (!/\/edit\//.test(page.url())) {
        const [latest] = await listGenerations(page, { limit: 1 });
        if (!latest) {
          throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
            'Could not find a gallery tile link to the latest generation.');
        }
        await navigateToGeneration(page, { id: latest.id });
      }

      // The edit page can still be rendering the full-size image (and its
      // toolbar) right after navigation/networkidle — poll rather than
      // checking once, same race as the composer after settings-panel close.
      const downloadBtnLocator = page.locator('button:has-text("Download"), [aria-label*="download" i]').first();
      let downloadBtnVisible = false;
      const btnDeadline = Date.now() + 5000;
      while (!downloadBtnVisible && Date.now() < btnDeadline) {
        downloadBtnVisible = await downloadBtnLocator.isVisible().catch(() => false);
        if (!downloadBtnVisible) await page.waitForTimeout(300);
      }
      if (!downloadBtnVisible) {
        await takeScreenshot(page, '2k-download-btn-not-found');
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Download button not visible on page for 2K upscale');
      }

      await downloadBtnLocator.click();
      await page.waitForTimeout(500);

      const menu2kOption = page.locator('button, [role="menuitem"], [role="option"]').filter({ hasText: /2K/ }).first();
      const menu2kVisible = await menu2kOption.isVisible().catch(() => false);
      if (!menu2kVisible) {
        await takeScreenshot(page, '2k-option-not-found');
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, '"2K / Upscaled" menu option not found');
      }

      // Playwright's page.on('download')/download.saveAs() intercepts the
      // download as a blob: URL and copies it via its own temp artifact —
      // confirmed live (VibeVoice batch run) that copy can throw ENOENT
      // ("no such file or directory, copyfile /tmp/playwright-artifacts-...")
      // even though Chrome's own "Upscaling complete, downloaded!" toast
      // fired, and on some profiles no leaked copy lands in ~/Downloads to
      // fall back to either — the blob: URL itself also gets revoked by
      // Chrome's own download handler shortly after, so refetching it from
      // the page is an equally losing race. The reliable fix (confirmed live
      // via a throwaway CDP script) is to bypass all of that and have Chrome
      // itself write the file straight to disk via the DevTools Protocol.
      const scratchDir = path.join(os.tmpdir(), 'flow-mcp-2k-downloads');
      fs.mkdirSync(scratchDir, { recursive: true });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: scratchDir, eventsEnabled: true });

      let completed = null;
      let canceled = false;
      cdp.on('Browser.downloadProgress', (e) => {
        if (e.state === 'completed') completed = e;
        else if (e.state === 'canceled') canceled = true;
      });

      await menu2kOption.click();
      logger.info('Clicked 2K upscale download option, waiting for CDP download-completed event');

      const deadline = Date.now() + 60000;
      while (!completed && !canceled && Date.now() < deadline) {
        await page.waitForTimeout(300);
      }
      if (canceled) {
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, '2K download was canceled by the browser');
      }
      if (!completed) {
        await takeScreenshot(page, '2k-download-timeout');
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Timed out waiting for the 2K upscaled download to complete');
      }

      const editRouteId2k = page.url().split('/edit/')[1]?.split(/[/?#]/)[0] || 'download';
      const title2k = args.filename ? null : await getGenerationTitle(page);
      const titledName2k = title2k ? `${titleToFilenameBase(title2k, editRouteId2k.slice(0, 8))}${path.extname(completed.filePath)}` : null;
      const { fullPath } = resolveDownloadPath('image', {
        filename: args.filename,
        suggestedFilename: titledName2k || path.basename(completed.filePath),
        model: 'download-2k',
        jobId: `upscaled_2k_${Date.now()}`,
      });
      // renameSync throws EXDEV across filesystems (scratchDir is /tmp,
      // typically a different mount than the project's outputs/ dir).
      fs.copyFileSync(completed.filePath, fullPath);
      fs.unlinkSync(completed.filePath);
      const stat = fs.statSync(fullPath);

      logger.info('2K upscaled file saved via CDP download to project outputs', { fullPath, size: stat.size });
      return {
        status: 'success',
        method: 'ui-upscale-2k',
        resolution: '2K',
        filePath: fullPath,
        size: stat.size,
        hint: REPORT_AND_OFFER_TO_OPEN_HINT,
      };
    } catch (err) {
      if (err instanceof FlowError) throw err;
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `2K download failed: ${err.message}`);
    }
  }

  // Default: 1K direct-API path (completely untouched)
  logger.info('Attempting to download latest result (1K direct API)');
  try {
    // The /edit/{id} URL's id is the edit-route id, NOT the img's own
    // fetchable media id — confirmed live these are different id namespaces
    // even on the exact same tile/page. Fetching media.getMediaUrlRedirect
    // with the edit-route id silently fails. Always resolve the media id from
    // the actual <img> on the page, never from the URL — unless the caller
    // gave one explicitly (recovering a specific superseded history step;
    // confirmed live this endpoint still resolves those, see flow_generation_history).
    const mediaId = args.media_id || await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const src = img.src || '';
        const m = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (m && img.width > 100) return m[1];
      }
      return null;
    }).catch(() => null);

    if (mediaId) {
      logger.info('Found mediaId for direct fetch', { mediaId });

      const downloadUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`;
      const response = await page.request.get(downloadUrl, { timeout: 15000 });

      if (response && response.ok()) {
        const buffer = await response.body();
        const contentType = response.headers()['content-type'] || '';
        const ext = contentType === 'image/png' ? 'png' : 'jpg';
        const title1k = args.filename ? null : await getGenerationTitle(page);
        const titledName1k = title1k ? `${titleToFilenameBase(title1k, mediaId.substring(0, 8))}.${ext}` : null;
        const { fullPath } = resolveDownloadPath('image', {
          filename: args.filename,
          suggestedFilename: titledName1k || `latest_${mediaId.substring(0, 8)}.${ext}`,
          model: 'download',
          jobId: `latest_${mediaId.substring(0, 8)}`,
        });
        fs.writeFileSync(fullPath, buffer);
        logger.info('Downloaded image directly via mediaId API', { path: fullPath, size: buffer.length });
        return {
          status: 'success',
          method: 'direct-api',
          resolution: '1K',
          mediaId,
          filePath: fullPath,
          size: buffer.length,
          hint: REPORT_AND_OFFER_TO_OPEN_HINT,
        };
      }
    }

    await takeScreenshot(page, 'no-media-id-found');
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
      'Could not find a fetchable media id in the page\'s images to download at 1K.');
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed: ${err.message}`);
  }
}
