import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { saveMetadata } from '../utils/file-manager.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { get } from '../utils/config.js';
import { getActiveExpectedAccount } from '../browser/launch-profile.js';

const ENGINE_OPTIONS = ['Nano Banana 2', 'Nano Banana Pro'];
const RATIO_OPTIONS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const VISUAL_LOGIC_OPTIONS = ['Style from References', 'Ultra Realistic', 'Cinematic Movie', 'Film Noir', 'Anime / Manga'];

function exactText(s) {
  return new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

// Grid Architect (like every Flow "app"/template) runs inside a sandboxed
// <iframe title="Applet preview" sandbox="allow-scripts">, invisible to
// page-level locators — confirmed live: page.locator('button', {hasText:
// 'Start Architecting'}) never finds anything because the button simply
// isn't in the main document. This is why every previous attempt at wiring
// this tool's form silently failed. Always go through this frameLocator.
function appletFrame(page) {
  return page.frameLocator('iframe[title="Applet preview"]');
}

// Each dropdown (ENGINE / FORMAT RATIO / VISUAL LOGIC) is a trigger button
// showing "LABEL\n\ncurrent value" plus a menu of option buttons whose own
// text is exactly the option ("Nano Banana 2", "16:9", ...). An anchored
// exact-text regex is required to select the option instead of the trigger
// — the trigger's own text also contains the option string as a substring
// once a value has been picked (confirmed live: clicking a substring match
// right after selecting "16:9" would re-hit the trigger and just re-open
// the menu instead of picking a different option).
async function selectDropdown(frame, page, triggerLabel, optionText) {
  const trigger = frame.locator('button').filter({ hasText: triggerLabel }).first();
  if (!(await trigger.isVisible().catch(() => false))) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Grid Architect "${triggerLabel}" control not found.`);
  }
  await trigger.click();
  await page.waitForTimeout(500);

  const option = frame.locator('button').filter({ hasText: exactText(optionText) }).first();
  if (!(await option.isVisible().catch(() => false))) {
    await trigger.click().catch(() => {});
    throw new FlowError(ErrorCodes.INVALID_PARAMS,
      `Grid Architect "${triggerLabel}" option "${optionText}" not found. Available: see tool description.`);
  }
  await option.click();
  await page.waitForTimeout(400);
}

export async function handleUseGridArchitect(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('grid_architect', {
    ...args,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // Step 1: Ensure we're inside a project context
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });

    const currentUrl = page.url();
    const projectId = args.project_id || currentUrl.split('/project/')[1]?.split(/[/?#]/)[0];
    if (!projectId) {
      throw new FlowError(
        ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not determine project ID to navigate to Tools section.'
      );
    }

    // Step 2: Navigate to project Tools section
    const toolsUrl = `https://labs.google/fx/tools/flow/project/${projectId}/tools`;
    logger.info('Navigating to project tools page', { toolsUrl });
    await page.goto(toolsUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Step 3: Click the Templates tab
    const templatesTab = page.locator('button, [role="tab"]').filter({ hasText: 'Templates' }).first();
    if (await templatesTab.isVisible().catch(() => false)) {
      logger.info('Clicking Templates tab');
      await templatesTab.click();
      await page.waitForTimeout(1000);
    }

    // Step 4: Find and click tile with text exactly "Grid Architect"
    // A fixed short wait after clicking Templates is not reliably enough
    // for this image-heavy tile grid to finish rendering (confirmed live)
    // — wait for the tile itself instead of a fixed sleep.
    const gaTile = page.locator('*').filter({ hasText: /^Grid Architect$/ }).first();
    const tileVisible = await gaTile.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    if (!tileVisible) {
      await takeScreenshot(page, 'no-grid-architect-tile');
      throw new FlowError(
        ErrorCodes.UNKNOWN_UI_CHANGE,
        'Grid Architect template tile not found on Tools page.'
      );
    }

    logger.info('Clicking Grid Architect tile to create remix');
    await gaTile.click();
    await page.waitForTimeout(4000);

    // Step 5: Verify navigation landed on a remix tool page matching /tool/{uuid}
    const remixUrl = page.url();
    const isToolPage = /\/tool\/[a-f0-9-]+/i.test(remixUrl);
    if (!isToolPage) {
      await takeScreenshot(page, 'grid-architect-remix-failed');
      throw new FlowError(
        ErrorCodes.UNKNOWN_UI_CHANGE,
        `Expected navigation to Grid Architect tool remix page (/tool/{uuid}), but landed on: ${remixUrl}`
      );
    }

    logger.info('Successfully created Grid Architect remix', { remixUrl });

    // Step 6: Enter the tool's config UI. It lives inside a sandboxed
    // <iframe title="Applet preview"> — not the top-level page — behind a
    // "Start Architecting" splash button.
    const frame = appletFrame(page);
    const startBtn = frame.locator('button').filter({ hasText: /architect/i }).first();
    const startVisible = await startBtn.isVisible({ timeout: 10000 }).catch(() => false);
    if (!startVisible) {
      await takeScreenshot(page, 'grid-architect-no-start-button');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find the "Start Architecting" button inside the tool\'s applet frame.');
    }
    await startBtn.click();
    await page.waitForTimeout(2000);

    // Step 7: Configuration — ENGINE / FORMAT RATIO / VISUAL LOGIC dropdowns
    const engine = args.engine || 'Nano Banana 2';
    if (!ENGINE_OPTIONS.includes(engine)) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Grid Architect engine "${engine}" not available. Options: ${ENGINE_OPTIONS.join(', ')}`);
    }
    await selectDropdown(frame, page, 'ENGINE', engine);

    const ratio = args.ratio || '16:9';
    if (!RATIO_OPTIONS.includes(ratio)) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE,
        `Grid Architect ratio "${ratio}" not available. Options: ${RATIO_OPTIONS.join(', ')}`);
    }
    await selectDropdown(frame, page, 'FORMAT RATIO', ratio);

    const visualLogic = args.visual_logic || 'Style from References';
    if (!VISUAL_LOGIC_OPTIONS.includes(visualLogic)) {
      throw new FlowError(ErrorCodes.INVALID_PARAMS,
        `Grid Architect visual_logic "${visualLogic}" not available. Options: ${VISUAL_LOGIC_OPTIONS.join(', ')} (or a custom style, not yet wired up).`);
    }
    await selectDropdown(frame, page, 'VISUAL LOGIC', visualLogic);

    // Step 8: Mode — SEQUENCE (per-shot prompts) if shot_prompts given,
    // otherwise UNIFIED THEME (single master prompt). Each shot card's
    // "Shot details..." textarea has no distinguishing attribute other than
    // DOM order, which matches shot index (confirmed live).
    const hasShotPrompts = Array.isArray(args.shot_prompts) && args.shot_prompts.length > 0;

    if (hasShotPrompts) {
      const sequenceCard = frame.locator('button').filter({ hasText: 'SEQUENCE' }).first();
      await sequenceCard.click();
      await page.waitForTimeout(500);

      const shotTextareas = frame.locator('textarea[placeholder="Shot details..."]');
      const shotCount = await shotTextareas.count();
      for (let i = 0; i < Math.min(args.shot_prompts.length, shotCount); i++) {
        await shotTextareas.nth(i).fill(args.shot_prompts[i]);
        await page.waitForTimeout(200);
      }
      if (args.shot_prompts.length > shotCount) {
        logger.warn('Grid Architect only has 4 shot slots — extra shot_prompts were dropped', {
          provided: args.shot_prompts.length, slots: shotCount,
        });
      }
    } else if (args.theme_prompt) {
      const unifiedCard = frame.locator('button').filter({ hasText: 'UNIFIED THEME' }).first();
      await unifiedCard.click();
      await page.waitForTimeout(500);

      const themeTextarea = frame.locator('textarea').first();
      await themeTextarea.fill(args.theme_prompt);
      await page.waitForTimeout(200);
    } else {
      throw new FlowError(ErrorCodes.INVALID_PARAMS,
        'Grid Architect requires either theme_prompt (Unified Theme mode) or shot_prompts (Sequence mode).');
    }

    // NOTE: reference image upload (GLOBAL REFERENCES "+" button, and each
    // shot's "+ COMPOSITION" button) is not wired up — clicking it opens
    // something with no <input type="file"> in the DOM (no file inputs
    // found at all on this page), so the upload mechanism itself is still
    // unmapped. The `references` param is accepted but currently ignored.
    if (args.references && args.references.length > 0) {
      logger.warn('Grid Architect reference image upload is not yet implemented — references param ignored', {
        references: args.references,
      });
    }

    const configScreenshot = await takeScreenshot(page, 'grid-architect-configured');

    if (!autoConfirm) {
      const result = {
        status: 'ready_for_confirmation',
        type: 'grid_architect',
        url: remixUrl,
        engine,
        ratio,
        visual_logic: visualLogic,
        mode: hasShotPrompts ? 'sequence' : 'unified_theme',
        message: 'Grid Architect configured. No credits spent. Call again with auto_confirm=true to generate.',
        account: getActiveExpectedAccount(),
        screenshot: configScreenshot,
        jobId: job.id,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // Step 9: Generate
    const generateBtn = frame.locator('button').filter({ hasText: 'GENERATE' }).first();
    const generateVisible = await generateBtn.isVisible().catch(() => false);
    if (!generateVisible) {
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Grid Architect Generate button not found.');
    }
    const generateDisabled = await generateBtn.isDisabled().catch(() => false);
    if (generateDisabled) {
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Grid Architect Generate button is disabled.');
    }
    logger.info('auto_confirm=true — clicking Grid Architect Generate button');
    await generateBtn.click();
    await page.waitForTimeout(5000);

    const finalScreenshot = await takeScreenshot(page, 'grid-architect-generated');

    saveMetadata(job.id, {
      type: 'grid_architect',
      toolUrl: remixUrl,
      themePrompt: args.theme_prompt,
      shotPrompts: args.shot_prompts,
      engine,
      ratio,
      visualLogic,
      projectName: args.project_name,
      campaign: args.campaign,
      jobId: job.id,
      status: 'generated',
    });

    const result = {
      status: 'success',
      type: 'grid_architect',
      url: remixUrl,
      engine,
      ratio,
      visual_logic: visualLogic,
      mode: hasShotPrompts ? 'sequence' : 'unified_theme',
      account: getActiveExpectedAccount(),
      message: 'Grid Architect generation started. Individual shots appear in the tool\'s grid view; use flow_screenshot or open the URL to review.',
      screenshot: finalScreenshot,
    };
    jobQueue.completeJob(job.id, result);
    return result;
  } catch (err) {
    await takeScreenshot(getPage(), 'grid-architect-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
