import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

// The Agent-chat sidebar (a stateful, per-project follow-up conversation, opened by
// clicking into a past generation) and the plain bottom composer ("fresh" mode) are
// two different UI surfaces that can each be showing when a tool call starts. Only
// the bottom composer reliably respects the output-count setting (verified live) —
// the sidebar can silently generate fewer images than requested. Always detect and
// force "fresh" mode before generating, rather than adapting to whichever is open.
// flow.google.com: the sidebar's close button is an icon button with
// aria-label "Close" (ligature text "close").
function sidebarCloseLocator(page) {
  return page.getByRole('button', { name: 'Close', exact: true }).first();
}

export async function isSidebarOpen(page) {
  const closeBtn = sidebarCloseLocator(page);
  return await closeBtn.isVisible().catch(() => false);
}

export async function closeSidebar(page) {
  const closeBtn = sidebarCloseLocator(page);
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
  return page.locator('button.agent-mode-chip').first();
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
  return page.getByRole('button', { name: 'Settings trigger', exact: true }).first();
}

// The settings popover is an Angular CDK overlay holding mat-button-toggle
// groups (each option a button[role=radio] with aria-checked) and the model
// family dropdown.
function openMenuLocator(page) {
  return page.locator('.cdk-overlay-pane').filter({ has: page.locator('[aria-label="Select model family"]') }).first();
}

function modelDropdownLocator(menu) {
  return menu.locator('[aria-label="Select model family"]').first();
}

// Option text carries icon ligatures ("crop_square1:1", "volume_upVeo 3.1 - Fast");
// match on the visible label as a suffix so "Nano Banana 2" never hits "Nano Banana 2.1".
function exactSuffix(label) {
  return new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
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

    // The previous popover may still be animating out; a click during that
    // window is swallowed. Poll, and click once more if it never opened.
    let opened = false;
    for (let attempt = 0; attempt < 2 && !opened; attempt++) {
      await trigger.click();
      for (let i = 0; i < 10 && !opened; i++) {
        await page.waitForTimeout(200);
        opened = await isSettingsPanelOpen(page);
      }
    }
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
  const modeTab = menu.locator('button[role="radio"]').filter({ hasText: exactSuffix(targetLabel) }).first();
  if (await modeTab.isVisible().catch(() => false)) {
    const isSelected = (await modeTab.getAttribute('aria-checked')) === 'true';
    if (!isSelected) {
      logger.info(`Switching settings panel mode tab to ${targetLabel}`);
      await modeTab.click();
      await page.waitForTimeout(300);
    }
  }
}

export async function closeSettingsPanel(page) {
  if (!(await isSettingsPanelOpen(page))) return;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

export async function readSettings(page, { mode = 'image' } = {}) {
  await ensureSettingsPanelOpen(page, { mode });
  const menu = openMenuLocator(page);

  const tabs = await menu.locator('button[role="radio"]').all();
  let activeRatio = null;
  let activeQuantity = null;
  let activeDuration = null;

  for (const tab of tabs) {
    if (!(await tab.isVisible().catch(() => false))) continue;
    const isSelected = (await tab.getAttribute('aria-checked')) === 'true';
    if (!isSelected) continue;

    const text = (await tab.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
    if (!activeRatio) {
      for (const r of ['16:9', '4:3', '1:1', '3:4', '9:16']) {
        if (text.includes(r)) { activeRatio = r; break; }
      }
    }
    if (!activeDuration) {
      const d = text.match(/(\d+)s$/);
      if (d) activeDuration = `${d[1]}s`;
    }
    if (!activeQuantity) {
      for (const q of ['x1', 'x2', 'x3', 'x4']) {
        if (text.includes(q)) { activeQuantity = parseInt(q.replace('x', ''), 10); break; }
      }
    }
  }

  const modelBtn = modelDropdownLocator(menu);
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
    ...(mode === 'video' && { duration: activeDuration }),
    model: activeModel,
    mode,
  };
}

export async function applySettings(page, { ratio, model, quantity, duration, mode = 'image' }) {
  logger.info('Applying settings via Agent-OFF settings menu', { ratio, model, quantity, mode });
  await ensureSettingsPanelOpen(page, { mode });
  const menu = openMenuLocator(page);

  if (ratio) {
    const ratioTab = menu.locator('button[role="radio"]').filter({ hasText: exactSuffix(ratio) }).first();
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
    const qtyTab = menu.locator('button[role="radio"]').filter({ hasText: exactSuffix(qtyText) }).first();
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
    const modelDropdown = modelDropdownLocator(menu);

    if (await modelDropdown.isVisible().catch(() => false)) {
      await modelDropdown.click();
      await page.waitForTimeout(300);

      const modelOption = page
        .locator('[role="menuitem"], [role="option"]')
        .filter({ hasText: exactSuffix(model) })
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

  if (duration && mode === 'video') {
    const durTab = menu.locator('button[role="radio"]').filter({ hasText: exactSuffix(duration) }).first();
    if (!(await durTab.isVisible().catch(() => false))) {
      throw new FlowError(ErrorCodes.INVALID_PARAMS,
        `Duration "${duration}" is not offered for ${model || 'this video model'} — only Omni 1.1 Flash has a ` +
        'duration choice (4s/6s/8s/10s); the Veo models have a fixed length. Omit duration for Veo.');
    }
    await durTab.click();
    await page.waitForTimeout(300);
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

  if (duration && mode === 'video' && current.duration !== duration) {
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      `Failed to apply duration: requested ${duration}, but panel shows ${current.duration}.`
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
