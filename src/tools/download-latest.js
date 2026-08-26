import { getPage, getLaunchMode } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { resolveDownloadPath } from '../utils/file-manager.js';
import { navigateToGeneration, listGenerations, getMainPreviewMediaId, readUpscaleToast } from '../browser/gallery.js';
import { recordDownload, loadProjectCache, saveProjectCache } from '../utils/media-index.js';
import { fetchProjectContents, upsampleImage, mediaDownloadUrl } from '../browser/flow-api.js';
import { getMostRecentProject } from '../navigation/project-navigator.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Always surfaced on a successful download so the calling agent can't skip
// it: report the exact path to the human, then ask (don't just do it)
// whether to open it with their OS default viewer (e.g. `xdg-open` on
// Linux, `open` on macOS).
const REPORT_AND_OFFER_TO_OPEN_HINT =
  'Report this exact filePath to the user, then ask if they want it opened now with their OS default image viewer — do not open it without asking.';

// Build a filename base from the generation's own title plus a short id
// suffix (still unique across re-downloads/edits of the same title) — sanitized
// to filesystem-safe characters. Returns null if there's no usable title, so
// callers fall back to their existing opaque-id naming.
function titleToFilenameBase(title, shortId) {
  const cleaned = (title || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
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

  // Optional explicit target generation — navigate there first
  if (args?.id) {
    await navigateToGeneration(page, { id: args.id });
  }

  if (resolution === '2K') {
    // Resolve target editId and projectId
    let editId = args?.id || null;
    if (!editId && /\/edit\//.test(page.url())) {
      editId = page.url().split('/edit/')[1]?.split(/[/?#]/)[0] || null;
    }
    if (!editId) {
      const [latest] = await listGenerations(page, { limit: 1 });
      if (latest?.id) {
        editId = latest.id;
        await navigateToGeneration(page, { id: editId });
      }
    }

    const projectId =
      page.url().split('/project/')[1]?.split(/[/?#]/)[0] ||
      args?.project_id ||
      getMostRecentProject()?.id;

    let cache = projectId ? loadProjectCache(projectId) : null;
    if (!cache && projectId && page) {
      try {
        cache = await fetchProjectContents(page, projectId);
        saveProjectCache(cache);
      } catch {
        /* proceed if project fetch fails */
      }
    }

    const gen = (cache?.generations || []).find((g) => g.editId === editId);
    const title2k = gen?.title || null;
    const titledName2k = title2k
      ? `${titleToFilenameBase(title2k, (editId || '2k').slice(0, 8))}.png`
      : null;

    // -------------------------------------------------------------------------
    // Step 1: Cache already lists an upscale medium for this generation -> direct GET
    // -------------------------------------------------------------------------
    const existingUpscale = (cache?.media || []).find((m) => m.editId === editId && m.derived);
    if (existingUpscale?.mediaId) {
      logger.info('Found existing 2K upscale in cache, attempting direct GET', {
        editId,
        mediaId: existingUpscale.mediaId,
      });
      try {
        const downloadUrl = mediaDownloadUrl(existingUpscale.mediaId);
        const response = await page.request.get(downloadUrl, { timeout: 30000 });
        if (response && response.ok()) {
          const buffer = await response.body();
          const contentType = response.headers()['content-type'] || '';
          const ext = contentType === 'image/png' ? 'png' : 'jpg';
          const { fullPath } = resolveDownloadPath('image', {
            filename: args.filename,
            suggestedFilename:
              (title2k ? `${titleToFilenameBase(title2k, (editId || '2k').slice(0, 8))}.${ext}` : null) ||
              `upscaled_2k_${(editId || existingUpscale.mediaId).slice(0, 8)}.${ext}`,
            model: 'download-2k',
            jobId: `upscaled_2k_${Date.now()}`,
          });
          fs.writeFileSync(fullPath, buffer);
          const stat = fs.statSync(fullPath);

          recordDownload({
            editId: editId || existingUpscale.mediaId,
            mediaId: existingUpscale.mediaId,
            path: fullPath,
            resolution: '2K',
            bytes: stat.size,
            method: 'cached-api-2k',
          });

          logger.info('Downloaded existing 2K upscale directly via API', {
            fullPath,
            size: stat.size,
          });
          return {
            status: 'success',
            method: 'cached-api-2k',
            resolution: '2K',
            filePath: fullPath,
            size: stat.size,
            hint: REPORT_AND_OFFER_TO_OPEN_HINT,
          };
        }
      } catch (err) {
        logger.warn('Direct fetch of cached 2K upscale failed, falling forward', {
          error: err.message,
        });
      }
    }

    // -------------------------------------------------------------------------
    // Step 2: None yet -> call upsampleImage() via Flow backend, then GET id
    // -------------------------------------------------------------------------
    let targetMediaId = args.media_id || gen?.primaryMediaId || null;
    if (!targetMediaId && cache?.media) {
      const nonDerived = cache.media.filter((m) => m.editId === editId && !m.derived);
      if (nonDerived.length) targetMediaId = nonDerived[nonDerived.length - 1].mediaId;
    }
    if (!targetMediaId && /\/edit\//.test(page.url())) {
      targetMediaId = await getMainPreviewMediaId(page).catch(() => null);
    }

    if (targetMediaId && projectId) {
      logger.info('Attempting 2K upscale via Flow API', {
        editId,
        mediaId: targetMediaId,
        projectId,
      });
      try {
        const upscaled = await upsampleImage(page, {
          mediaId: targetMediaId,
          projectId,
          resolution: '2K',
          paygateTier: cache?.paygateTier,
        });

        const downloadUrl = mediaDownloadUrl(upscaled.mediaId);
        const response = await page.request.get(downloadUrl, { timeout: 30000 });
        if (response && response.ok()) {
          const buffer = await response.body();
          const contentType = response.headers()['content-type'] || '';
          const ext = contentType === 'image/png' ? 'png' : 'jpg';
          const { fullPath } = resolveDownloadPath('image', {
            filename: args.filename,
            suggestedFilename:
              (title2k ? `${titleToFilenameBase(title2k, (editId || '2k').slice(0, 8))}.${ext}` : null) ||
              `upscaled_2k_${(editId || upscaled.mediaId).slice(0, 8)}.${ext}`,
            model: 'download-2k',
            jobId: `upscaled_2k_${Date.now()}`,
          });
          fs.writeFileSync(fullPath, buffer);
          const stat = fs.statSync(fullPath);

          recordDownload({
            editId: editId || upscaled.mediaId,
            mediaId: upscaled.mediaId,
            path: fullPath,
            resolution: '2K',
            bytes: stat.size,
            method: 'api-upscale-2k',
          });

          // Refresh the cache asynchronously so subsequent index queries see the new upscale
          fetchProjectContents(page, projectId)
            .then((fresh) => saveProjectCache(fresh))
            .catch(() => {});

          logger.info('2K upscale completed via API and saved', { fullPath, size: stat.size });
          return {
            status: 'success',
            method: 'api-upscale-2k',
            resolution: '2K',
            filePath: fullPath,
            size: stat.size,
            hint: REPORT_AND_OFFER_TO_OPEN_HINT,
          };
        }
      } catch (err) {
        logger.warn('Direct API upscale failed, falling back to UI upscale flow', {
          error: err.message,
        });
      }
    }

    // -------------------------------------------------------------------------
    // Step 3: UI Fallback Flow (today's UI path unchanged)
    // -------------------------------------------------------------------------
    const launchMode = getLaunchMode();
    if (launchMode?.headless && args.force !== true) {
      throw new FlowError(
        ErrorCodes.NOT_SUPPORTED,
        '2K upscale UI flow does not work in headless Chrome — Flow answers "Upscaling Failed!" (reproduced 5/5). ' +
          'Reconnect headed with flow_connect{headless:false}, or {virtual_display:true} to keep it off your screen, ' +
          'then retry. 1K downloads are unaffected. Pass force:true to attempt anyway.'
      );
    }

    logger.info('Attempting 2K upscaled UI download (fallback path)');
    try {
      if (!/\/edit\//.test(page.url())) {
        const [latest] = await listGenerations(page, { limit: 1 });
        if (!latest) {
          throw new FlowError(
            ErrorCodes.DOWNLOAD_FAILED,
            'Could not find a gallery tile link to the latest generation.'
          );
        }
        await navigateToGeneration(page, { id: latest.id });
      }

      const downloadBtnLocator = page
        .locator('button:has-text("Download"), [aria-label*="download" i]')
        .first();
      let downloadBtnVisible = false;
      const btnDeadline = Date.now() + 5000;
      while (!downloadBtnVisible && Date.now() < btnDeadline) {
        downloadBtnVisible = await downloadBtnLocator.isVisible().catch(() => false);
        if (!downloadBtnVisible) await page.waitForTimeout(300);
      }
      if (!downloadBtnVisible) {
        await takeScreenshot(page, '2k-download-btn-not-found');
        throw new FlowError(
          ErrorCodes.DOWNLOAD_FAILED,
          'Download button not visible on page for 2K upscale'
        );
      }

      await downloadBtnLocator.click();
      await page.waitForTimeout(500);

      const menu2kOption = page
        .locator('button, [role="menuitem"], [role="option"]')
        .filter({ hasText: /2K/ })
        .first();
      const menu2kVisible = await menu2kOption.isVisible().catch(() => false);
      if (!menu2kVisible) {
        await takeScreenshot(page, '2k-option-not-found');
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, '"2K / Upscaled" menu option not found');
      }

      const scratchDir = path.join(os.tmpdir(), 'flow-mcp-2k-downloads');
      fs.mkdirSync(scratchDir, { recursive: true });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: scratchDir,
        eventsEnabled: true,
      });

      let completed = null;
      let canceled = false;
      cdp.on('Browser.downloadProgress', (e) => {
        if (e.state === 'completed') completed = e;
        else if (e.state === 'canceled') canceled = true;
      });

      const mediaId2k = await getMainPreviewMediaId(page);

      await menu2kOption.click();
      logger.info('Clicked 2K upscale download option, waiting for CDP download-completed event');

      const deadline = Date.now() + 60000;
      let toast = null;
      while (!completed && !canceled && Date.now() < deadline) {
        await page.waitForTimeout(300);
        toast = await readUpscaleToast(page);
        if (toast?.state === 'failed') break;
      }
      if (canceled) {
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, '2K download was canceled by the browser');
      }
      if (!completed && toast?.state === 'failed') {
        await takeScreenshot(page, '2k-upscale-failed');
        throw new FlowError(
          ErrorCodes.UPSCALE_FAILED,
          `Flow refused the 2K upscale: "${toast.text}". The generation itself is fine and still downloadable at 1K. ` +
            (getLaunchMode()?.headless
              ? 'This browser is headless, which is the known cause — reconnect with flow_connect{headless:false}.'
              : 'Retry; if it keeps failing, the 1K original is unaffected.')
        );
      }
      if (!completed) {
        await takeScreenshot(page, '2k-download-timeout');
        throw new FlowError(
          ErrorCodes.DOWNLOAD_FAILED,
          'Timed out waiting for the 2K upscaled download to complete'
        );
      }

      const editRouteId2k = page.url().split('/edit/')[1]?.split(/[/?#]/)[0] || 'download';
      const { fullPath } = resolveDownloadPath('image', {
        filename: args.filename,
        suggestedFilename:
          titledName2k ||
          `${titleToFilenameBase(null, editRouteId2k.slice(0, 8)) || path.basename(completed.filePath)}`,
        model: 'download-2k',
        jobId: `upscaled_2k_${Date.now()}`,
      });

      fs.copyFileSync(completed.filePath, fullPath);
      fs.unlinkSync(completed.filePath);
      const stat = fs.statSync(fullPath);

      recordDownload({
        editId: editRouteId2k,
        mediaId: mediaId2k,
        path: fullPath,
        resolution: '2K',
        bytes: stat.size,
        method: 'ui-upscale-2k',
      });

      logger.info('2K upscaled file saved via CDP download to project outputs', {
        fullPath,
        size: stat.size,
      });
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

  // Default: 1K direct-API path
  logger.info('Attempting to download latest result (1K direct API)');
  try {
    const editRouteId1k = page.url().split('/edit/')[1]?.split(/[/?#]/)[0] || null;
    const projectId =
      page.url().split('/project/')[1]?.split(/[/?#]/)[0] ||
      args?.project_id ||
      getMostRecentProject()?.id;

    const cache = projectId ? loadProjectCache(projectId) : null;
    const gen = editRouteId1k ? (cache?.generations || []).find((g) => g.editId === editRouteId1k) : null;
    const title1k = gen?.title || null;

    const mediaId =
      args.media_id ||
      (await page
        .evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img'));
          for (const img of imgs) {
            const src = img.src || '';
            const m = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
            if (m && img.width > 100) return m[1];
          }
          return null;
        })
        .catch(() => null));

    if (mediaId) {
      logger.info('Found mediaId for direct fetch', { mediaId });

      const downloadUrl = mediaDownloadUrl(mediaId);
      const response = await page.request.get(downloadUrl, { timeout: 15000 });

      if (response && response.ok()) {
        const buffer = await response.body();
        const contentType = response.headers()['content-type'] || '';
        const ext = contentType === 'image/png' ? 'png' : 'jpg';
        const titledName1k = title1k
          ? `${titleToFilenameBase(title1k, mediaId.substring(0, 8))}.${ext}`
          : null;
        const { fullPath } = resolveDownloadPath('image', {
          filename: args.filename,
          suggestedFilename: titledName1k || `latest_${mediaId.substring(0, 8)}.${ext}`,
          model: 'download',
          jobId: `latest_${mediaId.substring(0, 8)}`,
        });
        fs.writeFileSync(fullPath, buffer);

        const effectiveEditId = editRouteId1k || mediaId;
        recordDownload({
          editId: effectiveEditId,
          mediaId,
          path: fullPath,
          resolution: '1K',
          bytes: buffer.length,
          method: 'direct-api',
        });

        logger.info('Downloaded image directly via mediaId API', {
          path: fullPath,
          size: buffer.length,
        });
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
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      "Could not find a fetchable media id in the page's images to download at 1K."
    );
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed: ${err.message}`);
  }
}
