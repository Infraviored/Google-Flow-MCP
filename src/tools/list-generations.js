import { getPage } from '../browser/connect.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { listGenerations } from '../browser/gallery.js';
import { backfillTitle } from './generation-title.js';

export async function handleListGenerations(args = {}) {
  const page = getPage();

  if (args.project_id || args.project_name || args.campaign) {
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });
  }

  const limit = Math.min(Math.max(args.limit || 20, 1), 100);
  const tiles = await listGenerations(page, { limit });
  const generations = tiles.map(t => ({
    ...t,
    title: backfillTitle(t.title, t.id),
    editUrl: t.editUrl ? `https://labs.google/fx${t.editUrl.startsWith('/fx') ? t.editUrl.slice(3) : t.editUrl}` : null,
  }));

  return {
    status: 'success',
    count: generations.length,
    generations,
    note: 'title is null when neither the gallery DOM nor this process\'s job history has it (e.g. generations from before this MCP server started).',
  };
}
