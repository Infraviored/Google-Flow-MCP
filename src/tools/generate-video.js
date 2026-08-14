import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { prepareDownload, findNewFiles, saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { get } from '../utils/config.js';
import { applySettings, closeSidebar } from '../browser/agent-settings.js';
import { getPromptInput, fillPrompt } from '../browser/composer.js';
import fs from 'fs';
import path from 'path';

const VIDEO_MODEL_MAP = {
  'Omni Flash': 'omni_flash',
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
  if (requested === 'flash' || requested === 'simple') return 'Omni Flash';
  if (available[requested]) return requested;
  return null;
}

let lastAppliedVideoSettings = null;

export async function handleGenerateVideo(args) {
  const job = jobQueue.createJob('video_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
    duration: args.duration || '4s',
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

    // Always generate from the plain bottom composer ("fresh" mode), never from an
    // open Agent-chat sidebar ("follow-up" mode) — see agent-settings.js.
    await closeSidebar(page);

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
    const quantity = Math.min(Math.max(args.quantity || 1, 1), 4);
    const settingsChanged = !lastAppliedVideoSettings ||
      lastAppliedVideoSettings.model !== model ||
      lastAppliedVideoSettings.ratio !== ratio ||
      lastAppliedVideoSettings.quantity !== quantity;

    if (settingsChanged) {
      logger.info('Applying video settings via Agent Settings UI panel', { model, ratio, quantity });
      const applied = await applySettings(page, { model, ratio, quantity });
      lastAppliedVideoSettings = {
        model: applied.model || model,
        ratio: applied.ratio || ratio,
        quantity: applied.quantity || quantity,
      };
      logger.info('Agent video settings updated via UI', lastAppliedVideoSettings);
    }

    // Ratio validated against video-specific allowlist; model/ratio/quantity
    // themselves are already applied above via the Agent Settings UI panel
    // (applySettings) — do not re-click model/ratio/quantity controls here,
    // that duplicated logic used stale ad-hoc selectors and could fight the
    // settings panel's own state.
    const ratios = get('videoRatios', ['9:16', '16:9']);
    if (!ratios.includes(ratio)) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE, `Ratio ${ratio} not available for video`);
    }

    // Select duration (not covered by applySettings)
    const durations = get('durations', ['4s', '6s', '8s', '10s']);
    const duration = args.duration || '4s';
    if (!durations.includes(duration)) {
      logger.warn('Duration not available, using 4s', { requested: duration });
    }
    try {
      const durBtn = page.locator(`button:has-text("${duration}")`).first();
      if (await durBtn.isVisible().catch(() => false)) {
        await durBtn.click();
        await page.waitForTimeout(500);
      }
    } catch { /* ok */ }

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
      account: get('expectedAccount'),
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
