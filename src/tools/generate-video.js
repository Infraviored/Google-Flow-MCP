import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { prepareDownload, findNewFiles, saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { get } from '../utils/config.js';
import { getActiveExpectedAccount } from '../browser/launch-profile.js';
import { applySettings, closeSidebar, ensureAgentOff } from '../browser/agent-settings.js';
import { getPromptInput, fillPrompt } from '../browser/composer.js';
import fs from 'fs';
import path from 'path';

const VIDEO_MODEL_MAP = {
  'Omni 1.1 Flash': 'abra',
  'Veo 3.1 - Quality': 'veo_3_1_quality',
  'Veo 3.1 - Fast': 'veo_3_1_fast',
  'Veo 3.1 - Lite': 'veo_3_1_lite',
};

const VIDEO_RATIO_MAP = {
  '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
  '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
  '1:1': 'VIDEO_ASPECT_RATIO_SQUARE',
};

function selectVideoModel(requested) {
  const available = get('videoModels', {});
  if (!requested || requested === 'auto') {
    return 'Veo 3.1 - Fast';
  }
  if (requested === 'quality' || requested === 'premium') return 'Veo 3.1 - Quality';
  if (requested === 'fast' || requested === 'speed') return 'Veo 3.1 - Fast';
  if (requested === 'lite' || requested === 'test') return 'Veo 3.1 - Lite';
  if (requested === 'flash' || requested === 'simple') return 'Omni 1.1 Flash';
  if (available[requested]) return requested;
  return null;
}


export async function handleGenerateVideo(args) {
  const job = jobQueue.createJob('video_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
    duration: args.duration || null,
    quantity: args.quantity || 1,
    outputFolder: args.output_folder,
    useCharacter: args.use_character,
    useScene: args.use_scene,
    references: args.references,
    ingredients: args.ingredients,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // Ensure we're in a project context
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });

    // ensureProjectInContext only checks the project id in the URL, which still
    // matches on a generation's /edit/{id} page — that page's composer has no
    // Agent toggle at all, so ensureAgentOff below would fail outright. Navigate
    // back to the project root first (see the matching fix in generate-image.js).
    const preGenUrl = page.url();
    if (preGenUrl.includes('/edit/')) {
      const projectRootUrl = preGenUrl.split('/edit/')[0];
      logger.info('On a generation edit page — navigating back to project root for fresh composer', { from: preGenUrl, to: projectRootUrl });
      await page.goto(projectRootUrl, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(1500);
    }

    // Always generate from the plain bottom composer ("fresh" mode), never from an
    // open Agent-chat sidebar ("follow-up" mode) — see agent-settings.js.
    await closeSidebar(page);

    // Agent mode ON does not reliably honor the settings menu — force it OFF.
    await ensureAgentOff(page);

    // Select model
    const model = selectVideoModel(args.model);
    if (!model) {
      const available = Object.keys(get('videoModels', {}));
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Video model "${args.model}" not available. Available: ${available.join(', ')}`,
        { requested: args.model, available });
    }
    logger.info('Using video model', { model });

    const ratio = args.ratio || '16:9';
    const ratios = get('videoRatios', ['9:16', '16:9']);
    if (!ratios.includes(ratio)) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE, `Ratio ${ratio} not available for video. Available: ${ratios.join(', ')}`);
    }
    // Only Omni 1.1 Flash offers a duration; Veo models have a fixed length.
    const duration = args.duration ? `${parseInt(args.duration, 10)}s` : null;
    const quantity = Math.min(Math.max(args.quantity || 1, 1), 4);
    logger.info('Applying video settings', { model, ratio, duration, quantity });
    await applySettings(page, { model, ratio, quantity, duration, mode: 'video' });

    const qty = Math.min(Math.max(args.quantity || 1, 1), 4);

    // Find prompt input — shared composer (see composer.js)
    const promptInput = await getPromptInput(page);
    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input-video');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find prompt input for video');
    }

    await fillPrompt(page, promptInput, args.prompt);

    // Video generation is paid — setup only, no click
    logger.info('Video generation setup complete — not clicking generate (paid feature)');
    await takeScreenshot(page, 'video-ready-to-generate');

    saveMetadata(job.id, {
      type: 'video',
      model,
      ratio,
      duration,
      quantity: qty,
      prompt: args.prompt,
      status: 'ready_for_confirmation',
      note: 'Video generation is a paid feature. Manual confirmation required to proceed.',
    });

    jobQueue.completeJob(job.id, {
      status: 'ready_for_confirmation',
      type: 'video',
      account: getActiveExpectedAccount(),
      model_used: model,
      ratio,
      duration,
      quantity: qty,
      prompt: args.prompt,
      message: 'Video generation setup complete. Manual confirmation required (uses credits).',
      screenshot: await takeScreenshot(page, 'video-ready'),
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-video-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
