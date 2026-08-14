import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

// Image and video share the exact same bottom composer bar (Slate-based
// contenteditable, "Create" button with an arrow_forward icon) — this module
// is the single source of truth for finding it, used by both
// generate-image.js and generate-video.js. Do not re-implement these
// locators per-tool; that's how they drifted out of sync before.

// Right after the Agent Settings panel closes (Save click), its unmount
// animation can still be in flight — the composer's contenteditable isn't
// visible yet on the very first check. Poll instead of checking once.
export async function getPromptInput(page, { timeoutMs = 5000 } = {}) {
  const candidates = [
    page.locator('[role="textbox"][data-slate-editor="true"]:visible').first(),
    page.locator('[contenteditable="true"]:visible').first(),
    page.locator('textarea:visible').first(),
    page.locator('[contenteditable="true"]').first(),
    page.locator('textarea').first(),
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
    await page.waitForTimeout(300);
  }

  return null;
}

export async function fillPrompt(page, promptInput, text) {
  await promptInput.click();
  await promptInput.fill('');
  await page.waitForTimeout(200);
  await promptInput.type(text, { delay: 15 });
  await page.waitForTimeout(500);
}

// The composer's Create/Generate button: icon ligature text "arrow_forward",
// accessible (sr-only) name "Create" — not "Generate", despite the tool name.
export function getGenerateButton(page) {
  return page.locator('button:has-text("arrow_forward"), button:has-text("Generate")').first();
}

export async function clickGenerateButton(page) {
  const btn = getGenerateButton(page);
  const visible = await btn.isVisible().catch(() => false);
  if (!visible) {
    throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not found');
  }
  const disabled = await btn.isDisabled().catch(() => false);
  if (disabled) {
    throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button is disabled');
  }
  logger.info('Clicking Generate — credits will be spent');
  await btn.click();
}
