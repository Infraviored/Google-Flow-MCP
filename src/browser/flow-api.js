import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

// Flow's own project-load endpoint, the one the gallery page calls on mount.
// A single authenticated GET returns the entire project — every workflow
// (= generation) with its display title, and every media item with the full
// prompt that produced it.
//
// This replaced scraping the gallery grid, which carries NO text at all: tiles
// are empty until hovered, and a hover reveals one title at a time.
// __NEXT_DATA__ does not carry it either (414 KB, neither "prompt" nor "title").
const PROJECT_ENDPOINT = 'https://labs.google/fx/api/trpc/flow.projectInitialData';
const UPSAMPLE_ENDPOINT = 'https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage';

// reCAPTCHA Enterprise site key, read out of Flow's own bundle.
const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// Measured, not guessed: grecaptcha.enterprise.execute was wrapped at runtime
// and a real 2K click observed. The page uses a single generic action for this,
// not an upscale-specific one. Getting this wrong yields HTTP 403
// PUBLIC_ERROR_UNUSUAL_ACTIVITY — a valid token failing assessment, which reads
// like bot detection but is not.
const RECAPTCHA_ACTION = 'IMAGE_GENERATION';

// Fallback only. The live value comes from the project payload where present;
// this is the tier of the account the request was captured on.
const FALLBACK_PAYGATE_TIER = 'PAYGATE_TIER_ONE';

// workflowStepId is a base64 protobuf varint: field 1, value = the step number.
// CAE -> 1, CAI -> 2, CAM -> 3, CAQ -> 4. That gives the edit chain in exact
// order without touching the history side panel.
export function decodeStepOrdinal(workflowStepId) {
  if (!workflowStepId) return null;
  try {
    const buf = Buffer.from(workflowStepId, 'base64');
    return buf.length >= 2 && buf[0] === 8 ? buf[1] : null;
  } catch {
    return null;
  }
}

export async function fetchProjectContents(page, projectId) {
  if (!projectId) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'projectId is required to fetch project contents.');
  const input = encodeURIComponent(JSON.stringify({ json: { projectId } }));
  const res = await page.request.get(`${PROJECT_ENDPOINT}?input=${input}`, { timeout: 30000 });
  if (!res.ok()) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      `Flow's project endpoint returned ${res.status()}. It may have moved, or the session may have expired.`);
  }
  const body = await res.json();
  const root = body?.result?.data?.json;
  const contents = root?.projectContents;

  // This endpoint is undocumented. If its shape drifts, fail loudly rather than
  // quietly reporting an empty project, which would look like "you have nothing"
  // instead of "we can no longer read it".
  if (!contents || !Array.isArray(contents.workflows)) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      'Flow returned a project payload in an unexpected shape — result.data.json.projectContents.workflows is missing. ' +
      'The endpoint has probably changed.');
  }

  const workflows = contents.workflows;
  const media = contents.media || [];
  logger.info('Fetched project contents from Flow', { projectId, workflows: workflows.length, media: media.length });

  // workflow.name is the /edit/{id} route id — verified against ids this MCP had
  // just generated. That is what makes the payload joinable with local records.
  return {
    projectId,
    projectName: root?.projectName || null,
    fetchedAt: new Date().toISOString(),
    paygateTier: root?.userData?.paygateTier || null,
    // Flow's own model registry, so the display-name -> request-key mapping is
    // read rather than hardcoded and survives Flow adding or renaming models.
    imageModels: (root?.modelConfig?.imageModelFamilies || []).map(f => ({
      id: f.id,
      displayName: (f.displayName || '').replace(/^[^\w]+\s*/, ''),
      key: f.usages?.[0]?.key || null,
      maxImageReferences: f.usages?.[0]?.maxImageReferences ?? null,
    })).filter(m => m.key),
    generations: workflows.map(w => ({
      editId: w.name,
      title: w.metadata?.displayName || null,
      createdAt: w.metadata?.createTime || null,
      updatedAt: w.metadata?.updateTime || null,
      primaryMediaId: w.metadata?.primaryMediaId || null,
    })),
    media: media.map(m => {
      const prompt = m.mediaMetadata?.requestData?.promptInputs?.[0]?.textInput || null;
      const dimensions = m.image?.dimensions || null;
      return {
        mediaId: m.name,
        editId: m.workflowId,
        step: decodeStepOrdinal(m.workflowStepId),
        prompt,
        dimensions,
        bytes: m.mediaMetadata?.mediaBlobSize ? Number(m.mediaMetadata.mediaBlobSize) : null,
        seed: m.image?.generatedImage?.seed ?? null,
        mediaGenerationId: m.image?.generatedImage?.mediaGenerationId || null,
        createdAt: m.mediaMetadata?.createTime || null,
        // Which medium this one was made FROM. Every derived medium names its
        // source, so an upscale can be matched to the exact step it belongs to
        // rather than to "some derived medium of this generation" — which
        // silently served the upscale of a different step.
        sourceMediaId: m.mediaMetadata?.requestData?.imageGenerationRequestData
          ?.imageGenerationImageInputs?.[0]?.mediaId || null,
        // Measured: carrying a prompt and carrying dimensions coincide exactly
        // (303 of 557 had both, 254 had neither). Media with neither are
        // derived — upscales and the like. Flagged rather than classified,
        // since only a fetch reveals what one actually is.
        derived: !prompt && !dimensions,
      };
    }),
  };
}

export function mediaDownloadUrl(mediaId) {
  return `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`;
}

// Triggers Flow's own upscale and returns the new medium, which is then
// fetchable by id like any other. Proven end to end: returns 200 and yields a
// real 2048x2048 image, with no download button, no 60-second poll and no CDP
// blob handling.
//
// Runs inside the page rather than via page.request because both credentials
// only exist there: the session's access token, and a fresh reCAPTCHA token
// that only Flow's own grecaptcha instance can mint. Nothing here pretends to
// be a browser it is not — the call is made from the real, signed-in page.
export async function upsampleImage(page, { mediaId, projectId, resolution = '2K', paygateTier } = {}) {
  if (!mediaId) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'mediaId is required to upscale.');
  if (!projectId) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'projectId is required to upscale.');

  const target = `UPSAMPLE_IMAGE_RESOLUTION_${resolution.toUpperCase()}`;

  const result = await page.evaluate(async (args) => {
    if (!window.grecaptcha?.enterprise?.execute) {
      return { ok: false, stage: 'recaptcha', error: 'grecaptcha.enterprise is not available on this page.' };
    }
    let token;
    try {
      token = await window.grecaptcha.enterprise.execute(args.siteKey, { action: args.action });
    } catch (e) {
      return { ok: false, stage: 'recaptcha', error: String(e) };
    }

    let accessToken;
    try {
      accessToken = (await (await fetch('/fx/api/auth/session')).json())?.access_token;
    } catch (e) {
      return { ok: false, stage: 'session', error: String(e) };
    }
    if (!accessToken) return { ok: false, stage: 'session', error: 'No access_token in the session response.' };

    const res = await fetch(args.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        mediaId: args.mediaId,
        targetResolution: args.target,
        clientContext: {
          recaptchaContext: { token, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
          projectId: args.projectId,
          tool: 'PINHOLE',
          userPaygateTier: args.paygateTier,
          sessionId: ';' + Date.now(),
        },
      }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep the raw text for the error */ }
    return { ok: res.ok, status: res.status, json, text: json ? null : text.slice(0, 500) };
  }, {
    siteKey: RECAPTCHA_SITE_KEY,
    action: RECAPTCHA_ACTION,
    endpoint: UPSAMPLE_ENDPOINT,
    mediaId,
    projectId,
    target,
    paygateTier: paygateTier || FALLBACK_PAYGATE_TIER,
  });

  if (!result.ok) {
    // Distinctive and worth naming: the reCAPTCHA assessment rejected an
    // otherwise-valid token. In practice that means the action name this file
    // hardcodes no longer matches the one Flow uses. Callers fall back to the
    // UI flow on this rather than surfacing it raw.
    const reason = result.json?.error?.details?.[0]?.reason;
    if (reason === 'PUBLIC_ERROR_UNUSUAL_ACTIVITY') {
      throw new FlowError(ErrorCodes.UPSCALE_FAILED,
        'Flow rejected the upscale\'s reCAPTCHA assessment (PUBLIC_ERROR_UNUSUAL_ACTIVITY). ' +
        `The action name this build sends ("${RECAPTCHA_ACTION}") has most likely changed on Flow's side.`,
        { stage: result.stage, status: result.status });
    }
    throw new FlowError(ErrorCodes.UPSCALE_FAILED,
      `Upscale request failed${result.status ? ` (HTTP ${result.status})` : ''}: ${result.error || result.json?.error?.message || result.text || 'unknown error'}`,
      { stage: result.stage, status: result.status });
  }

  const newMediaId = result.json?.media?.name;
  if (!newMediaId) {
    throw new FlowError(ErrorCodes.UPSCALE_FAILED, 'Upscale returned 200 but no media id in the response.');
  }
  logger.info('Upscaled via API', { mediaId, newMediaId, resolution });
  return {
    mediaId: newMediaId,
    editId: result.json?.media?.workflowId || null,
    step: decodeStepOrdinal(result.json?.media?.workflowStepId),
  };
}

const MAX_RATE_LIMIT_RETRIES = 3;

const RATIO_TO_ENUM = {
  '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
  '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
  '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE',
  '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR',
};

// Fallback only — the live registry in the project payload is preferred, and
// these were read out of it rather than invented.
const FALLBACK_MODEL_KEYS = {
  'Nano Banana Pro': 'GEM_PIX_2',
  'Nano Banana 2': 'NARWHAL',
  'Nano Banana 2 Lite': 'HARBOR_SEAL',
};

export function resolveImageModelKey(cache, displayName) {
  const want = (displayName || '').trim().toLowerCase();
  const hit = (cache?.imageModels || []).find(
    m => m.displayName.toLowerCase() === want || m.id.toLowerCase() === want
  );
  return hit?.key || FALLBACK_MODEL_KEYS[displayName] || null;
}

// One call covers both a fresh generation and a follow-up edit — Flow uses the
// same endpoint for both. An edit is distinguished only by naming the workflow
// it belongs to and attaching the image it starts from.
//
// Compared with driving the composer, this returns the new media id AND its
// workflow id directly, so none of the DOM tile-matching guesswork applies: the
// answer comes from the server rather than from watching a virtualized grid.
export async function generateImages(page, {
  projectId, prompt, modelKey, ratio, seed = null, count = 1,
  workflowId = null, baseMediaId = null, referenceMediaIds = [], attempt = 0,
} = {}) {
  if (!projectId) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'projectId is required to generate.');
  if (!prompt) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt is required to generate.');
  if (!modelKey) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Could not resolve an image model key.');

  // Newlines are meaningless to the API and the UI path strips them too (Enter
  // submits in the composer), so both paths send the same single line.
  const text = String(prompt).replace(/\s+/g, ' ').trim();

  // The UI sends UNSPECIFIED on an edit, which is the likeliest cause of edits
  // silently coming back reshaped. Send the real ratio when we know it.
  const aspect = RATIO_TO_ENUM[ratio] || 'IMAGE_ASPECT_RATIO_UNSPECIFIED';

  const imageInputs = [];
  if (baseMediaId) imageInputs.push({ imageInputType: 'IMAGE_INPUT_TYPE_BASE_IMAGE', name: baseMediaId });
  for (const id of referenceMediaIds) imageInputs.push({ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: id });

  const result = await page.evaluate(async (args) => {
    if (!window.grecaptcha?.enterprise?.execute) {
      return { ok: false, stage: 'recaptcha', error: 'grecaptcha.enterprise is not available on this page.' };
    }
    let token;
    try {
      token = await window.grecaptcha.enterprise.execute(args.siteKey, { action: args.action });
    } catch (e) {
      return { ok: false, stage: 'recaptcha', error: String(e) };
    }
    let accessToken;
    try {
      accessToken = (await (await fetch('/fx/api/auth/session')).json())?.access_token;
    } catch (e) {
      return { ok: false, stage: 'session', error: String(e) };
    }
    if (!accessToken) return { ok: false, stage: 'session', error: 'No access_token in the session response.' };

    const clientContext = {
      recaptchaContext: { token, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
      projectId: args.projectId,
      tool: 'PINHOLE',
      ...(args.workflowId ? { workflowId: args.workflowId } : {}),
      sessionId: ';' + Date.now(),
    };
    const one = {
      clientContext,
      imageModelName: args.modelKey,
      imageAspectRatio: args.aspect,
      structuredPrompt: { parts: [{ text: args.text }] },
      imageInputs: args.imageInputs,
      ...(args.seed !== null ? { seed: args.seed } : {}),
    };

    const res = await fetch(`https://aisandbox-pa.googleapis.com/v1/projects/${args.projectId}/flowMedia:batchGenerateImages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        clientContext,
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        useNewMedia: true,
        requests: Array.from({ length: args.count }, () => one),
      }),
    });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* keep raw for the error */ }
    return { ok: res.ok, status: res.status, json, text: json ? null : body.slice(0, 500) };
  }, {
    siteKey: RECAPTCHA_SITE_KEY, action: RECAPTCHA_ACTION, projectId, workflowId,
    modelKey, aspect, text, seed, count: Math.min(Math.max(count, 1), 4), imageInputs,
  });

  if (!result.ok) {
    // 429 means Flow declined before doing any work — no credits were spent, so
    // retrying cannot double-charge. Seen when several generations and upscales
    // are fired in quick succession, which is exactly what this path enables.
    if (result.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const waitMs = 5000 * Math.pow(2, attempt);
      logger.warn('Flow rate-limited the generation, backing off', { attempt: attempt + 1, waitMs });
      await page.waitForTimeout(waitMs);
      return generateImages(page, {
        projectId, prompt, modelKey, ratio, seed, count,
        workflowId, baseMediaId, referenceMediaIds, attempt: attempt + 1,
      });
    }
    if (result.status === 429) {
      throw new FlowError(ErrorCodes.GOOGLE_LIMIT_REACHED,
        `Flow rate-limited this generation after ${MAX_RATE_LIMIT_RETRIES + 1} attempts. ` +
        'This is a rate limit, not a credit balance — check flow_status and retry in a minute.',
        { status: 429 });
    }
    const reason = result.json?.error?.details?.[0]?.reason;
    if (reason === 'PUBLIC_ERROR_UNUSUAL_ACTIVITY') {
      throw new FlowError(ErrorCodes.GENERATION_BLOCKED,
        'Flow rejected the generation\'s reCAPTCHA assessment (PUBLIC_ERROR_UNUSUAL_ACTIVITY). ' +
        `The action name this build sends ("${RECAPTCHA_ACTION}") has most likely changed on Flow's side.`,
        { stage: result.stage, status: result.status });
    }
    throw new FlowError(ErrorCodes.GENERATION_BLOCKED,
      `Generation request failed${result.status ? ` (HTTP ${result.status})` : ''}: ` +
      `${result.error || result.json?.error?.message || result.text || 'unknown error'}`,
      { stage: result.stage, status: result.status });
  }

  const media = (result.json?.media || []).map(m => ({
    mediaId: m.name,
    editId: m.workflowId,
    seed: m.image?.generatedImage?.seed ?? null,
  })).filter(m => m.mediaId);

  if (!media.length) {
    throw new FlowError(ErrorCodes.GENERATION_BLOCKED, 'Generation returned 200 but no media in the response.');
  }
  logger.info('Generated via API', { count: media.length, modelKey, aspect, isEdit: !!workflowId });
  return media;
}
