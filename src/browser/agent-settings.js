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

  let stillOpen = true;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    stillOpen = await isSidebarOpen(page);
    if (!stillOpen) break;
  }

  if (stillOpen) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      'Agent-chat sidebar did not close after clicking its Close button.'
    );
  }
}

function agentToggleLocator(page) {
  return page.locator('button:has(span.content:text-is("Agent"))').first();
}

export async function isAgentModeOn(page) {
  const btn = agentToggleLocator(page);
  const visible = await btn.isVisible().catch(() => false);
  if (!visible) return null;
  return (await btn.getAttribute('aria-pressed')) === 'true';
}

export async function ensureAgentOff(page) {
  const on = await isAgentModeOn(page);
  if (on === null) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      'Could not find the Agent mode toggle button on the composer.'
    );
  }
  if (!on) return;

  logger.info('Agent mode is ON — switching OFF for reliable one-shot generation settings');
  await agentToggleLocator(page).click();
  await page.waitForTimeout(500);

  const stillOn = await isAgentModeOn(page);
  if (stillOn) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      'Clicked the Agent toggle but it is still showing ON.'
    );
  }
}

// The composer's outer settings-summary trigger shows different text per
// mode — Image mode shows the model name ("🍌 Nano Banana Pro …"), but Video
// mode shows no model name at all, just "Video · {duration}s […] x{count}"
// (confirmed live) — so both patterns must be matched here, not just model
// names. This is only the CLOSED-state trigger; once the menu is open, the
// nested model sub-dropdown always shows a real model name regardless of
// mode (confirmed live) and is matched separately, scoped inside the menu.
function inlineSettingsTriggerLocator(page) {
  return page.locator('button[aria-haspopup="menu"]').filter({ hasText: /Nano|Banana|Omni|Veo|Imagen|Video/ }).first();
}

function openMenuLocator(page) {
  return page.locator('[role="menu"][data-state="open"]').first();
}

export async function isSettingsPanelOpen(page) {
  return await openMenuLocator(page).isVisible().catch(() => false);
}

export async function ensureSettingsPanelOpen(page, { mode = 'image' } = {}) {
  await ensureAgentOff(page);
  if (!(await isSettingsPanelOpen(page))) {
    const trigger = inlineSettingsTriggerLocator(page);
    const isVisible = await trigger.isVisible().catch(() => false);
    if (!isVisible) {
      throw new FlowError(
        ErrorCodes.UNKNOWN_UI_CHANGE,
        'Settings trigger button (model/ratio/count summary) not found in composer toolbar.'
      );
    }

    await trigger.click();
    await page.waitForTimeout(400);

    const opened = await isSettingsPanelOpen(page);
    if (!opened) {
      throw new FlowError(
        ErrorCodes.UNKNOWN_UI_CHANGE,
        'Clicked the settings trigger button, but the settings menu did not open.'
      );
    }
  }

  // Ensure the correct mode tab (IMAGE vs VIDEO) inside the menu is active
  const menu = openMenuLocator(page);
  const targetLabel = mode === 'video' ? 'Video' : 'Image';
  const modeTab = menu.locator('[role="tab"]').filter({ hasText: targetLabel }).first();
  if (await modeTab.isVisible().catch(() => false)) {
    const isSelected = (await modeTab.getAttribute('aria-selected')) === 'true';
    if (!isSelected) {
      logger.info(`Switching settings panel mode tab to ${targetLabel}`);
      await modeTab.click();
      await page.waitForTimeout(300);
    }
  }
}

export async function closeSettingsPanel(page) {
  if (!(await isSettingsPanelOpen(page))) return;
  const trigger = inlineSettingsTriggerLocator(page);
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click();
    await page.waitForTimeout(300);
  }
}

export async function readSettings(page, { mode = 'image' } = {}) {
  await ensureSettingsPanelOpen(page, { mode });
  const menu = openMenuLocator(page);

  const tabs = await menu.locator('[role="tab"]').all();
  let activeRatio = null;
  let activeQuantity = null;

  for (const tab of tabs) {
    if (!(await tab.isVisible().catch(() => false))) continue;
    const isSelected = (await tab.getAttribute('aria-selected')) === 'true';
    if (!isSelected) continue;

    const text = (await tab.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
    if (!activeRatio) {
      for (const r of ['16:9', '4:3', '1:1', '3:4', '9:16']) {
        if (text.includes(r)) { activeRatio = r; break; }
      }
    }
    if (!activeQuantity) {
      for (const q of ['x1', 'x2', 'x3', 'x4']) {
        if (text.includes(q)) { activeQuantity = parseInt(q.replace('x', ''), 10); break; }
      }
    }
  }

  const modelBtn = menu.locator('button[aria-haspopup="menu"]').filter({ hasText: /Nano|Banana|Omni|Veo|Imagen/ }).first();
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
    mode,
  };
}

export async function applySettings(page, { ratio, model, quantity, mode = 'image' }) {
  logger.info('Applying settings via Agent-OFF settings menu', { ratio, model, quantity, mode });
  await ensureSettingsPanelOpen(page, { mode });
  const menu = openMenuLocator(page);

  if (ratio) {
    const ratioTab = menu.locator('[role="tab"]').filter({ hasText: ratio }).first();
    if (await ratioTab.isVisible().catch(() => false)) {
      await ratioTab.click();
      await page.waitForTimeout(300);
    } else {
      throw new FlowError(
        ErrorCodes.RATIO_NOT_AVAILABLE,
        `Aspect ratio tab "${ratio}" not found or not visible in settings menu.`
      );
    }
  }

  if (quantity) {
    const qtyText = `x${quantity}`;
    const qtyTab = menu.locator('[role="tab"]').filter({ hasText: qtyText }).first();
    if (await qtyTab.isVisible().catch(() => false)) {
      await qtyTab.click();
      await page.waitForTimeout(300);
    } else {
      throw new FlowError(
        ErrorCodes.INVALID_PARAMS,
        `Quantity tab "${qtyText}" not found or not visible in settings menu.`
      );
    }
  }

  if (model) {
    const modelDropdown = menu.locator('button[aria-haspopup="menu"]').filter({ hasText: /Nano|Banana|Omni|Veo|Imagen/ }).first();

    if (await modelDropdown.isVisible().catch(() => false)) {
      await modelDropdown.click();
      await page.waitForTimeout(300);

      const modelOption = page
        .locator('[role="menuitem"], [role="option"]')
        .filter({ hasText: model })
        .first();

      if (await modelOption.isVisible().catch(() => false)) {
        await modelOption.click();
        await page.waitForTimeout(300);

        for (let i = 0; i < 5; i++) {
          await page.waitForTimeout(200);
          if (!(await modelOption.isVisible().catch(() => false))) break;
        }
      } else {
        throw new FlowError(
          ErrorCodes.MODEL_NOT_AVAILABLE,
          `Model option "${model}" not found in dropdown menu.`
        );
      }
    } else {
      throw new FlowError(
        ErrorCodes.UNKNOWN_UI_CHANGE,
        'Model selector dropdown button not found in settings menu.'
      );
    }
  }

  // Read back settings to verify they actually changed
  const current = await readSettings(page, { mode });

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
