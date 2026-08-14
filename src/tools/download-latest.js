import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { prepareDownload } from '../utils/file-manager.js';
import fs from 'fs';
import path from 'path';

export async function handleDownloadLatest(args = {}) {
  const page = getPage();
  const resolution = (args?.resolution || '1K').toUpperCase();

  if (resolution === '4K') {
    throw new FlowError(
      ErrorCodes.NOT_SUPPORTED,
      '4K resolution download requires a paid plan upgrade and is not available via automation.'
    );
  }

  if (resolution === '2K') {
    logger.info('Attempting 2K upscaled UI download');
    try {
      // The Download button with the 1K/2K/4K menu only exists on a specific
      // generation's /edit/{mediaId} page, not on the gallery grid — navigate there
      // first if we're not already on one.
      if (!/\/edit\//.test(page.url())) {
        const projectId = page.url().split('/project/')[1]?.split(/[/?#]/)[0];
        const mediaId = await page.evaluate(() => {
          const img = document.querySelector('img[src*="getMediaUrlRedirect"]');
          const m = img && (img.src || '').match(/name=([a-f0-9-]+)/);
          return m ? m[1] : null;
        }).catch(() => null);

        if (!projectId || !mediaId) {
          throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
            'Could not determine which media to download — no /edit/ URL and no media found on the current page');
        }

        await page.goto(`https://labs.google/fx/en/tools/flow/project/${projectId}/edit/${mediaId}`,
          { waitUntil: 'networkidle', timeout: 30000 });
      }

      const downloadsDir = path.join(process.env.HOME || '/home/schneider', 'Downloads');
      const initialFiles = new Set(fs.existsSync(downloadsDir) ? fs.readdirSync(downloadsDir) : []);

      const downloadBtnLocator = page.locator('button:has-text("Download"), [aria-label*="download" i]').first();
      const downloadBtnVisible = await downloadBtnLocator.isVisible().catch(() => false);
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

      await menu2kOption.click();
      logger.info('Clicked 2K upscale download option, waiting for file in ~/Downloads');

      const timeoutMs = 20000;
      const start = Date.now();
      let downloadedFile = null;

      while (Date.now() - start < timeoutMs) {
        await page.waitForTimeout(500);
        if (!fs.existsSync(downloadsDir)) continue;

        const currentFiles = fs.readdirSync(downloadsDir);
        const newFiles = currentFiles.filter(f => !initialFiles.has(f) && !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
        if (newFiles.length > 0) {
          const candidateName = newFiles[0];
          const candidatePath = path.join(downloadsDir, candidateName);

          const size1 = fs.statSync(candidatePath).size;
          await page.waitForTimeout(500);
          const size2 = fs.statSync(candidatePath).size;

          if (size1 > 0 && size1 === size2) {
            downloadedFile = candidatePath;
            break;
          }
        }
      }

      if (!downloadedFile) {
        await takeScreenshot(page, '2k-download-timeout');
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Timed out waiting for 2K upscaled file to appear in ~/Downloads');
      }

      const { fullPath } = prepareDownload('image', 'download-2k', `upscaled_2k_${Date.now()}`);
      fs.renameSync(downloadedFile, fullPath);
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
    const mediaId = await page.evaluate(() => {
      const urlMatch = window.location.href.match(/\/edit\/([a-f0-9-]+)/i);
      if (urlMatch) return urlMatch[1];

      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const src = img.src || '';
        const m = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (m) return m[1];
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
        const ext = contentType === 'image/png' ? '.png' : '.jpg';
        const { fullPath } = prepareDownload('image', 'download', `latest_${mediaId.substring(0, 8)}`);
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

    logger.warn('No media ID found in DOM or URL, falling back to UI click');
    const downloadBtnLocator = page.locator('button:has-text("Download"), [aria-label*="download" i]').first();
    const downloadBtnVisible = await downloadBtnLocator.isVisible().catch(() => false);
    if (downloadBtnVisible) {
      await downloadBtnLocator.click();
      await page.waitForTimeout(3000);
      return { status: 'download_initiated', method: 'ui-click', resolution: '1K', message: 'Download button clicked' };
    }

    await takeScreenshot(page, 'download-btn-not-found');
    return { status: 'not_found', message: 'No media ID or download button found on current page' };
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed: ${err.message}`);
  }
}
