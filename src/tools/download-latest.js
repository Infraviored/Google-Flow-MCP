import { getPage, getLaunchMode } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { resolveDownloadPath } from '../utils/file-manager.js';
import { navigateToGeneration, readUpscaleToast } from '../browser/gallery.js';
import { fetchProjectContents, projectIdFromUrl, getMediaUrl } from '../browser/flow-api.js';
import { humanClick } from '../browser/safe-actions.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { recordGeneration, recordDownload } from '../utils/media-index.js';
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

  if (args.project_id || args.project_name || args.campaign) {
    await ensureProjectInContext(page, { project_id: args.project_id, name: args.project_name, campaign: args.campaign });
  }

  // Which generation: explicit id > the /edit/ page on screen > the newest in
  // the project. Resolved through Flow's API — the DOM carries no ids.
  const projectId = projectIdFromUrl(page.url());
  if (!projectId) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Not inside a project — open one with flow_connect{project_id} or another tool first.');
  }
  const contents = await fetchProjectContents(page, projectId);
  const onScreenId = page.url().split('/edit/')[1]?.split(/[/?#]/)[0] || null;
  const newest = [...contents.generations].sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''))[0];
  const target = args.media_id
    ? contents.generations.find(g => g.editId === contents.media.find(m => m.mediaId === args.media_id)?.editId)
    : contents.generations.find(g => g.editId === (args.id || onScreenId)) || (!args.id ? newest : null);
  if (!target) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Generation ${args.id || args.media_id || ''} not found in project ${projectId}.`);
  }

  if (resolution === '2K') {
    // Reproduced 5/5 on three different generations: Flow's upscale returns
    // "Upscaling Failed!" under --headless=new and succeeds immediately once
    // reconnected headed. Failing here costs nothing; attempting it burns a
    // 60-second timeout per call and reports the wrong cause. force:true stays
    // available in case this turns out to be a server-side condition rather
    // than a permanent property of headless.
    const launchMode = getLaunchMode();
    if (launchMode?.headless && args.force !== true) {
      throw new FlowError(
        ErrorCodes.NOT_SUPPORTED,
        '2K upscale does not work in headless Chrome — Flow answers "Upscaling Failed!" (reproduced 5/5). ' +
        'Reconnect headed with flow_connect{headless:false}, or {virtual_display:true} to keep it off your screen, ' +
        'then retry. 1K downloads are unaffected. Pass force:true to attempt anyway.'
      );
    }
    logger.info('Attempting 2K upscaled UI download');
    try {
      // The Download button with the 1K/2K/4K menu only exists on a specific
      // generation's /edit/{mediaId} page, not on the gallery grid — navigate there
      // first if we're not already on one. Grid is newest-first (confirmed live),
      // so "latest" is the first tile from listGenerations.
      if (!page.url().includes(`/edit/${target.editId}`)) {
        await navigateToGeneration(page, { id: target.editId });
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

      await humanClick(page, downloadBtnLocator);
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

      // Capture the media id BEFORE the upscale runs. Afterwards the caller has
      // no way to say which history step this file belongs to, which is why 2K
      // downloads could never be attributed to a step in the index.
      const mediaId2k = target.primaryMediaId;

      await humanClick(page, menu2kOption);
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
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Timed out waiting for the 2K upscaled download to complete');
      }

      const editRouteId2k = page.url().split('/edit/')[1]?.split(/[/?#]/)[0] || 'download';
      // Always read the on-page title now — it's what feeds the session log's
      // clickable table, independent of whether the caller also gave an
      // explicit filename for the file on disk.
      const title2k = target.title;
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

      recordGeneration({ editId: editRouteId2k, editUrl: page.url(), title: title2k });
      recordDownload({ editId: editRouteId2k, mediaId: mediaId2k, path: fullPath,
                       resolution: '2K', bytes: stat.size, method: 'ui-upscale-2k' });

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

  // Default: 1K — the stored image itself, via a signed URL from Flow's API.
  const mediaId = args.media_id || target.primaryMediaId;
  logger.info('Downloading 1K via Flow API', { editId: target.editId, mediaId });
  try {
    const url = await getMediaUrl(page, mediaId);
    const response = await page.request.get(url, { timeout: 120000 });
    if (!response.ok()) {
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download of ${mediaId} failed: HTTP ${response.status()}`);
    }
    const buffer = await response.body();
    const contentType = response.headers()['content-type'] || '';
    const ext = contentType.includes('png') ? 'png' : contentType.startsWith('video/') ? 'mp4' : 'jpg';
    const titledName1k = target.title ? `${titleToFilenameBase(target.title, mediaId.substring(0, 8))}.${ext}` : null;
    const { fullPath } = resolveDownloadPath(ext === 'mp4' ? 'video' : 'image', {
      filename: args.filename,
      suggestedFilename: titledName1k || `latest_${mediaId.substring(0, 8)}.${ext}`,
      model: 'download',
      jobId: `latest_${mediaId.substring(0, 8)}`,
    });
    fs.writeFileSync(fullPath, buffer);

    const editUrl = `https://flow.google.com/project/${projectId}/edit/${target.editId}`;
    recordGeneration({ editId: target.editId, projectId, editUrl, title: target.title });
    recordDownload({ editId: target.editId, mediaId, path: fullPath, resolution: '1K', bytes: buffer.length, method: 'direct-api' });

    return {
      status: 'success',
      method: 'direct-api',
      resolution: '1K',
      id: target.editId,
      title: target.title,
      mediaId,
      filePath: fullPath,
      size: buffer.length,
      hint: REPORT_AND_OFFER_TO_OPEN_HINT,
    };
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed: ${err.message}`);
  }
}
