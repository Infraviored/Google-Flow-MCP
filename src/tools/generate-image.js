import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { prepareDownload, saveMetadata, resolveTextParam } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { get } from '../utils/config.js';
import { getActiveExpectedAccount } from '../browser/launch-profile.js';
import { applySettings, closeSidebar, ensureAgentOff } from '../browser/agent-settings.js';
import { getPromptInput, fillPrompt, getGenerateButton } from '../browser/composer.js';
import { humanClick } from '../browser/safe-actions.js';
import { projectIdFromUrl, mediaIdsOfProject, waitForNewProjectMedia, downloadMedia } from '../browser/flow-api.js';
import { recordGeneration, recordStep, recordDownload } from '../utils/media-index.js';
import fs from 'fs';
import path from 'path';

const IMAGE_MODEL_MAP = {
  'Nano Banana Pro': 'nano_banana_pro',
  'Nano Banana 2.1': 'beluga_display',
  'Nano Banana 2 Lite': 'harbor_seal',
};

// Flow replaced Nano Banana 2 with 2.1 (Oct 2026); keep the old name working.
const IMAGE_MODEL_ALIASES = { 'Nano Banana 2': 'Nano Banana 2.1' };

const IMAGE_RATIO_MAP = {
  '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE',
  '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
  '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR',
  '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
};

function selectModel(requested) {
  if (!requested || requested === 'auto') {
    return 'Nano Banana 2.1';
  }
  if (IMAGE_MODEL_ALIASES[requested]) return IMAGE_MODEL_ALIASES[requested];
  if (IMAGE_MODEL_MAP[requested]) return requested;
  return null;
}

function selectRatio(requested) {
  if (!requested) return '16:9';
  if (IMAGE_RATIO_MAP[requested]) return requested;
  return null;
}


export async function handleGenerateImage(args) {
  args.prompt = resolveTextParam(args.prompt, args.prompt_file, { paramName: 'prompt', fileParamName: 'prompt_file' });

  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('image_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
    auto_confirm: autoConfirm,
    quantity: args.quantity || 1,
    outputFolder: args.output_folder,
    useCharacter: args.use_character,
    useScene: args.use_scene,
    useTool: args.use_tool,
    references: args.references,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // STEP 1: Ensure we're in a project context
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });

    // STEP 1.4: ensureProjectInContext only checks the project id in the URL, which
    // still matches while sitting on a generation's /edit/{id} page (a prior
    // flow_edit_generation call, or a leftover download-triggered navigation, can
    // leave the browser there) — that page's composer has no Agent toggle at all,
    // so ensureAgentOff below would fail outright. Navigate back to the project
    // root first so "fresh composer mode" actually means fresh.
    const preGenUrl = page.url();
    if (preGenUrl.includes('/edit/')) {
      const projectRootUrl = preGenUrl.split('/edit/')[0];
      logger.info('On a generation edit page — navigating back to project root for fresh composer', { from: preGenUrl, to: projectRootUrl });
      await page.goto(projectRootUrl, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(1500);
    }

    // STEP 1.5: Always generate from the plain bottom composer ("fresh" mode), never
    // from an open Agent-chat sidebar ("follow-up" mode) — see agent-settings.js.
    await closeSidebar(page);

    // STEP 1.6: Agent mode ON routes generation through Flow's own conversational
    // copilot, which does NOT reliably honor the settings menu (confirmed live:
    // repeatedly generated 16:9 x2 regardless of panel state) — force it OFF.
    await ensureAgentOff(page);

    // STEP 2: Model selection (config-level, before UI interaction)
    const model = selectModel(args.model);
    if (!model) {
      const validModels = Object.keys(IMAGE_MODEL_MAP);
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Model "${args.model}" not available. Available image models: ${validModels.join(', ')}`,
        { requested: args.model, available: validModels });
    }
    logger.info('Using model', { model });

    // 🛡️ SAFETY: Verify model is an IMAGE model, NOT a video model
    const videoModels = get('videoModels', {});
    if (!IMAGE_MODEL_MAP[model]) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `SAFETY BLOCK: "${model}" is not a valid image model. ` +
        `Use flow_generate_video for videos. Image models: ${Object.keys(IMAGE_MODEL_MAP).join(', ')}`);
    }
    if (videoModels[model]) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `SAFETY BLOCK: "${model}" is also a VIDEO model. ` +
        `Refusing to generate to avoid spending video credits. Image models: ${Object.keys(IMAGE_MODEL_MAP).join(', ')}`);
    }

    // STEP 3: Ratio selection
    const ratio = selectRatio(args.ratio);
    if (!ratio) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE,
        `Ratio "${args.ratio}" not available. Available: ${Object.keys(IMAGE_RATIO_MAP).join(', ')}`);
    }

    // STEP 3.5: Apply model, ratio, and quantity via Agent Settings UI panel
    const quantity = Math.min(Math.max(args.quantity || 1, 1), 4);
    // Always apply: the settings popover is shared with video, and a cached
    // "already set" could leave it in Video mode — a paid video instead of an image.
    logger.info('Applying image settings', { model, ratio, quantity });
    await applySettings(page, { model, ratio, quantity, mode: 'image' });

    // STEP 4: Hard check that the composer is in image mode. The closed trigger
    // reads "🍌 <image model> …" in image mode and "Video · 720p · 8s …" in video
    // mode — anything but an image model name means: do not click.
    const triggerText = (await page.getByRole('button', { name: 'Settings trigger', exact: true })
      .innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!Object.keys(IMAGE_MODEL_MAP).some(m => triggerText.includes(m)) || /video/i.test(triggerText)) {
      await takeScreenshot(page, 'not-image-mode');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        `SAFETY BLOCK: composer is not in image mode (settings show "${triggerText}"). ` +
        'Refusing to generate to avoid spending video credits.');
    }
    logger.info('Composer confirmed in image mode', { triggerText });

    // Also verify the generate button exists (confirms the toolbar is active)
    const hasGenerateBtn = await page.locator(
      'button:has-text("arrow_forward"), button:has-text("Create"), button:has-text("Generate")'
    ).first().isVisible().catch(() => false);
    if (!hasGenerateBtn) {
      logger.warn('Generate button not visible on project page');
    }

    // STEP 5: Find the prompt input (shared composer — see composer.js)
    const promptInput = await getPromptInput(page);
    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find prompt input field inside the project. ' +
        'The Flow UI may have changed. Expected [contenteditable] or textarea.'
      );
    }
    logger.info('Found prompt input on page');

    // STEP 6: Fill the prompt
    await fillPrompt(page, promptInput, args.prompt);
    logger.info('Prompt filled', { promptLength: args.prompt.length });

    // STEP 7: DECISION POINT — auto_confirm determines if we click Generate
    if (!autoConfirm) {
      // SAFE MODE: Setup only, no click. Return "ready_for_confirmation".
      const setupScreenshot = await takeScreenshot(page, 'image-ready-for-confirmation');
      const result = {
        status: 'ready_for_confirmation',
        type: 'image',
        message: 'Prompt, model and ratio are set. No credits spent. ' +
          'To generate and spend credits, call again with auto_confirm=true.',
        model_used: model,
        ratio,
        prompt: args.prompt,
        account: getActiveExpectedAccount(),
        screenshot: setupScreenshot,
        jobId: job.id,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // SAFETY: Pre-generation screenshot verification
    logger.info('auto_confirm=true — safety checks before clicking Generate');
    const preGenScreenshot = await takeScreenshot(page, 'pre-generate-verification');

    // STEP 8: Find generate button (validated visible + enabled)
    const generateBtnLocator = getGenerateButton(page);
    const generateBtnVisible = await generateBtnLocator.isVisible().catch(() => false);
    if (!generateBtnVisible) {
      await takeScreenshot(page, 'no-generate-btn');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not found');
    }

    const isDisabled = await generateBtnLocator.isDisabled().catch(() => false);
    if (isDisabled) {
      await takeScreenshot(page, 'generate-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button is disabled');
    }

    // STEP 9: Prepare output directory
    const outputDir = args.output_folder || prepareDownload('image', model, job.id).dir;
    if (args.output_folder) {
      if (!fs.existsSync(args.output_folder)) {
        fs.mkdirSync(args.output_folder, { recursive: true });
      }
    }

    // Baseline from Flow's own project listing: the gallery DOM carries no ids
    // since flow.google.com, so "what is new" is decided against the API.
    const projectId = projectIdFromUrl(page.url());
    const baselineMedia = await mediaIdsOfProject(page, projectId);

    // STEP 10: Click generate — CREDITS WILL BE SPENT
    logger.info('Clicking Generate — credits will be spent');
    await humanClick(page, generateBtnLocator);

    // STEP 11: Wait for the new images to be listed by the project.
    logger.info('Waiting for generated images...');
    const fresh = await waitForNewProjectMedia(page, projectId, baselineMedia, {
      expected: quantity, kind: 'image', timeoutMs: get('generationTimeoutMs', 180000),
    });
    if (fresh.length === 0) {
      await takeScreenshot(page, 'no-images-detected');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'No new image appeared in the project after Generate. It may have been blocked by a safety filter; ' +
        'check the project in Flow.');
    }
    const generatedImageUuids = fresh.map(m => m.mediaId);

    // Flow can silently render a different aspect ratio than requested; the API
    // reports the real pixel size, so compare against that.
    const [reqW, reqH] = ratio.split(':').map(Number);
    const requestedAspect = reqW && reqH ? reqW / reqH : null;
    const ratioMismatches = [];
    for (const m of fresh) {
      if (!requestedAspect || !m.dimensions) continue;
      const actualAspect = m.dimensions.width / m.dimensions.height;
      if (Math.abs(actualAspect - requestedAspect) / requestedAspect > 0.03) {
        ratioMismatches.push({ uuid: m.mediaId, requested: ratio, actual: `${m.dimensions.width}x${m.dimensions.height}` });
      }
    }
    if (ratioMismatches.length > 0) {
      logger.warn('Generated image(s) do not match the requested aspect ratio', { ratioMismatches });
    }

    // STEP 12: Download each new image at its stored size via a signed URL.
    const downloadedFiles = [];
    for (const m of fresh) {
      try {
        const { path: filePath } = await downloadMedia(page, m.mediaId,
          path.join(outputDir, `flow_${m.mediaId.substring(0, 8)}_${job.id}`));
        downloadedFiles.push(filePath);
        m.file = filePath;
      } catch (err) {
        logger.warn('Failed to download image', { uuid: m.mediaId, error: err.message });
      }
    }
    if (downloadedFiles.length === 0) {
      await takeScreenshot(page, 'download-failed');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Generated images were listed but none could be downloaded.');
    }

    const editIds = [...new Set(fresh.map(m => m.editId))];
    const editUrls = editIds.map(id => `https://flow.google.com/project/${projectId}/edit/${id}`);
    for (const m of fresh) {
      recordGeneration({
        editId: m.editId,
        projectId,
        editUrl: `https://flow.google.com/project/${projectId}/edit/${m.editId}`,
        title: m.title,
        model,
        ratio,
      });
      recordStep({ editId: m.editId, mediaId: m.mediaId, prompt: args.prompt, source: 'generate' });
      if (m.file) recordDownload({ editId: m.editId, mediaId: m.mediaId, path: m.file, resolution: '1K', method: 'generate-autosave' });
    }

    saveMetadata(job.id, {
      type: 'image',
      model,
      ratio,
      auto_confirm: true,
      quantity: args.quantity || 1,
      prompt: args.prompt,
      files: downloadedFiles,
      jobId: job.id,
      imageUuids: generatedImageUuids,
      editIds,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'image',
      account: getActiveExpectedAccount(),
      model_used: model,
      ratio,
      prompt: args.prompt,
      files: downloadedFiles,
      image_count: downloadedFiles.length,
      imageUuids: generatedImageUuids,
      editIds,
      editUrls,
      credits_consumed: true,
      ...(ratioMismatches.length > 0 && {
        ratio_warning: `${ratioMismatches.length} of ${generatedImageUuids.length} generated image(s) did not ` +
          `come out at the requested ratio (${ratio}) — Flow silently rendered a different aspect ratio. ` +
          `See ratioMismatches for actual dimensions per image.`,
        ratioMismatches,
      }),
      hint: 'Report the files paths (1K, auto-saved here) to the user, then ask if they want any opened now with ' +
        'their OS default image viewer — do not open without asking. For 2K/4K, call flow_download_latest.',
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-image-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
