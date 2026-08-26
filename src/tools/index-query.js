import { getPage, isBrowserConnected } from '../browser/connect.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { fetchProjectContents } from '../browser/flow-api.js';
import { getMostRecentProject } from '../navigation/project-navigator.js';
import {
  view,
  findByTitle,
  findByMediaId,
  listGenerationsIndexed,
  listOrphanDownloads,
  renderMarkdown,
  indexLocation,
  saveProjectCache,
  loadAllProjectCaches,
} from '../utils/media-index.js';
import { projectCachePath } from '../utils/paths.js';

async function refreshCacheIfPossible(projectId = null) {
  if (!isBrowserConnected()) return false;
  const page = getPage();
  const effectiveProjectId =
    projectId ||
    page.url().split('/project/')[1]?.split(/[/?#]/)[0] ||
    getMostRecentProject()?.id;
  if (!effectiveProjectId) return false;
  try {
    const contents = await fetchProjectContents(page, effectiveProjectId);
    saveProjectCache(contents);
    return contents;
  } catch {
    return false;
  }
}

// One read surface over the catalog. Reads hit the local project cache joined
// with downloads.json, refreshing from Flow's project endpoint when requested
// or when the cache is empty.
export async function handleIndexQuery(args = {}) {
  const format = args.format || 'json';

  // Explicit sync of a project from Flow's own endpoint.
  if (args.sync_project) {
    if (!isBrowserConnected()) {
      throw new FlowError(
        ErrorCodes.BROWSER_NOT_RUNNING,
        'Cannot sync project without a connected browser. Connect first via flow_connect.'
      );
    }
    const page = getPage();
    const projectId =
      args.project_id || page.url().split('/project/')[1]?.split(/[/?#]/)[0] || getMostRecentProject()?.id;
    if (!projectId) {
      throw new FlowError(
        ErrorCodes.INVALID_PARAMS,
        'No project in current URL or args — pass project_id, or open a project first.'
      );
    }
    const contents = await fetchProjectContents(page, projectId);
    saveProjectCache(contents);
    return {
      projectId,
      fetched: { generations: contents.generations.length, media: contents.media.length },
      cachePath: projectCachePath(projectId),
      downloadsPath: indexLocation(),
    };
  }

  // If there are no caches at all on disk and a browser is connected, seed the cache.
  const initialCaches = loadAllProjectCaches();
  if (!initialCaches.length && isBrowserConnected()) {
    await refreshCacheIfPossible(args.project_id);
  }

  // Explicit refresh requested
  if (args.refresh === true) {
    await refreshCacheIfPossible(args.project_id);
  }

  if (args.orphans) {
    const files = listOrphanDownloads();
    return { downloadsPath: indexLocation(), orphanCount: files.length, orphans: files };
  }

  let editId = args.id || null;

  if (!editId && args.url) {
    editId = args.url.split('/edit/')[1]?.split(/[/?#]/)[0] || null;
  }

  if (!editId && args.media_id) {
    let found = findByMediaId(args.media_id);
    if (!found && isBrowserConnected() && args.refresh !== false) {
      await refreshCacheIfPossible(args.project_id);
      found = findByMediaId(args.media_id);
    }
    editId = found?.editId || null;
    if (!editId) {
      throw new FlowError(
        ErrorCodes.INVALID_PARAMS,
        `No indexed generation contains media id "${args.media_id}".`
      );
    }
  }

  if (!editId && args.title) {
    let hits = findByTitle(args.title);
    if (!hits.length && isBrowserConnected() && args.refresh !== false) {
      await refreshCacheIfPossible(args.project_id);
      hits = findByTitle(args.title);
    }
    if (!hits.length) {
      throw new FlowError(
        ErrorCodes.INVALID_PARAMS,
        `No indexed generation matches title "${args.title}". Use flow_index with no arguments to list what is known.`
      );
    }
    if (hits.length > 1) return { ambiguous: true, matches: hits };
    editId = hits[0].editId;
  }

  if (!editId) {
    if (format === 'markdown') return { markdown: renderMarkdown() };
    return {
      downloadsPath: indexLocation(),
      generations: listGenerationsIndexed({ limit: args.limit || 20 }),
    };
  }

  let record = view(editId, { fullPrompts: args.full_prompts, step: args.step ?? null });
  if (!record && isBrowserConnected() && args.refresh !== false) {
    await refreshCacheIfPossible(args.project_id);
    record = view(editId, { fullPrompts: args.full_prompts, step: args.step ?? null });
  }

  if (!record) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `Nothing indexed for generation "${editId}".`);
  }

  if (format === 'markdown') return { markdown: renderMarkdown([editId]) };
  if (format === 'compact') {
    return {
      compact: (record.steps || []).map((s) => {
        const res = (s.dl || []).map((d) => d.res).join(',');
        return `${s.n ?? '?'} ${s.mediaId?.slice(0, 8)} [${res || '-'}] ${s.variant || ''} ${s.prompt || ''}`.trim();
      }),
    };
  }
  return record;
}
