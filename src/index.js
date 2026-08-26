#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from './utils/logger.js';
import { launchKiaraProfile, navigateToFlow, getDefaultProfileKey, getProfileEntry, getAllProfiles } from './browser/launch-profile.js';
import { getPage, getBrowser, setBrowser, closeBrowser as closeBrowserConnection, getActiveProfileKey, getLaunchMode } from './browser/connect.js';
import { verifyAccount as checkAccount } from './browser/account-check.js';
import { updateConfig } from './utils/config.js';
import { handleFlowStatus } from './tools/flow-status.js';
import { handleGenerateImage } from './tools/generate-image.js';
import { handleGenerateVideo } from './tools/generate-video.js';
import { handleDownloadLatest } from './tools/download-latest.js';
import { handleCreateCharacter } from './tools/create-character.js';
import { handleUseGridArchitect } from './tools/grid-architect.js';
import { handleDiscoverUi } from './tools/discover-ui.js';
import { handleChangeSettings } from './tools/change-settings.js';
import { handleListGenerations } from './tools/list-generations.js';
import { handleEditGeneration } from './tools/edit-generation.js';
import { handleIndexQuery } from './tools/index-query.js';
import { getMostRecentProject } from './navigation/project-navigator.js';
import { jobQueue } from './queue/job-queue.js';
import { takeScreenshot } from './utils/screenshots.js';
import fs from 'fs';
import path from 'path';

// Repeated verbatim across nine tools before this; each copy also cost tokens
// on every single request. One definition, spread where needed.
const PROJECT_PARAMS = {
  project_id: { type: 'string', description: 'Project id from flow_list_projects.' },
  project_name: { type: 'string', description: 'Project name; created if no match.' },
  campaign: { type: 'string', description: 'Campaign id for project matching.' },
};

const TOOL_DEFINITIONS = [
  {
    name: 'flow_connect',
    description: 'Launch Chrome on a persistent profile and open Google Flow. First connect on a new profile needs a visible window for Google sign-in; later ones reuse the saved session.',
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'Fastest, but reCAPTCHA-risky and 2K upscale does not work. Default false.', default: false },
        virtual_display: { type: 'boolean', description: 'Headed Chrome on an off-screen Xvfb display: same fingerprint, does not steal focus. Best for unattended runs.', default: false },
        open_flow: { type: 'boolean', description: 'Navigate to Flow after connecting. Default true.', default: true },
        project_id: { type: 'string', description: 'Open this project directly instead of the last-used one.' },
        profile: { type: 'string', description: 'Which persistent Chrome profile (= which Google account) to use.' },
        source_profile: { type: 'string', description: 'Seed a new profile from an existing signed-in system Chrome profile directory, e.g. "Default".' },
      },
    },
  },
  {
    name: 'flow_disconnect',
    description: 'Close the browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_status',
    description: 'Report browser, account, launch mode, and job-queue state. Also the place to clear a stuck queue.',
    inputSchema: {
      type: 'object',
      properties: {
        history_limit: { type: 'number', description: 'Include this many recent finished jobs. Default 0.', default: 0 },
        reset_queue: { type: 'boolean', description: 'Force-clear a job that never finished. Rarely needed — stale jobs are now reaped automatically.', default: false },
      },
    },
  },
  {
    name: 'flow_discover_ui',
    description: 'Navigate to a Flow page and dump its interactive elements. Diagnostic — use when a selector appears to have broken.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Which page: home, project, characters, tools-gallery.', default: 'home' },
        url: { type: 'string', description: 'Explicit URL instead of a named page.' },
      },
    },
  },
  {
    name: 'flow_generate_image',
    description: 'SPENDS CREDITS when auto_confirm is true. Starts a BRAND-NEW generation with no reference to any existing image — to revise one, use flow_edit_generation instead. Default prepares the prompt without generating.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt text. Max 1400 chars (Flow-enforced). Either this or prompt_file.' },
        prompt_file: { type: 'string', description: 'Path to a file holding the prompt; re-read on every call, so editing the file is cheaper than retyping it.' },
        model: { type: 'string', description: 'Nano Banana Pro, Nano Banana 2, or Nano Banana 2 Lite.', default: 'Nano Banana 2' },
        ratio: { type: 'string', description: '1:1, 16:9, 9:16, 4:3, 3:4.', default: '1:1' },
        quantity: { type: 'number', description: 'Variants in one billed batch, 1-4.', default: 1 },
        auto_confirm: { type: 'boolean', description: 'True clicks Generate and spends credits.', default: false },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images.' },
        ...PROJECT_PARAMS,
      },
    },
  },
  {
    name: 'flow_generate_video',
    description: 'Sets up a video generation but never confirms it — it cannot spend credits. Less proven than the image path.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt text.' },
        model: { type: 'string', description: 'Video model name.' },
        ratio: { type: 'string', description: '16:9 or 9:16.' },
        duration: { type: 'number', description: 'Seconds.' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images.' },
        ...PROJECT_PARAMS,
      },
    },
  },
  {
    name: 'flow_download_latest',
    description: 'Download a generation. Defaults to whatever is on screen; pass id to target one. 2K runs Flow\'s upscale and requires a headed browser.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Edit-route id to download instead of the current screen.' },
        resolution: { type: 'string', description: '1K (direct fetch) or 2K (UI upscale). 4K needs a paid plan.', default: '1K' },
        filename: { type: 'string', description: 'Save as this name in outputs/images/. Defaults to the generation title.' },
        media_id: { type: 'string', description: '1K only. Fetch one specific history step, including a superseded one — get it from flow_index.' },
        force: { type: 'boolean', description: 'Attempt a 2K upscale even headless, where it is known to fail.', default: false },
      },
    },
  },
  {
    name: 'flow_create_character',
    description: 'Create a Flow character from a name and description.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Character name.' },
        description: { type: 'string', description: 'Character description.' },
        reference_image: { type: 'string', description: 'Path to a reference image.' },
        ...PROJECT_PARAMS,
      },
      required: ['name'],
    },
  },
  {
    name: 'flow_use_grid_architect',
    description: 'Open the Grid Architect template and configure it inside its iframe.',
    inputSchema: {
      type: 'object',
      properties: {
        theme_prompt: { type: 'string', description: 'Overall theme.' },
        shot_prompts: { type: 'array', items: { type: 'string' }, description: 'Per-shot prompts.' },
        engine: { type: 'string', description: 'Engine name.' },
        ratio: { type: 'string', description: 'Aspect ratio.' },
        visual_logic: { type: 'string', description: 'Visual logic setting.' },
        ...PROJECT_PARAMS,
      },
    },
  },
  {
    name: 'flow_list_projects',
    description: 'List the workspace projects and which one is currently open.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_screenshot',
    description: 'Screenshot the current page to disk. The escape hatch when structured reads are not enough.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Filename stem.' } },
    },
  },
  {
    name: 'flow_change_settings',
    description: 'Read or set the composer ratio, model, and quantity. Called with no settings it just reads them back.',
    inputSchema: {
      type: 'object',
      properties: {
        ratio: { type: 'string', description: '1:1, 16:9, 9:16, 4:3, 3:4.' },
        model: { type: 'string', description: 'Model name.' },
        quantity: { type: 'number', description: 'Outputs per generation, 1-4.' },
        ...PROJECT_PARAMS,
      },
    },
  },
  {
    name: 'flow_list_generations',
    description: 'List generations in the current project gallery, newest first, with their ids and edit URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to return.', default: 20 },
        ...PROJECT_PARAMS,
      },
    },
  },
  {
    name: 'flow_edit_generation',
    description: 'SPENDS CREDITS when auto_confirm is true. Revises an existing generation in place, adding a step to its history rather than creating a new gallery entry. Earlier steps stay downloadable via flow_index.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'The change to make. Either this or instruction_file.' },
        instruction_file: { type: 'string', description: 'Path to a file holding the instruction; re-read on every call.' },
        id: { type: 'string', description: 'Generation to edit. Optional if already on its edit page.' },
        url: { type: 'string', description: 'Edit URL instead of an id.' },
        auto_confirm: { type: 'boolean', description: 'True clicks Create and spends credits.', default: false },
        ...PROJECT_PARAMS,
      },
    },
  },
  {
    name: 'flow_index',
    description: 'What do we already have? Answers it from a persistent catalog, refreshed from the live page when a browser is connected. Given a generation (by id, url, title, or media_id) returns each step of its edit history: the prompt behind it, a black/white variant hint, and every local file already downloaded for it with its resolution and whether that file still exists. With no arguments, lists known generations. Prompts come truncated unless full_prompts is set.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Edit-route id.' },
        url: { type: 'string', description: 'Edit URL.' },
        title: { type: 'string', description: 'Generation title, as shown in Flow\'s header. Returns all candidates if ambiguous.' },
        media_id: { type: 'string', description: 'Find the generation containing this media id.' },
        step: { type: 'number', description: 'Only this step, with its prompt untruncated.' },
        full_prompts: { type: 'boolean', description: 'Return every prompt in full.', default: false },
        format: { type: 'string', description: 'json (default), markdown for a clickable table, or compact for one line per step.', default: 'json' },
        refresh: { type: 'boolean', description: 'Re-read the live page first. Default true when a browser is connected.', default: true },
        orphans: { type: 'boolean', description: 'Instead list downloaded files the catalog cannot attribute to any generation.', default: false },
        limit: { type: 'number', description: 'How many generations to list when no target is given.', default: 20 },
      },
    },
  },
];

async function handleToolCall(name, args) {
  logger.info('Tool called', { tool: name, args: args ? JSON.stringify(args).substring(0, 200) : 'none' });

  switch (name) {
    case 'flow_connect': {
      const profileKey = args?.profile || getDefaultProfileKey();
      const profileEntry = getProfileEntry(profileKey);
      const sourceProfileUsed = args?.source_profile || profileEntry?.sourceProfile;
      const result = await launchKiaraProfile({
        headless: args?.headless || false,
        virtualDisplay: args?.virtual_display || false,
        profile: profileKey,
        sourceProfile: args?.source_profile,
      });
      if (result.browser) setBrowser(result.browser);
      const page = getPage();
      let oauthRequired = false;
      if (args?.open_flow !== false) {
        // Default to the most recently used known project instead of the bare
        // Flow landing page when the caller didn't ask for a specific project —
        // the landing page is only the right target on a genuinely first-ever
        // connect (no cached project yet); every later connect already knows
        // where it's going, so it should go straight there.
        const effectiveProjectId = args?.project_id || getMostRecentProject()?.id;
        const navResult = await navigateToFlow(page, undefined, effectiveProjectId);
        if (navResult && navResult.authenticated === false) {
          oauthRequired = true;
        }
      }
      const url = page.url();
      let accountCheck = null;
      try {
        accountCheck = await checkAccount({ expectedAccount: profileEntry?.expectedAccount, enforceExpected: true });
      } catch (e) {
        accountCheck = { verified: false, error: e.message };
      }
      // Self-registration: config's `profiles` map is the single source of
      // truth for every known account — write this profile into it once its
      // real account email is discovered, so a re-seed or a fresh session
      // never needs source_profile/expectedAccount supplied again by hand.
      // Only writes on genuinely new info (new key, or a changed/newly-
      // discovered email) — not on every connect.
      if (accountCheck?.verified && accountCheck.account && accountCheck.account.includes('@')) {
        const alreadyCorrect = profileEntry?.expectedAccount === accountCheck.account
          && (!sourceProfileUsed || profileEntry?.sourceProfile === sourceProfileUsed);
        if (!alreadyCorrect) {
          const profiles = { ...getAllProfiles() };
          profiles[profileKey] = {
            ...(sourceProfileUsed ? { sourceProfile: sourceProfileUsed } : profileEntry?.sourceProfile ? { sourceProfile: profileEntry.sourceProfile } : {}),
            expectedAccount: accountCheck.account,
          };
          updateConfig({ profiles });
          logger.info('Self-registered profile in config', { profileKey, entry: profiles[profileKey] });
        }
      }
      if (oauthRequired) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'oauth_required',
          message: `Google sign-in needed in the persistent profile (chrome-profile-${profileKey}/) — this only ever `
            + 'happens once per profile, then every future flow_connect with the same profile reuses the saved '
            + 'session automatically. This step needs a VISIBLE window: if this call used virtual_display=true or '
            + 'headless=true, retry with both false so a human can see and complete it, then future calls can go '
            + 'back to any mode. Ask the user to: 1) look at the Chrome window, 2) pick their Google account (and '
            + 'complete 2FA if prompted), 3) retry this tool once signed in.',
          account: accountCheck?.account || 'verified-account',
          url: page.url().substring(0, 100),
          accountVerified: accountCheck,
        }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'connected',
        profile: profileKey,
        account: accountCheck?.account || 'verified-account',
        url: page.url(),
        accountVerified: accountCheck,
      }, null, 2) }] };
    }

    case 'flow_disconnect': {
      await closeBrowserConnection();
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'disconnected' }) }] };
    }

    case 'flow_status': {
      if (args?.reset_queue) jobQueue.forceReset();
      const status = await handleFlowStatus();
      status.queue = jobQueue.getStatus(args?.history_limit || 0);
      status.mode = getLaunchMode();
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    case 'flow_discover_ui': {
      const result = await handleDiscoverUi(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_generate_image': {
      const result = await handleGenerateImage(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_generate_video': {
      const result = await handleGenerateVideo(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_download_latest': {
      const result = await handleDownloadLatest(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_create_character': {
      const result = await handleCreateCharacter(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_use_grid_architect': {
      const result = await handleUseGridArchitect(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_list_projects': {
      const { getPage } = await import('./browser/connect.js');
      const { listExistingProjects } = await import('./navigation/project-navigator.js');
      const page = getPage();
      // Capture this first — listing navigates to the Flow home page, which drops
      // us out of whatever project we were sitting in.
      const currentProjectId = page.url().split('/project/')[1]?.split(/[/?#]/)[0] || null;
      const projects = await listExistingProjects(page);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: projects.length, current_project_id: currentProjectId, projects }, null, 2),
        }],
      };
    }

    case 'flow_screenshot': {
      const { getPage } = await import('./browser/connect.js');
      const page = getPage();
      const ss = await takeScreenshot(page, args?.name || 'manual');
      return { content: [{ type: 'text', text: JSON.stringify({ screenshot: ss, message: 'Screenshot saved.' }) }] };
    }

    case 'flow_change_settings': {
      const result = await handleChangeSettings(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_list_generations': {
      const result = await handleListGenerations(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_edit_generation': {
      const result = await handleEditGeneration(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_index': {
      const result = await handleIndexQuery(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

// Sent once at initialize rather than repeated in every tool response, which
// is where this guidance used to live — it was being re-paid on every call to
// restate something that never changes.
const SERVER_INSTRUCTIONS = [
  'Google Flow driver. Typical order: flow_connect, then flow_generate_image (auto_confirm true to actually spend credits),',
  'then flow_index to see what exists and flow_download_latest to fetch it.',
  'flow_index is the memory: it knows every generation, each step of its edit history with the prompt behind it,',
  'and which files are already downloaded at which resolution — ask it before re-generating or re-downloading anything.',
  'Downloaded files land in outputs/images/ relative to the working directory; the catalog itself is global.',
  '2K downloads need a headed browser (flow_connect with headless false, or virtual_display true for unattended runs).',
].join(' ');

const server = new Server(
  { name: 'google-flow-browser-mcp', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleToolCall(request.params.name, request.params.arguments);
  } catch (error) {
    logger.error('Tool execution error', { tool: request.params.name, error: error.message });
    if (error instanceof McpError) throw error;
    const message = error.message || 'Unknown error';
    const isBlocking = message.includes('MUST') || message.includes('cannot') || message.includes('blocked');
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: true,
        message,
        code: isBlocking ? 'BLOCKING' : 'ERROR',
        needsManualIntervention: isBlocking,
      }, null, 2) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('Google Flow Browser MCP server running on stdio');
