import { getPage } from '../browser/connect.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { navigateToGeneration, followUpEdit, getGenerationTitle } from '../browser/gallery.js';
import { getPromptInput, fillPrompt } from '../browser/composer.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { resolveTextParam } from '../utils/file-manager.js';
import { recordGeneration, recordStep } from '../utils/media-index.js';

export async function handleEditGeneration(args = {}) {
  args.instruction = resolveTextParam(args.instruction, args.instruction_file, { paramName: 'instruction', fileParamName: 'instruction_file' });

  const page = getPage();

  if (args.project_id || args.project_name || args.campaign) {
    await ensureProjectInContext(page, {
      project_id: args.project_id,
      name: args.project_name,
      campaign: args.campaign,
    });
  }

  if (args.id || args.url) {
    await navigateToGeneration(page, { id: args.id, url: args.url });
  } else if (!/\/edit\//.test(page.url())) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      'Not on a generation\'s /edit/ page and no id/url given — call with an id (from flow_list_generations) ' +
      'or flow_open_generation first.');
  }

  const autoConfirm = args.auto_confirm === true;

  if (!autoConfirm) {
    // SAFE MODE: fill the instruction only, don't click Create — no credits spent.
    const promptInput = await getPromptInput(page);
    if (!promptInput) {
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find the follow-up edit composer on the edit page.');
    }
    await fillPrompt(page, promptInput, args.instruction);
    return {
      status: 'ready_for_confirmation',
      editUrl: page.url(),
      instruction: args.instruction,
      message: 'Instruction is set in the edit composer. No credits spent. ' +
        'To apply and spend credits, call again with auto_confirm=true.',
      screenshot: await takeScreenshot(page, 'edit-generation-ready-for-confirmation'),
    };
  }

  const newMediaIds = await followUpEdit(page, args.instruction, {
    timeoutMs: get('generationTimeoutMs', 120000),
  });

  const editId = page.url().split('/edit/')[1]?.split(/[/?#]/)[0];
  const title = await getGenerationTitle(page).catch(() => null);
  recordGeneration({ editId, editUrl: page.url(), title });
  // The instruction IS the prompt for the step this edit just produced. Without
  // recording it here there is no way to tell later which of a generation's
  // steps is the black-background pass and which is the white one.
  for (const mediaId of newMediaIds || []) {
    recordStep({ editId, mediaId, prompt: args.instruction, source: 'edit' });
  }

  return {
    status: 'success',
    editUrl: page.url(),
    instruction: args.instruction,
    new_media_ids: newMediaIds,
    credits_consumed: true,
  };
}
