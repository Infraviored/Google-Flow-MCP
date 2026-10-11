import { navigateToGeneration } from '../browser/gallery.js';
import { fetchProjectContents } from '../browser/flow-api.js';
import { mergeHistorySteps } from '../utils/media-index.js';
import { logger } from '../utils/logger.js';

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
export async function syncCurrent(page, editIdArg = null) {
  const url = page.url();
  const { editId: fromUrl, projectId } = idsFromUrl(url);
  const editId = editIdArg || fromUrl;
  if (!editId || !projectId) return null;

  const { generations, media } = await fetchProjectContents(page, projectId);
  const title = generations.find(g => g.editId === editId)?.title || null;
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
  if (url && !page.url().includes(`/project/${idsFromUrl(url).projectId}`)) {
    await navigateToGeneration(page, { url });
  }
  return syncCurrent(page, editId);
}
