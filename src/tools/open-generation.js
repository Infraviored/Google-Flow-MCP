import { getPage } from '../browser/connect.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { navigateToGeneration } from '../browser/gallery.js';
import { backfillTitle } from './generation-title.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

export async function handleOpenGeneration(args = {}) {
  if (!args.id && !args.url) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'flow_open_generation requires either id or url.');
  }

  const page = getPage();

  if (args.project_id || args.project_name || args.campaign) {
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });
  }

  const editUrl = await navigateToGeneration(page, { id: args.id, url: args.url });
  const id = args.id || editUrl.split('/edit/')[1]?.split(/[/?#]/)[0] || null;

  return {
    status: 'success',
    editUrl,
    id,
    // No gallery DOM to read a title from once we're on the /edit/ page itself
    // (the row-caption title only exists in the gallery grid) — job-history
    // backfill is the only source here.
    title: id ? backfillTitle(null, id) : null,
  };
}
