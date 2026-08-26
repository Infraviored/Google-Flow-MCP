import { getPage } from '../browser/connect.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { listGenerations } from '../browser/gallery.js';
import { loadProjectCache, loadAllProjectCaches } from '../utils/media-index.js';

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

  const projectId = page.url().split('/project/')[1]?.split(/[/?#]/)[0] || args.project_id;
  const projectCache = projectId ? loadProjectCache(projectId) : null;
  const allCaches = projectCache ? [projectCache] : loadAllProjectCaches();

  const titleByEditId = new Map();
  for (const cache of allCaches) {
    for (const g of cache.generations || []) {
      if (g.editId && g.title) titleByEditId.set(g.editId, g.title);
    }
  }

  const generations = tiles.map((t) => ({
    ...t,
    title: titleByEditId.get(t.id) || null,
    editUrl: t.editUrl ? `https://labs.google/fx${t.editUrl.startsWith('/fx') ? t.editUrl.slice(3) : t.editUrl}` : null,
  }));

  return {
    status: 'success',
    count: generations.length,
    generations,
  };
}
