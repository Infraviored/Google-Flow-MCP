import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { humanClick } from './safe-actions.js';

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

// Confirmed live: Flow enforces a 1400-character prompt limit, for both
// image and video composers. Over that, the composer silently refuses/never
// finishes accepting input rather than erroring — fail loud before typing
// instead of timing out mid-type.
export const PROMPT_CHAR_LIMIT = 1400;

export async function fillPrompt(page, promptInput, text) {
  // promptInput.type() sends real keydown events per character. In Flow's
  // Slate-based composer, Enter submits (like a chat input) rather than
  // inserting a newline — any \n in `text` fires Generate early with
  // whatever partial prompt had been typed so far. Collapse all whitespace
  // (including newlines) to single spaces before typing; line breaks carry
  // no prompt-semantic meaning here.
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length > PROMPT_CHAR_LIMIT) {
    throw new FlowError(
      ErrorCodes.INVALID_PARAMS,
      `Prompt is ${singleLine.length} characters — Flow enforces a ${PROMPT_CHAR_LIMIT}-character limit. Shorten to ${PROMPT_CHAR_LIMIT} chars or fewer and retry.`
    );
  }
  await humanClick(page, promptInput);
  await promptInput.fill('');
  await page.waitForTimeout(200);
  // Type at a human pace. Confirmed live on flow.google.com: the same edit
  // instruction typed at 5 ms/char was rejected by Flow's reCAPTCHA ("unusual
  // activity"), typed at ~60 ms/char it went through. A 1400-char prompt takes
  // about a minute this way — the cost of not being flagged.
  for (const ch of singleLine) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(25 + Math.random() * 60);
  }
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
