import { getPage } from '../browser/connect.js';
import { readSettings, closeSettingsPanel } from '../browser/agent-settings.js';

export async function handleGetSettings() {
  const page = getPage();
  const current = await readSettings(page);
  await closeSettingsPanel(page);
  return {
    status: 'success',
    ratio: current.ratio,
    quantity: current.quantity,
    model: current.model,
  };
}
