import { navigateToGeneration } from '../browser/gallery.js';
import { fetchProjectContents } from '../browser/flow-api.js';
import { mergeHistorySteps, getGeneration } from '../utils/media-index.js';
import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

// Deliberately lives here and not inside gallery.js's navigateToGeneration:
// gallery.js is a pure DOM-reading module, and putting a disk write inside it
// would make every navigation a persistence side-effect with no way to opt out.
//
// This is what makes the index hybrid rather than merely a write-log. Anything
// done outside this MCP — the user's own browser, a second session sharing the
// same Chrome — is picked up the moment the generation is opened here.

function idsFromUrl(url) {
  return {
    editId: url.split('/edit/')[1]?.split(/[/?#]/)[0] || null,
    projectId: url.split('/project/')[1]?.split(/[/?#]/)[0] || null,
  };
}

// Reads a generation's steps from Flow's API (one row per media item, each
// with its own prompt) instead of the history panel, which no longer carries
// media ids in its DOM. Works from any page inside the project — no navigation.
export async function syncCurrent(page, editIdArg = null, projectIdArg = null) {
  const url = page.url();
  const { editId: fromUrl, projectId: fromUrlProj } = idsFromUrl(url);
  const editId = editIdArg || fromUrl;
  const projectId = projectIdArg || fromUrlProj;
  if (!editId || !projectId) return null;

  const { generations, media } = await fetchProjectContents(page, projectId);
  const gen = generations.find(g => g.editId === editId);
  if (!gen) {
    logger.warn('Generation not found in project, skipping step sync', { editId, projectId });
    return null;
  }
  const title = gen.title || null;
  const steps = media
    .filter(m => m.editId === editId)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    .map((m, index) => ({ index, mediaId: m.mediaId, prompt: m.prompt }));

  const editUrl = `https://flow.google.com/project/${projectId}/edit/${editId}`;
  mergeHistorySteps(editId, steps, { editUrl, projectId, title });
  return { editId, projectId, editUrl, title, stepCount: steps.length };
}

export async function openAndSync(page, { id, url } = {}) {
  const editId = id || url?.split('/edit/')[1]?.split(/[/?#]/)[0] || null;
  if (!editId) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'openAndSync requires either id or url.');
  }

  let projectId = url ? idsFromUrl(url).projectId : null;
  if (!projectId) {
    const existing = getGeneration(editId);
    if (existing?.projectId) {
      projectId = existing.projectId;
    } else {
      const currentProj = idsFromUrl(page.url()).projectId;
      if (currentProj) {
        const { generations } = await fetchProjectContents(page, currentProj).catch(() => ({ generations: [] }));
        if (generations.some(g => g.editId === editId)) {
          projectId = currentProj;
        }
      }
    }
  }

  if (!projectId) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS,
      `Cannot sync generation "${editId}": unknown project. Open the project first or provide a URL.`);
  }

  if (!page.url().includes(`/project/${projectId}`)) {
    await page.goto(`https://flow.google.com/project/${projectId}`, { waitUntil: 'load', timeout: 30000 });
  }

  return syncCurrent(page, editId, projectId);
}
