import { navigateToGeneration, listHistorySteps, getGenerationTitle } from '../browser/gallery.js';
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

export async function syncCurrent(page) {
  const url = page.url();
  const { editId, projectId } = idsFromUrl(url);
  if (!editId) return null;

  const [title, steps] = await Promise.all([
    getGenerationTitle(page).catch(() => null),
    listHistorySteps(page).catch(() => []),
  ]);

  if (!steps.length) {
    logger.warn('Sync found no history steps on an /edit/ page — nothing recorded for this generation', { editId });
  }

  mergeHistorySteps(editId, steps, { editUrl: url, projectId, title });
  return { editId, projectId, editUrl: url, title, stepCount: steps.length };
}

export async function openAndSync(page, { id, url } = {}) {
  if (id || url) await navigateToGeneration(page, { id, url });
  return syncCurrent(page);
}
