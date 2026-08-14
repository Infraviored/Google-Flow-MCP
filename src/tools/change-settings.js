import { getPage } from '../browser/connect.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { applySettings } from '../browser/agent-settings.js';

export async function handleChangeSettings(args = {}) {
  const page = getPage();

  if (args.project_id || args.project_name || args.campaign) {
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });
  }

  const applied = await applySettings(page, {
    ratio: args.ratio,
    model: args.model,
    quantity: args.quantity,
  });

  return {
    status: 'success',
    applied,
  };
}
