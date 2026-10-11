import { getPage } from '../browser/connect.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { fetchProjectContents, projectIdFromUrl } from '../browser/flow-api.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

// Newest first, straight from Flow's project listing (the gallery DOM has no
// ids or titles since flow.google.com).
export async function handleListGenerations(args = {}) {
  const page = getPage();

  if (args.project_id || args.project_name || args.campaign) {
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });
  }
  const projectId = projectIdFromUrl(page.url());
  if (!projectId) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Not inside a project — pass project_id or project_name.');
  }

  const limit = Math.min(Math.max(args.limit || 20, 1), 100);
  const { generations, media } = await fetchProjectContents(page, projectId);
  const list = generations
    .map(g => {
      const primary = media.find(m => m.mediaId === g.primaryMediaId);
      return {
        id: g.editId,
        title: g.title,
        createdAt: g.createdAt,
        kind: primary?.kind || null,
        prompt: primary?.prompt || null,
        primaryMediaId: g.primaryMediaId,
        steps: media.filter(m => m.editId === g.editId).length,
        editUrl: `https://flow.google.com/project/${projectId}/edit/${g.editId}`,
      };
    })
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);

  return { status: 'success', projectId, count: list.length, generations: list };
}
