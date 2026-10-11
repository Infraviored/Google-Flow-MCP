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
import { humanClick } from '../browser/safe-actions.js';

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

    // Characters live at /project/{id}/character. Without this check a missed
    // navigation left the description in the normal composer, where
    // auto_confirm would have generated a plain image instead of a character.
    if (page.url().includes('/edit/')) {
      await page.goto(page.url().split('/edit/')[0], { waitUntil: 'load', timeout: 30000 });
    }
    // With no characters yet, "Characters" opens /character directly. Once the
    // project has some, it only filters the gallery and a "New character"
    // tile leads on to /character.
    await navigateToSidebar(page, 'Characters');
    if (!/\/character(\/|$|\?)/.test(page.url())) {
      const newChar = page.getByText('New character', { exact: true }).first();
      if (await newChar.isVisible().catch(() => false)) {
        await humanClick(page, newChar);
        await page.waitForURL(/\/character(\/|$|\?)/, { timeout: 15000 }).catch(() => {});
      }
    }
    if (!/\/character(\/|$|\?)/.test(page.url())) {
      await takeScreenshot(page, 'characters-page-not-open');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Characters page did not open (at ${page.url()}).`);
    }
    await page.waitForTimeout(1000);

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

    // The character composer has its own model dropdown (no settings popover).
    if (args.model) {
      await humanClick(page, page.locator('[aria-label="Select model family"]').first());
      const option = page.locator('[role="menuitem"]').filter({ hasText: args.model }).first();
      if (!(await option.isVisible().catch(() => false))) {
        await page.keyboard.press('Escape');
        throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE, `Model "${args.model}" not offered for characters.`);
      }
      await option.click();
      await page.waitForTimeout(400);
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

    // Confirmed path: create. Flow opens /character/{id} right away and fills
    // in the portrait when it is done ("Download image" appears then).
    logger.info('auto_confirm=true — creating character (spends credits)');
    await humanClick(page, page.getByRole('button', { name: 'Start generation', exact: true }).first());
    await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 60000 }).catch(() => {});
    const characterId = page.url().match(/\/character\/([0-9a-f-]{36})/)?.[1];
    if (!characterId) {
      await takeScreenshot(page, 'character-not-created');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Character creation did not open a character page (at ${page.url()}).`);
    }
    const ready = await page.getByRole('button', { name: 'Download image' }).first()
      .waitFor({ state: 'visible', timeout: get('generationTimeoutMs', 180000) }).then(() => true).catch(() => false);
    if (!ready) {
      if (await page.getByText('We noticed some unusual activity').count().catch(() => 0)) {
        throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
          'Flow rejected the character as unusual activity (reCAPTCHA). No credits were charged; retry later.');
      }
      await takeScreenshot(page, 'character-portrait-timeout');
      throw new FlowError(ErrorCodes.GENERATION_TIMEOUT, 'Character page opened but its portrait never finished.');
    }

    // Name it: the title input in the top bar is the one that persists on Enter
    // (the "Character name" field next to the portrait does not, verified live).
    let named = null;
    if (args.name) {
      const title = page.locator('input[aria-label="Editable text"]').first();
      await humanClick(page, title);
      await title.fill(args.name);
      await title.press('Enter');
      await page.waitForTimeout(1500);
      named = await page.locator('input[aria-label="Character name"]').first().inputValue().catch(() => null);
      if (named !== args.name) {
        throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
          `Character ${characterId} was created but could not be named "${args.name}" (shows "${named}").`);
      }
    }

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
      characterId,
      name: named,
      url: page.url(),
      description,
      account: getActiveExpectedAccount(),
      message: 'Character created.',
      credits_consumed: true,
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
