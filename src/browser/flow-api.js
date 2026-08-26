import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

// Flow's own project-load endpoint, the one the gallery page calls on mount.
// Confirmed live: a single authenticated GET returns the entire project — every
// workflow (= generation) with its display title, and every media item with the
// full prompt that produced it.
//
// This is strictly better than scraping the gallery grid, which carries NO text
// at all in the DOM (probed: tiles are empty until hovered, and a hover only
// ever reveals one tile at a time). __NEXT_DATA__ does not carry it either —
// 414 KB with neither "prompt" nor "title" in it.
//
// Confirmed on this project: 174 workflows, 174 with a title, 557 media, 303
// carrying a prompt (the rest are upscales and other derived assets that never
// had one of their own). No base64 image payloads.
const ENDPOINT = 'https://labs.google/fx/api/trpc/flow.projectInitialData';

export async function fetchProjectContents(page, projectId) {
  if (!projectId) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'projectId is required to fetch project contents.');
  const input = encodeURIComponent(JSON.stringify({ json: { projectId } }));
  const res = await page.request.get(`${ENDPOINT}?input=${input}`, { timeout: 30000 });
  if (!res.ok()) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      `Flow's project endpoint returned ${res.status()}. It may have moved or the session may have expired.`);
  }
  const body = await res.json();
  const contents = body?.result?.data?.json?.projectContents;
  if (!contents) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      'Flow returned a project payload in an unexpected shape — result.data.json.projectContents is missing.');
  }
  const workflows = contents.workflows || [];
  const media = contents.media || [];
  logger.info('Fetched project contents from Flow', { projectId, workflows: workflows.length, media: media.length });

  // workflow.name is the /edit/{id} route id — verified live against ids this
  // MCP had just generated. That is what makes this joinable with the catalog.
  return {
    projectId,
    generations: workflows.map(w => ({
      editId: w.name,
      title: w.metadata?.displayName || null,
      createdAt: w.metadata?.createTime || null,
      updatedAt: w.metadata?.updateTime || null,
      primaryMediaId: w.metadata?.primaryMediaId || null,
    })),
    media: media.map(m => ({
      mediaId: m.name,
      editId: m.workflowId,
      stepId: m.workflowStepId || null,
      prompt: m.mediaMetadata?.requestData?.promptInputs?.[0]?.textInput || null,
      createdAt: m.mediaMetadata?.createTime || null,
      dimensions: m.image?.dimensions || null,
    })),
  };
}
