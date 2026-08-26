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
import { waitForNewMedia, getVisibleMediaIds, waitForStableTileIds, verifyNewestTileIds } from '../browser/gallery.js';
import { recordGeneration, recordDownload } from '../utils/media-index.js';
import fs from 'fs';
import path from 'path';

const IMAGE_MODEL_MAP = {
  'Nano Banana Pro': 'nano_banana_pro',
  'Nano Banana 2': 'narwhal_display',
  'Nano Banana 2 Lite': 'harbor_seal',
};

const IMAGE_RATIO_MAP = {
  '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE',
  '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
  '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR',
  '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
};

function selectModel(requested) {
  if (!requested || requested === 'auto') {
    return 'Nano Banana 2';
  }
  if (IMAGE_MODEL_MAP[requested]) return requested;
  return null;
}

function selectRatio(requested) {
  if (!requested) return '16:9';
  if (IMAGE_RATIO_MAP[requested]) return requested;
  return null;
}

let lastAppliedImageSettings = null;

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
      await page.goto(projectRootUrl, { waitUntil: 'networkidle', timeout: 30000 });
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
    const settingsChanged = !lastAppliedImageSettings ||
      lastAppliedImageSettings.model !== model ||
      lastAppliedImageSettings.ratio !== ratio ||
      lastAppliedImageSettings.quantity !== quantity;

    if (settingsChanged) {
      logger.info('Applying image settings via Agent Settings UI panel', { model, ratio, quantity });
      const applied = await applySettings(page, { model, ratio, quantity });
      lastAppliedImageSettings = {
        model: applied.model || model,
        ratio: applied.ratio || ratio,
        quantity: applied.quantity || quantity,
      };
      logger.info('Agent settings updated via UI', lastAppliedImageSettings);
    }

    // STEP 4: Verify the model selector confirms IMAGE mode (NOT video)
    // Flow's bottom toolbar is always present in a project with a model selector.
    // No "Image/Video" mode tabs exist — the generation mode is determined by
    // which model is selected (e.g. "Nano Banana 2" = image, "Omni Flash" = video).
    const modelFromUI = await page.evaluate(() => {
      const modelBtn = Array.from(document.querySelectorAll('button'))
        .find(b => {
          const text = b.textContent || '';
          return (text.includes('Nano') || text.includes('Banana') ||
                  text.includes('Omni') || text.includes('Veo') ||
                  text.includes('Imagen')) && b.offsetParent !== null;
        });
      return modelBtn ? modelBtn.textContent.trim().replace(/\s+/g, ' ').substring(0, 80) : null;
    }).catch(() => null);

    if (modelFromUI) {
      logger.info('Model selector shows:', { modelFromUI });
      const videoModelNames = ['Omni Flash', 'Veo', 'Omni'];
      const isVideoModel = videoModelNames.some(v => modelFromUI.includes(v));
      if (isVideoModel) {
        await takeScreenshot(page, 'video-model-detected');
        throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
          `SAFETY BLOCK: the UI model "${modelFromUI}" is a VIDEO model. ` +
          `Refusing to generate to avoid spending paid video credits. ` +
          `Use flow_generate_video for videos.`);
      }
      logger.info('✅ Model selector confirms image mode');
    } else {
      logger.warn('Could not read model selector — assuming image mode from config');
    }

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

    // ⚠️ STEP 7: DECISION POINT — auto_confirm determines if we click Generate
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

    // 🛡️ SAFETY: Pre-generation screenshot verification
    logger.info('⚠️ auto_confirm=true — vérifications de sécurité avant clic Generate');
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

    // Baseline: the gallery already contains images from prior generations. Without this,
    // the post-generate poll below would match those historic images on its very first
    // check (before the new ones have even started rendering) and treat generation as
    // instantly "done".
    const baselineImageUuids = await getVisibleMediaIds(page);

    // STEP 10: Click generate — CREDITS WILL BE SPENT
    logger.info('Clicking Generate — credits will be spent');
    await generateBtnLocator.click();

    // STEP 11: Handle two possible generation flows:
    //   A) Agent-mediated: Agent asks "Accepter?" before generating (when switching modes)
    //   B) Direct: generation starts immediately (most common)
    // Try Agent first (short wait), fall through to direct if not detected

    let flowMode = 'direct';
    logger.info('Checking for Agent confirmation dialog (5s window)...');
    const acceptTimeoutMs = get('agentResponseTimeoutMs', 5000);
    const acceptStart = Date.now();

    while (Date.now() - acceptStart < acceptTimeoutMs) {
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (pageText.includes('Accepter') || pageText.includes('Approve')) {
        logger.info('Agent confirmation dialog detected — switching to Agent flow');
        const acceptBtn = page.locator('button').filter({ hasText: /Accepter|Approve/ }).first();
        await acceptBtn.click();
        logger.info('Generation confirmed via Agent');
        flowMode = 'agent';
        break;
      }
      await page.waitForTimeout(500);
    }

    logger.info('Generation flow', { mode: flowMode });

    // STEP 12: Wait for images to appear in the DOM (shared poll — see gallery.js)
    logger.info('Waiting for generated images...');
    const generatedImageUuids = await waitForNewMedia(page, baselineImageUuids, {
      timeoutMs: get('generationTimeoutMs', 120000),
    });

    if (generatedImageUuids.length === 0) {
      await takeScreenshot(page, 'no-images-detected');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Generation completed but no images were detected in the DOM. ' +
        'Check the Flow project content library.');
    }

    // Confirmed live: the same ratio param, same model, same project can silently come
    // out at the wrong aspect ratio on one call and not another — the API response even
    // echoes back the REQUESTED ratio regardless of what actually rendered, so trusting
    // it is not an option. Check the actual rendered pixel dimensions instead (same
    // signal followUpEdit's ratio-drift retry already relies on for the edit path).
    const actualDims = await page.evaluate((uuids) => {
      const out = {};
      const imgs = Array.from(document.querySelectorAll('img'));
      for (const uuid of uuids) {
        const img = imgs.find(i => (i.src || '').includes(`name=${uuid}`) && i.naturalWidth > 0);
        if (img) out[uuid] = { width: img.naturalWidth, height: img.naturalHeight };
      }
      return out;
    }, generatedImageUuids).catch(() => ({}));

    const [reqW, reqH] = ratio.split(':').map(Number);
    const requestedAspect = reqW && reqH ? reqW / reqH : null;
    const ratioMismatches = [];
    if (requestedAspect) {
      for (const [uuid, dims] of Object.entries(actualDims)) {
        const actualAspect = dims.width / dims.height;
        if (Math.abs(actualAspect - requestedAspect) / requestedAspect > 0.03) {
          ratioMismatches.push({ uuid, requested: ratio, actual: `${dims.width}x${dims.height}` });
        }
      }
    }
    if (ratioMismatches.length > 0) {
      logger.warn('Generated image(s) do not match the requested aspect ratio', { ratioMismatches });
    }

    // STEP 13: Download generated images via authenticated session (using APIRequestContext to avoid page navigation)
    // Note: 2K/4K upscaled downloads require UI interaction and reCAPTCHA, out of scope for direct API.
    logger.info('Downloading generated images', { count: generatedImageUuids.length });
    const downloadedFiles = [];
    const downloadedByUuid = new Map();

    for (const uuid of generatedImageUuids) {
      try {
        const response = await page.request.get(
          `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${uuid}`,
          { timeout: 15000 }
        );

        if (response && response.ok()) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.startsWith('image/')) {
            const buffer = await response.body();
            const ext = contentType === 'image/png' ? '.png' : '.jpg';
            const destPath = path.join(outputDir, `flow_${uuid.substring(0, 8)}_${job.id}${ext}`);
            fs.writeFileSync(destPath, buffer);
            downloadedFiles.push(destPath);
            downloadedByUuid.set(uuid, destPath);
            logger.info('Image downloaded', { uuid, size: buffer.length, path: destPath });
          }
        }
      } catch (err) {
        logger.warn('Failed to download image', { uuid, error: err.message });
      }
    }

    if (downloadedFiles.length === 0) {
      await takeScreenshot(page, 'download-failed');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Failed to download any generated images via the authenticated session');
    }

    // The img-src id used above for direct download is NOT the same id as the
    // gallery tile's /edit/{id} route (confirmed live) — map to the edit-route
    // ids too so callers can jump straight to flow_open_generation/list backfill.
    const mediaIdToTileId = await waitForStableTileIds(page, generatedImageUuids).catch(() => ({}));
    const editIds = Object.values(mediaIdToTileId);
    const projectIdForUrls = page.url().split('/project/')[1]?.split(/[/?#]/)[0];
    const editUrls = editIds.map(id => `https://labs.google/fx/en/tools/flow/project/${projectIdForUrls}/edit/${id}`);

    // Seed the index now. No title yet — reading one would mean navigating to
    // each /edit/ page, which we are not on; a later download or open backfills
    // it without erasing what we do know. The uuid here IS the step's media id
    // and the prompt is right in scope, so this is the one place the
    // prompt-to-media link can be recorded for free.
    for (const [uuid, editId] of Object.entries(mediaIdToTileId)) {
      recordGeneration({
        editId,
        model,
        ratio,
      });
      const filePath = downloadedByUuid.get(uuid);
      if (filePath) {
        recordDownload({ editId, mediaId: uuid, path: filePath, resolution: '1K', method: 'generate-autosave' });
      }
    }

    // Confirmed live: waitForNewMedia's "wasn't in the baseline" signal can misfire
    // against the virtualized gallery grid, returning real editIds for OLD, unrelated
    // generations instead of the tile this call actually created — see gallery.js's
    // verifyNewestTileIds for the mechanism. If NONE of the returned editIds trace back
    // to the newest gallery entries, this result is a known failure mode, not a
    // borderline case — fail loud instead of shipping wrong files under the right prompt.
    let idVerification = null;
    if (editIds.length > 0) {
      idVerification = await verifyNewestTileIds(page, editIds).catch(() => null);
      if (idVerification && !idVerification.allVerified && idVerification.verifiedIds.length === 0) {
        await takeScreenshot(page, 'editid-mismatch');
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
          'Generation returned editIds that do not correspond to any of the newest gallery entries — ' +
          'the downloaded files are very likely OLD, unrelated generations misattributed to this call, ' +
          'not the images this prompt just produced. Do not trust or use downloadedFiles/editIds from ' +
          'this result. Retry the call, or use flow_list_generations to find the real newest entry.',
          { requestedPrompt: args.prompt, unverifiedEditIds: idVerification.unverifiedIds, downloadedFiles });
      }
      if (idVerification && !idVerification.allVerified) {
        logger.warn('Some returned editIds did not verify against the newest gallery entries', {
          verifiedIds: idVerification.verifiedIds,
          unverifiedIds: idVerification.unverifiedIds,
        });
      }
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
