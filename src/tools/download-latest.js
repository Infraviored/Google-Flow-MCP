import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { resolveDownloadPath } from '../utils/file-manager.js';
import { navigateToGeneration, listGenerations } from '../browser/gallery.js';
import fs from 'fs';

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

      // Once Playwright is CDP-attached to a tab, it silently intercepts every
      // download in that tab (automated OR manual) into its own temp artifact
      // storage instead of letting Chrome write to the OS Downloads folder —
      // confirmed live (a manual click had the identical symptom; Playwright's
      // own download.path() pointed at /tmp/playwright-artifacts-.../, never
      // ~/Downloads). Polling ~/Downloads for a new file can never see it.
      // The correct way to get the file is Playwright's own download event.
      const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
      await menu2kOption.click();
      logger.info('Clicked 2K upscale download option, waiting for Playwright download event');

      const download = await downloadPromise.catch(() => null);
      if (!download) {
        await takeScreenshot(page, '2k-download-timeout');
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Timed out waiting for the 2K upscaled download to start');
      }

      const failure = await download.failure();
      if (failure) {
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `2K download failed: ${failure}`);
      }

      const { fullPath } = resolveDownloadPath('image', {
        filename: args.filename,
        suggestedFilename: download.suggestedFilename(),
        model: 'download-2k',
        jobId: `upscaled_2k_${Date.now()}`,
      });
      await download.saveAs(fullPath);
      const stat = fs.statSync(fullPath);

      logger.info('2K upscaled file moved to project outputs', { fullPath, size: stat.size });
      return {
        status: 'success',
        method: 'ui-upscale-2k',
        resolution: '2K',
        filePath: fullPath,
        size: stat.size,
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
    // the actual <img> on the page, never from the URL.
    const mediaId = await page.evaluate(() => {
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
        const { fullPath } = resolveDownloadPath('image', {
          filename: args.filename,
          suggestedFilename: `latest_${mediaId.substring(0, 8)}.${ext}`,
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
