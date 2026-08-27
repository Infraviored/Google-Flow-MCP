import { getPage } from '../browser/connect.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { navigateToGeneration, followUpEdit } from '../browser/gallery.js';
import { getPromptInput, fillPrompt } from '../browser/composer.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { resolveTextParam } from '../utils/file-manager.js';
import { logger } from '../utils/logger.js';
import { generateImages, resolveImageModelKey, fetchProjectContents } from '../browser/flow-api.js';
import { loadProjectCache, saveProjectCache } from '../utils/media-index.js';
import { recoverFromCrash } from '../browser/launch-profile.js';

// The API wants a ratio name; the cache only knows pixel dimensions. Snap to the
// nearest supported ratio rather than sending UNSPECIFIED, which lets the edit
// come back reshaped.
function nearestRatio(w, h) {
  if (!w || !h) return null;
  const a = w / h;
  const options = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4]];
  return options.reduce((best, o) => (Math.abs(o[1] - a) < Math.abs(best[1] - a) ? o : best))[0];
}

export async function handleEditGeneration(args = {}) {
  args.instruction = resolveTextParam(args.instruction, args.instruction_file, { paramName: 'instruction', fileParamName: 'instruction_file' });

  const page = getPage();

  if (args.project_id || args.project_name || args.campaign) {
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });
  }

  if (args.id || args.url) {
    await navigateToGeneration(page, { id: args.id, url: args.url });
  } else if (!/\/edit\//.test(page.url())) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      'Not on a generation\'s /edit/ page and no id/url given — call with an id (from flow_list_generations) ' +
      'or flow_open_generation first.');
  }

  const autoConfirm = args.auto_confirm === true;

  if (!autoConfirm) {
    // SAFE MODE: fill the instruction only, don't click Create — no credits spent.
    const promptInput = await getPromptInput(page);
    if (!promptInput) {
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find the follow-up edit composer on the edit page.');
    }
    await fillPrompt(page, promptInput, args.instruction);
    return {
      status: 'ready_for_confirmation',
      editUrl: page.url(),
      instruction: args.instruction,
      message: 'Instruction is set in the edit composer. No credits spent. ' +
        'To apply and spend credits, call again with auto_confirm=true.',
      screenshot: await takeScreenshot(page, 'edit-generation-ready-for-confirmation'),
    };
  }

  // Flow's own endpoint takes an edit as a generation that names the workflow it
  // belongs to and the image it starts from. It returns the new media id
  // directly, so none of the DOM tile-matching applies, and it lets us send the
  // real aspect ratio — the composer sends UNSPECIFIED, which is the likeliest
  // reason edits used to come back reshaped and needed a retry.
  let newMediaIds = null;
  const editIdNow = page.url().split('/edit/')[1]?.split(/[/?#]/)[0] || null;
  const projectIdNow = page.url().split('/project/')[1]?.split(/[/?#]/)[0] || null;

  if (editIdNow && projectIdNow) {
    try {
      let cache = loadProjectCache(projectIdNow);
      if (!cache) { cache = await fetchProjectContents(page, projectIdNow); saveProjectCache(cache); }

      // Edit the medium the generation currently shows, not an older step.
      const gen = (cache.generations || []).find(g => g.editId === editIdNow);
      const baseMediaId = gen?.primaryMediaId
        || (cache.media || []).filter(m => m.editId === editIdNow && !m.derived).slice(-1)[0]?.mediaId;
      const baseMedia = (cache.media || []).find(m => m.mediaId === baseMediaId);
      const ratio = baseMedia?.dimensions
        ? nearestRatio(baseMedia.dimensions.width, baseMedia.dimensions.height)
        : null;

      if (baseMediaId) {
        const media = await generateImages(page, {
          projectId: projectIdNow,
          workflowId: editIdNow,
          baseMediaId,
          prompt: args.instruction,
          modelKey: resolveImageModelKey(cache, args.model || 'Nano Banana Pro'),
          ratio,
        });
        newMediaIds = media.map(m => m.mediaId);

        // Same fetch()-from-page-context gap as the generate path: this edit
        // just changed the generation on Flow's servers without the browser's
        // own DOM/React state knowing. The page is already sitting on this
        // exact /edit/ URL, so a reload (not a navigation elsewhere) is what
        // brings it in sync. Best-effort — a failed reload must not fail an
        // edit that already succeeded and is already downloadable.
        try {
          await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(1000);
          await recoverFromCrash(page);
        } catch (reloadErr) {
          logger.warn('Could not reload the live page after the API edit (non-fatal)', { error: reloadErr.message });
        }
      }
    } catch (err) {
      logger.warn('API edit failed, falling back to the composer', { error: err.message });
    }
  }

  if (!newMediaIds) {
    newMediaIds = await followUpEdit(page, args.instruction, {
      timeoutMs: get('generationTimeoutMs', 120000),
    });
  }

  return {
    status: 'success',
    editUrl: page.url(),
    instruction: args.instruction,
    new_media_ids: newMediaIds,
    credits_consumed: true,
  };
}
