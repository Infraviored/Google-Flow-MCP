import { getPage } from '../browser/connect.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { navigateToGeneration, listHistorySteps, getGenerationTitle } from '../browser/gallery.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

export async function handleGenerationHistory(args = {}) {
  const page = getPage();

  if (args.project_id || args.project_name || args.campaign) {
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });
  }

  if (args.id || args.url) {
    await navigateToGeneration(page, { id: args.id, url: args.url });
  } else if (!/\/edit\//.test(page.url())) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS,
      'flow_generation_history requires either id/url, or the browser already being on a generation\'s edit page.');
  }

  const title = await getGenerationTitle(page);
  const steps = await listHistorySteps(page);

  return {
    status: 'success',
    editUrl: page.url(),
    title,
    stepCount: steps.length,
    steps,
    hint: 'Each step\'s mediaId is still individually downloadable at 1K via flow_download_latest\'s ' +
      'media_id param, even if a later edit superseded it in the main preview.',
  };
}
