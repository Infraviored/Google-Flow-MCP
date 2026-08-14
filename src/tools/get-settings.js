import { getPage } from '../browser/connect.js';
import { readSettings, closeSettingsPanel, closeSidebar } from '../browser/agent-settings.js';

export async function handleGetSettings() {
  const page = getPage();
  await closeSidebar(page);
  const current = await readSettings(page);
  await closeSettingsPanel(page);
  return {
    status: 'success',
    ratio: current.ratio,
    quantity: current.quantity,
    model: current.model,
  };
}
