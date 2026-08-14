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
import { launchKiaraProfile, navigateToFlow } from './browser/launch-profile.js';
import { getPage, getBrowser, setBrowser, closeBrowser as closeBrowserConnection } from './browser/connect.js';
import { verifyAccount as checkAccount } from './browser/account-check.js';
import { handleFlowOpen } from './tools/flow-open.js';
import { handleFlowStatus } from './tools/flow-status.js';
import { handleGenerateImage } from './tools/generate-image.js';
import { handleGenerateVideo } from './tools/generate-video.js';
import { handleDownloadLatest } from './tools/download-latest.js';
import { handleCreateCharacter } from './tools/create-character.js';
import { handleImportCharacter } from './tools/import-character.js';
import { handleOpenCharacters } from './tools/open-characters.js';
import { handleCreateScene } from './tools/create-scene.js';
import { handleOpenToolsGallery } from './tools/open-tools-gallery.js';
import { handleUseGridArchitect } from './tools/grid-architect.js';
import { handleDiscoverUi } from './tools/discover-ui.js';
import { handleUseFlowTool } from './tools/use-flow-tool.js';
import { handleGetSettings } from './tools/get-settings.js';
import { handleChangeSettings } from './tools/change-settings.js';
import { handleListGenerations } from './tools/list-generations.js';
import { handleOpenGeneration } from './tools/open-generation.js';
import { handleEditGeneration } from './tools/edit-generation.js';
import { jobQueue } from './queue/job-queue.js';
import { takeScreenshot } from './utils/screenshots.js';
import fs from 'fs';
import path from 'path';

const TOOL_DEFINITIONS = [
  {
    name: 'flow_connect',
    description: 'Launch Chrome with the configured Google profile, connect CDP, navigate to Google Flow, and verify account.',
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'Launch in headless mode (not recommended, Google Flow needs visible browser).', default: false },
        open_flow: { type: 'boolean', description: 'Auto-navigate to Google Flow after connection.', default: true },
        project_id: { type: 'string', description: 'Navigate straight into this project (from flow_list_projects) instead of the Flow homepage. Skips the homepage hop entirely.' },
      },
    },
  },
  {
    name: 'flow_disconnect',
    description: 'Close the browser and clean up the MCP connection to Google Flow.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_status',
    description: 'Check current connection status: browser connected, Flow page loaded, account verified, job queue state.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Return full status with screenshot.', default: false },
      },
    },
  },
  {
    name: 'flow_account_check',
    description: 'Verify the logged-in Google account matches the configured expected email (Profile 3).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_discover_ui',
    description: 'Navigate to a Google Flow page and discover all interactive elements (buttons, inputs, links, headings). Updates the internal selectors map for robust automation.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Page to discover. Options: main, image-generation, video-generation, characters, scenes, tools-gallery, grid-architect.', default: 'main' },
      },
      required: ['page'],
    },
  },
  {
    name: 'flow_generate_image',
    description: 'WARNING: image generation SPENDS CREDITS. Always auto-detects and forces the plain bottom composer ("fresh" mode) first, closing any open follow-up Agent-chat sidebar — settings and output count are only reliable in fresh mode. Default (auto_confirm=false): fills the prompt, selects model/ratio, and returns "ready_for_confirmation" without clicking Generate — no credits spent. With auto_confirm=true: first verifies the UI is in IMAGE mode (not Video) and that the model is an image model, THEN clicks Generate, waits for the images and downloads them, and returns their editIds/editUrls for use with flow_open_generation/flow_edit_generation/flow_download_latest. Image models only.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt for image generation.' },
        model: { type: 'string', description: 'Model to use: Nano Banana Pro, Nano Banana 2, or Nano Banana 2 Lite.', default: 'Nano Banana 2' },
        auto_confirm: { type: 'boolean', description: 'CREDITS. If false (default): prepares only, spends nothing. If true: verifies Image mode is active, THEN clicks Generate (spends credits).', default: false },
        ratio: { type: 'string', description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4.', default: '1:1' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images (optional).' },
        brand: { type: 'string', description: 'Brand context for automatic model selection: premium, standard.' },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "ete-2026", "nouvelle-collection").' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_generate_video',
    description: 'Set up a video generation in Google Flow. Always auto-detects and forces the plain bottom composer ("fresh" mode) first, closing any open follow-up Agent-chat sidebar. Fills prompt, selects Omni Flash or Veo model, configures settings. NOTE: Does NOT click final Generate (paid feature — stops at ready-to-generate).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt for video generation.' },
        model: { type: 'string', description: 'Model: Omni Flash, Veo 2, Nano Banana 2.', default: 'Omni Flash' },
        ratio: { type: 'string', description: 'Aspect ratio: 16:9, 9:16, 1:1.', default: '16:9' },
        duration: { type: 'number', description: 'Target duration in seconds.', default: 5 },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images (optional).' },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "ete-2026", "nouvelle-collection").' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_download_latest',
    description: 'Download a generated file from Google Flow. Downloads whatever is currently on screen by default (the most recent generation); pass id to target a specific generation instead (from flow_list_generations/flow_generate_image/flow_edit_generation) — navigates there first.',
    inputSchema: {
      type: 'object',
      properties: {
        resolution: {
          type: 'string',
          description: 'Target resolution: "1K" (default, direct API shortcut), "2K" (UI-driven upscaled download into outputs/), "4K" (paid plan required, unsupported).',
          default: '1K',
        },
        id: {
          type: 'string',
          description: 'Optional generation id (edit-route id, not the img-src id) to download instead of whatever is currently on screen.',
        },
        filename: {
          type: 'string',
          description: 'Optional filename to save as (in outputs/images/), e.g. "oak_tree_night.jpg". Extension is inferred from the actual downloaded file if omitted. Defaults to an auto-generated name.',
        },
      },
    },
  },
  {
    name: 'flow_create_character',
    description: 'Create a new character in Google Flow Characters with name and description.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Character name.' },
        description: { type: 'string', description: 'Character description/prompt.' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images for character design.' },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "ete-2026", "nouvelle-collection").' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'flow_import_character',
    description: 'Import a character from a saved JSON file into Google Flow.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to character JSON file.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'flow_open_characters',
    description: 'Open the Google Flow Characters page and list existing characters.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_create_scene',
    description: 'Create a new scene in Google Flow Scenes with characters and prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Scene description/prompt.' },
        characters: { type: 'array', items: { type: 'string' }, description: 'Character names to include in the scene.' },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "ete-2026", "nouvelle-collection").' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_open_tools_gallery',
    description: 'Open the Google Flow Tools Gallery and list available tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_use_grid_architect',
    description: 'Open Grid Architect in Google Flow, fill theme prompt, shot prompts, engine, ratio, and visual logic settings. Supports batch shot generation for brand campaigns.',
    inputSchema: {
      type: 'object',
      properties: {
        theme_prompt: { type: 'string', description: 'Overall theme prompt for the grid.' },
        shot_prompts: { type: 'array', items: { type: 'string' }, description: 'Array of individual shot prompts for the grid.' },
        engine: { type: 'string', description: 'Engine/model for the grid.', default: 'Nano Banana 2' },
        ratio: { type: 'string', description: 'Aspect ratio for all shots.', default: '16:9' },
        visual_logic: { type: 'string', description: 'Visual logic type: None, Colour Pop, Side by Side, etc.' },
        references: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images.' },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "ete-2026", "nouvelle-collection").' },
      },
      required: ['theme_prompt'],
    },
  },
  {
    name: 'flow_use_tool',
    description: 'Open any tool by name in Google Flow and optionally fill its configuration parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Name of the tool to open (e.g. Grid Architect, Image Generation).' },
        params: { type: 'object', description: 'Optional configuration parameters for the tool.' },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "ete-2026", "nouvelle-collection").' },
      },
      required: ['tool_name'],
    },
  },
  {
    name: 'flow_list_projects',
    description: 'List all projects in the Google Flow workspace as structured data: id, name, url, thumbnail_url. Also reports which project the browser is currently inside (current_project_id).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'flow_screenshot',
    description: 'Take a screenshot of the current Google Flow page.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Custom name for the screenshot file.', default: 'manual' },
      },
    },
  },
  {
    name: 'flow_queue_status',
    description: 'Check the job queue: active job, pending queue, completed and failed job history.',
    inputSchema: {
      type: 'object',
      properties: {
        history_limit: { type: 'number', description: 'Number of recent history entries to return.', default: 5 },
      },
    },
  },
  {
    name: 'flow_get_settings',
    description: 'Read the currently selected image ratio, quantity, and model settings from the Google Flow composer panel.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'flow_change_settings',
    description: 'Change ratio, model, or quantity settings in Google Flow composer panel, verify read-back, and save. Throws FlowError if settings cannot be set or verified.',
    inputSchema: {
      type: 'object',
      properties: {
        ratio: { type: 'string', description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4.' },
        model: { type: 'string', description: 'Model name: Nano Banana Pro, Nano Banana 2, Nano Banana 2 Lite, Omni Flash, etc.' },
        quantity: { type: 'number', description: 'Generation output quantity (1-4).' },
        project_id: { type: 'string', description: 'Optional project ID to switch context before changing settings.' },
        project_name: { type: 'string', description: 'Optional project name.' },
        campaign: { type: 'string', description: 'Optional campaign identifier.' },
      },
    },
  },
  {
    name: 'flow_list_generations',
    description: 'List recent generations in the current project\'s gallery grid (newest-first): id (edit-route id), editUrl, title. Scrolls the virtualized grid to load older ones if limit exceeds what\'s initially rendered. Titles come from the gallery DOM when present, else backfilled from this MCP process\'s own generation history — null if neither source has it (e.g. generations from before this server started).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of generations to return.', default: 20 },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching.' },
      },
    },
  },
  {
    name: 'flow_open_generation',
    description: 'Navigate directly to a specific generation\'s edit page by id (from flow_list_generations/flow_generate_image) or full editUrl. Prefers clicking the gallery tile if visible (real navigation), otherwise hard-navigates and verifies Flow didn\'t bounce back to the gallery.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Generation id (edit-route id). Either this or url is required.' },
        url: { type: 'string', description: 'Full or relative edit URL. Either this or id is required.' },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching.' },
      },
    },
  },
  {
    name: 'flow_edit_generation',
    description: 'WARNING: spends credits. Follow-up (in-place) edit on an existing generation using the same composer as the edit page (e.g. "add a bee to this image") — this updates the image in place, it does not create a new gallery entry. If id/url is given, navigates there first; otherwise requires the browser to already be on a generation\'s edit page. Default (auto_confirm=false): fills the instruction only, no credits spent. With auto_confirm=true: clicks Create and returns the new media id(s).',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'The change to make, e.g. "make the sky more dramatic".' },
        id: { type: 'string', description: 'Generation id to edit. Optional if already on that generation\'s edit page.' },
        url: { type: 'string', description: 'Full or relative edit URL to edit. Optional if already on that generation\'s edit page.' },
        auto_confirm: { type: 'boolean', description: 'CREDITS. If false (default): fills instruction only. If true: clicks Create (spends credits).', default: false },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching.' },
      },
      required: ['instruction'],
    },
  },
];

async function handleToolCall(name, args) {
  logger.info('Tool called', { tool: name, args: args ? JSON.stringify(args).substring(0, 200) : 'none' });

  switch (name) {
    case 'flow_connect': {
      const result = await launchKiaraProfile(args?.headless || false);
      if (result.browser) setBrowser(result.browser);
      const page = getPage();
      let oauthRequired = false;
      if (args?.open_flow !== false) {
        const navResult = await navigateToFlow(page, undefined, args?.project_id);
        if (navResult && navResult.authenticated === false) {
          oauthRequired = true;
        }
      }
      const url = page.url();
      let accountCheck = null;
      try {
        accountCheck = await checkAccount(page);
      } catch (e) {
        accountCheck = { verified: false, error: e.message };
      }
      if (oauthRequired) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'oauth_required',
          message: 'Google Flow requires OAuth authentication. Open Chrome Profile 3 manually once:\n'
            + '  1. Launch: google-chrome --profile-directory="Profile 3"\n'
            + '  2. Navigate to: https://labs.google/fx/tools/flow/tools/grid-architect\n'
            + '  3. Complete the Google sign-in (one time)\n'
            + '  4. Retry this MCP tool in headless mode',
          browserType: 'Chrome Profile 3',
          account: accountCheck?.account || 'verified-account',
          url: page.url().substring(0, 100),
          accountVerified: accountCheck,
        }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'connected',
        browserType: 'Chrome Profile 3',
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
      const status = await handleFlowStatus();
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    case 'flow_account_check': {
      const page = getPage();
      const result = await checkAccount(page);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

    case 'flow_import_character': {
      const result = await handleImportCharacter(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_open_characters': {
      const result = await handleOpenCharacters(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_create_scene': {
      const result = await handleCreateScene(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_open_tools_gallery': {
      const result = await handleOpenToolsGallery(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_use_grid_architect': {
      const result = await handleUseGridArchitect(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_use_tool': {
      const result = await handleUseFlowTool(args);
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

    case 'flow_queue_status': {
      return { content: [{ type: 'text', text: JSON.stringify(jobQueue.getStatus(args?.history_limit), null, 2) }] };
    }

    case 'flow_get_settings': {
      const result = await handleGetSettings(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_change_settings': {
      const result = await handleChangeSettings(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_list_generations': {
      const result = await handleListGenerations(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_open_generation': {
      const result = await handleOpenGeneration(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_edit_generation': {
      const result = await handleEditGeneration(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'google-flow-browser-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
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
