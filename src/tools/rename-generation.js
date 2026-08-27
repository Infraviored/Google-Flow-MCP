import { getPage } from '../browser/connect.js';
import { renameWorkflow } from '../browser/flow-api.js';
import { getMostRecentProject } from '../navigation/project-navigator.js';
import { loadProjectCache, saveProjectCache } from '../utils/media-index.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

function resolveEditId(item, page) {
  if (item.id) return item.id;
  if (item.url) return item.url.split('/edit/')[1]?.split(/[/?#]/)[0] || null;
  if (/\/edit\//.test(page.url())) return page.url().split('/edit/')[1]?.split(/[/?#]/)[0] || null;
  return null;
}

function resolveProjectId(item, defaultProjectId, page) {
  return item.project_id
    || defaultProjectId
    || (item.url ? item.url.split('/project/')[1]?.split(/[/?#]/)[0] : null)
    || (/\/project\//.test(page.url()) ? page.url().split('/project/')[1]?.split(/[/?#]/)[0] : null)
    || getMostRecentProject()?.id
    || null;
}

// A plain metadata PATCH — see renameWorkflow's own comment for how the
// endpoint was found. No navigation is needed: the target generation and
// project are both named in the request itself, so this works regardless of
// what the browser currently has open, unlike flow_edit_generation.
//
// Two shapes: a single {id/url, title} rename, or a batch via `renames: [...]`
// — each entry can carry its own id/url/title/project_id, falling back to the
// top-level ones (a shared project_id is the common case: renaming several
// generations in the same project in one call). One item failing does not
// abort the rest; each result reports its own outcome.
export async function handleRenameGeneration(args = {}) {
  const page = getPage();
  const items = Array.isArray(args.renames) && args.renames.length
    ? args.renames
    : [{ id: args.id, url: args.url, title: args.title, project_id: args.project_id }];

  const dirtyCaches = new Map(); // projectId -> cache object, flushed once at the end

  const results = [];
  for (const item of items) {
    const title = item.title || args.title;
    try {
      if (!title) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'title is required.');

      const editId = resolveEditId(item, page);
      if (!editId) {
        throw new FlowError(ErrorCodes.INVALID_PARAMS,
          'No id/url given and not currently on a generation\'s /edit/ page.');
      }

      const projectId = resolveProjectId(item, args.project_id, page);
      if (!projectId) {
        throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Could not resolve a project id — pass project_id explicitly.');
      }

      await renameWorkflow(page, { editId, projectId, title });

      let cache = dirtyCaches.get(projectId);
      if (!cache) {
        cache = loadProjectCache(projectId);
        if (cache) dirtyCaches.set(projectId, cache);
      }
      const gen = cache?.generations?.find(g => g.editId === editId);
      if (gen) gen.title = title;

      results.push({ status: 'success', editId, projectId, title });
    } catch (err) {
      results.push({ status: 'error', id: item.id || null, url: item.url || null, title: title || null, error: err.message });
    }
  }

  // flow_index reads from these cache files — patch and flush once per
  // touched project rather than on every single rename in the batch.
  for (const cache of dirtyCaches.values()) saveProjectCache(cache);

  if (!Array.isArray(args.renames)) return results[0];
  return {
    status: results.every(r => r.status === 'success') ? 'success' : 'partial',
    count: results.length,
    succeeded: results.filter(r => r.status === 'success').length,
    results,
  };
}
