import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

// The Agent-chat sidebar (a stateful, per-project follow-up conversation, opened by
// clicking into a past generation) and the plain bottom composer ("fresh" mode) are
// two different UI surfaces that can each be showing when a tool call starts. Only
// the bottom composer reliably respects the output-count setting (verified live) —
// the sidebar can silently generate fewer images than requested. Always detect and
// force "fresh" mode before generating, rather than adapting to whichever is open.
export async function isSidebarOpen(page) {
  const closeBtn = page.locator('button').filter({ hasText: 'Close' }).first();
  return await closeBtn.isVisible().catch(() => false);
}

export async function closeSidebar(page) {
  const closeBtn = page.locator('button').filter({ hasText: 'Close' }).first();
  const visible = await closeBtn.isVisible().catch(() => false);
  if (!visible) return;

  logger.info('Agent-chat sidebar (follow-up mode) is open, closing to force fresh composer mode');
  await closeBtn.click();
  await page.waitForTimeout(500);

  const stillOpen = await isSidebarOpen(page);
  if (stillOpen) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      'Agent-chat sidebar did not close after clicking its Close button.'
    );
  }
}

export async function isSettingsPanelOpen(page) {
  const saveBtn = page.getByRole('button', { name: 'Save' });
  if (await saveBtn.isVisible().catch(() => false)) return true;
  const ratioTab = page.locator('[role="tab"]').filter({ hasText: '16:9' }).first();
  return await ratioTab.isVisible().catch(() => false);
}

export async function ensureSettingsPanelOpen(page) {
  if (await isSettingsPanelOpen(page)) return;

  const tuneBtn = page.locator('button:has(i:text("tune"))')
    .or(page.getByRole('button', { name: 'tune Settings' }))
    .first();

  const isVisible = await tuneBtn.isVisible().catch(() => false);
  if (!isVisible) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      'Settings button ("tune Settings") not found or not visible in composer toolbar.'
    );
  }

  await tuneBtn.click();
  await page.waitForTimeout(500);

  const opened = await isSettingsPanelOpen(page);
  if (!opened) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      'Clicked settings button, but settings panel did not open.'
    );
  }
}

export async function closeSettingsPanel(page) {
  // No Escape fallback here on purpose: it bubbles past the settings panel and can
  // close the enclosing Agent-chat sidebar too. Save alone reliably closes the panel
  // (verified live) — if it doesn't, leaving the panel open is the safer failure mode.
  const saveBtn = page.getByRole('button', { name: 'Save' });
  if (await saveBtn.isVisible().catch(() => false)) {
    await saveBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

export async function readSettings(page) {
  await ensureSettingsPanelOpen(page);

  const tabs = await page.locator('[role="tab"]').all();
  let activeRatio = null;
  let activeQuantity = null;

  for (const tab of tabs) {
    if (!(await tab.isVisible().catch(() => false))) continue;
    const text = (await tab.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
    const isSelected =
      (await tab.getAttribute('aria-selected')) === 'true' ||
      (await tab.getAttribute('data-state')) === 'active';

    if (isSelected) {
      if (!activeRatio) {
        for (const r of ['16:9', '4:3', '1:1', '3:4', '9:16']) {
          if (text.includes(r)) {
            activeRatio = r;
            break;
          }
        }
      }
      if (!activeQuantity) {
        for (const q of ['x1', 'x2', 'x3', 'x4']) {
          if (text.includes(q)) {
            activeQuantity = parseInt(q.replace('x', ''), 10);
            break;
          }
        }
      }
    }
  }

  // Model dropdown button text
  const modelBtn = page
    .locator('button:has(i:text("arrow_drop_down"))')
    .filter({ hasText: /Nano|Banana|Omni|Veo|Imagen|Display|Seal/ })
    .first();

  let activeModel = null;
  if (await modelBtn.isVisible().catch(() => false)) {
    const rawText = await modelBtn.innerText().catch(() => '');
    activeModel = rawText
      .replace(/arrow_drop_down/g, '')
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
      .trim();
  }

  return {
    ratio: activeRatio,
    quantity: activeQuantity,
    model: activeModel,
  };
}

export async function applySettings(page, { ratio, model, quantity }) {
  logger.info('Applying settings via Agent Settings panel', { ratio, model, quantity });
  await ensureSettingsPanelOpen(page);

  if (ratio) {
    const ratioTab = page.locator('[role="tab"]').filter({ hasText: ratio }).first();
    if (await ratioTab.isVisible().catch(() => false)) {
      await ratioTab.click();
      await page.waitForTimeout(300);
    } else {
      throw new FlowError(
        ErrorCodes.RATIO_NOT_AVAILABLE,
        `Aspect ratio tab "${ratio}" not found or not visible in settings panel.`
      );
    }
  }

  if (quantity) {
    const qtyText = `x${quantity}`;
    let qtyTab = page.locator('[role="tab"]').filter({ hasText: qtyText }).first();
    let visible = await qtyTab.isVisible().catch(() => false);
    if (!visible) {
      await page.waitForTimeout(300);
      visible = await qtyTab.isVisible().catch(() => false);
    }
    if (visible) {
      await qtyTab.click();
      await page.waitForTimeout(300);
    } else {
      throw new FlowError(
        ErrorCodes.INVALID_PARAMS,
        `Quantity tab "${qtyText}" not found or not visible in settings panel.`
      );
    }
  }

  if (model) {
    const modelDropdown = page
      .locator('button:has(i:text("arrow_drop_down"))')
      .filter({ hasText: /Nano|Banana|Omni|Veo|Imagen|Display|Seal/ })
      .first();

    if (await modelDropdown.isVisible().catch(() => false)) {
      await modelDropdown.click();
      await page.waitForTimeout(300);

      // Excludes bare `button`: the dropdown trigger itself already displays the
      // current model name as its label, so a generic button locator matches it
      // too and .first() can grab the (already-open, overlay-covered) trigger
      // instead of the actual menu item, hanging the click for the full timeout.
      const modelOption = page
        .locator('[role="menuitem"], [role="option"]')
        .filter({ hasText: model })
        .first();

      if (await modelOption.isVisible().catch(() => false)) {
        await modelOption.click();

        // Selecting a menu item closes the dropdown via its own animation — poll
        // rather than assume a fixed delay is enough, and NEVER press Escape here:
        // it bubbles past the dropdown and can close the enclosing Agent-chat
        // sidebar too (a separate, stateful panel), which is a much bigger and
        // harder-to-recover side effect than a slightly slow dropdown close.
        for (let i = 0; i < 5; i++) {
          await page.waitForTimeout(200);
          if (!(await modelOption.isVisible().catch(() => false))) break;
        }
      } else {
        await page.keyboard.press('Escape').catch(() => {});
        throw new FlowError(
          ErrorCodes.MODEL_NOT_AVAILABLE,
          `Model option "${model}" not found in dropdown menu.`
        );
      }
    } else {
      throw new FlowError(
        ErrorCodes.UNKNOWN_UI_CHANGE,
        'Model selector dropdown button not found in settings panel.'
      );
    }
  }

  // Read back settings to verify they actually changed
  const current = await readSettings(page);

  if (ratio && current.ratio !== ratio) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      `Failed to apply ratio setting: requested "${ratio}", but panel shows "${current.ratio}".`
    );
  }

  if (quantity && current.quantity !== Number(quantity)) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      `Failed to apply quantity setting: requested ${quantity}, but panel shows ${current.quantity}.`
    );
  }

  if (model && current.model && !current.model.toLowerCase().includes(model.toLowerCase().split(' ')[0])) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      `Failed to apply model setting: requested "${model}", but panel shows "${current.model}".`
    );
  }

  await closeSettingsPanel(page);
  logger.info('Successfully verified and applied settings', current);
  return current;
}
