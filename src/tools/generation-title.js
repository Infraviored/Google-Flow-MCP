import { jobQueue } from '../queue/job-queue.js';

// Row caption titles are only mounted in the DOM for the first tile of a
// multi-output batch (confirmed live), and don't exist at all on an /edit/
// page's own DOM — backfill from this process's completed-job history,
// which tracks each generation's prompt against its edit-route ids (see
// generate-image.js's editIds). Returns null if neither source has it (e.g.
// generations from before this MCP server started).
export function backfillTitle(domTitle, tileId) {
  if (domTitle) return domTitle;
  for (const job of jobQueue.getCompletedJobs()) {
    if (job.result?.editIds?.includes(tileId)) {
      return job.result.prompt || null;
    }
  }
  return null;
}
