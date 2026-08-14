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

  // Some sidebar variants (e.g. a brand-new project's first-load "Untitled
  // session" welcome panel) take longer than a fixed 500ms to actually
  // unmount — confirmed live the close succeeded but a single early check
  // reported it as still open. Poll instead of checking once.
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

// The bottom composer ALSO has an independent "Agent" toggle (aria-pressed), on
// top of the fresh/sidebar distinction above. Confirmed live: with Agent ON,
// generation routes through Flow's own LLM copilot (conversational, stateful,
// decides its own ratio/model/count from the prompt) and does NOT reliably
// honor whatever the settings panel shows — this session repeatedly observed
// 16:9 x2 output regardless of panel state while Agent was ON. With Agent OFF
// ("one-shot"), the exact settings-menu selection is what gets sent. Agent OFF
// is also the only mode with a settings surface whose changes are provably
// live-applied (see applySettings below) — force it before every settings
// read/write and every generation.
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

// Agent-OFF settings surface: an inline trigger button that shows the current
// state directly (e.g. "🍌 Nano Banana Pro [ratio icon] x2"), opening a Radix
// dropdown menu (role="menu") — NOT a dialog with a Save button. Selections
// apply live per click (confirmed live: a real click on the 16:9 tab flipped
// aria-selected and updated the trigger's own label immediately). The nested
// model sub-trigger has the same aria-haspopup="menu" + model-name text, so
// once the menu is open it must be scoped to inside the open menu container to
// avoid matching the still-visible outer trigger underneath it.
function inlineSettingsTriggerLocator(page) {
  return page.locator('button[aria-haspopup="menu"]').filter({ hasText: /Nano|Banana|Omni|Veo|Imagen/ }).first();
}

function openMenuLocator(page) {
  return page.locator('[role="menu"][data-state="open"]').first();
}

export async function isSettingsPanelOpen(page) {
  return await openMenuLocator(page).isVisible().catch(() => false);
}

export async function ensureSettingsPanelOpen(page) {
  await ensureAgentOff(page);
  if (await isSettingsPanelOpen(page)) return;

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

export async function closeSettingsPanel(page) {
  // Close by re-clicking the trigger (toggle), never by clicking elsewhere —
  // confirmed live that an outside click can land on a gallery tile underneath
  // the menu and navigate away instead of just dismissing it.
  if (!(await isSettingsPanelOpen(page))) return;
  const trigger = inlineSettingsTriggerLocator(page);
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click();
    await page.waitForTimeout(300);
  }
}

export async function readSettings(page) {
  await ensureSettingsPanelOpen(page);
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
  };
}

export async function applySettings(page, { ratio, model, quantity }) {
  logger.info('Applying settings via Agent-OFF settings menu', { ratio, model, quantity });
  await ensureSettingsPanelOpen(page);
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

        // Selecting a menu item closes the submenu via its own animation — poll
        // rather than assume a fixed delay is enough. Never press Escape: it
        // bubbles past the menu and can close the enclosing Agent-chat sidebar
        // too (a separate, stateful panel) — a much bigger side effect.
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
