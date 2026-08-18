import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { getActiveExpectedAccount } from '../browser/launch-profile.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { getPromptInput, fillPrompt, clickGenerateButton } from '../browser/composer.js';
import { applySettings } from '../browser/agent-settings.js';

export async function handleCreateCharacter(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('create_character', {
    ...args,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // Ensure we're inside a project
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });

    // Navigate to the Characters sidebar section
    await navigateToSidebar(page, 'Characters');
    await page.waitForTimeout(2000);

    const description = args.description || args.prompt || '';
    if (!description) {
      throw new FlowError(
        ErrorCodes.INVALID_PARAMS,
        'Character description is required.'
      );
    }

    // Reuse composer.js helper to locate prompt input on the Characters page
    const promptInput = await getPromptInput(page);
    if (!promptInput) {
      await takeScreenshot(page, 'no-character-prompt-input');
      throw new FlowError(
        ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find character description prompt input on Characters page.'
      );
    }

    // Fill character description
    await fillPrompt(page, promptInput, description);

    // Apply model if specified
    if (args.model) {
      try {
        await applySettings(page, { model: args.model });
      } catch (err) {
        logger.warn('Could not apply model setting for character', { error: err.message });
      }
    }

    // Upload reference image if provided
    const refFile = args.reference_image || (args.reference_images && args.reference_images[0]);
    if (refFile) {
      const fileLocator = page.locator('input[type="file"]').first();
      if (await fileLocator.isVisible().catch(() => false)) {
        await fileLocator.setInputFiles(refFile);
        await page.waitForTimeout(2000);
        logger.info('Reference image uploaded for character', { refFile });
      }
    }

    // Credit-spend gate: auto_confirm determines if we click Create
    if (!autoConfirm) {
      const setupScreenshot = await takeScreenshot(page, 'character-ready-for-confirmation');
      const result = {
        status: 'ready_for_confirmation',
        type: 'character',
        message: 'Character description and settings filled. No credits spent. Call again with auto_confirm=true to create.',
        description,
        account: getActiveExpectedAccount(),
        screenshot: setupScreenshot,
        jobId: job.id,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // Confirmed path: Click Create button via composer.js helper
    logger.info('auto_confirm=true — clicking Create button for character');
    await clickGenerateButton(page);
    await page.waitForTimeout(3000);

    const finalScreenshot = await takeScreenshot(page, 'character-created');

    saveMetadata(job.id, {
      type: 'character',
      description,
      model: args.model,
      referenceImage: refFile,
      projectName: args.project_name,
      campaign: args.campaign,
      jobId: job.id,
      status: 'created',
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'character',
      description,
      account: getActiveExpectedAccount(),
      message: 'Character creation initiated successfully.',
      screenshot: finalScreenshot,
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'create-character-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}

export async function handleListCharacters() {
  const page = getPage();
  await navigateToSidebar(page, 'Characters');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);
  const characterCards = elements.buttons.filter(b =>
    !b.text.includes('New') && !b.text.includes('Create') && b.text.length > 2
  );

  return {
    status: 'success',
    characters_found: characterCards,
    raw_elements: elements,
    screenshot: await takeScreenshot(page, 'characters-list'),
  };
}
