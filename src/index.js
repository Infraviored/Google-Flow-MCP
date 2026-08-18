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
import { getPage, getBrowser, setBrowser, closeBrowser as closeBrowserConnection, getActiveProfileKey } from './browser/connect.js';
import { verifyAccount as checkAccount } from './browser/account-check.js';
import { updateConfig } from './utils/config.js';
import { handleFlowOpen } from './tools/flow-open.js';
import { handleFlowStatus } from './tools/flow-status.js';
import { handleGenerateImage } from './tools/generate-image.js';
import { handleGenerateVideo } from './tools/generate-video.js';
import { handleDownloadLatest } from './tools/download-latest.js';
import { handleCreateCharacter } from './tools/create-character.js';
import { handleOpenCharacters } from './tools/open-characters.js';
import { handleOpenToolsGallery } from './tools/open-tools-gallery.js';
import { handleUseGridArchitect } from './tools/grid-architect.js';
import { handleDiscoverUi } from './tools/discover-ui.js';
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
    description: `Launch Chrome, connect CDP, navigate to Google Flow, and verify account. Chrome runs from a PERSISTENT profile (chrome-profile-{profile}/, default profile key "${getDefaultProfileKey()}") — first-ever connect under a given profile needs one manual step (click your account in Google's account-chooser, possibly a 2FA prompt) in a VISIBLE window, unless source_profile seeds it from an already-signed-in system Chrome profile instead; every connect after that reuses the saved session automatically, no window needed. Three display modes exist — ASK THE USER which one they want before the first connect of a session, do not silently assume: (1) headed (default, headless=false/virtual_display=false) — a real visible window, needed for that first-time manual step; (2) virtual_display=true — a real headed Chrome (same rendering fingerprint, same low bot-detection risk as headed) rendered on an off-screen Xvfb display instead of the user's real screen, so it never steals their mouse/keyboard/focus — use this for unattended/background work once the profile is already authenticated; (3) headless=true — fastest, but Flow's generation/upscale actions are reCAPTCHA-gated and headless Chrome scores noticeably worse on bot-detection, so this is the riskiest option and not recommended for anything that spends credits. Multiple Google accounts: pass a distinct \`profile\` key (any label — no requirement to be an email or match anything) to get a fully separate, independently-persistent Chrome profile — see source_profile for the two ways to populate it. Switching \`profile\` on a call while a browser is alive under a different profile automatically closes it and relaunches under the new one.`,
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'True Chrome headless mode. Fastest but highest bot-detection risk (Flow\'s generate/upscale actions are reCAPTCHA-gated) — ask the user before using this.', default: false },
        virtual_display: { type: 'boolean', description: 'Run headed Chrome on an off-screen Xvfb display instead of the user\'s real screen — same bot-detection profile as a normal visible window, but doesn\'t take over their mouse/keyboard. Recommended for unattended work once already authenticated. Ask the user before using this too.', default: false },
        open_flow: { type: 'boolean', description: 'Auto-navigate to Google Flow after connection.', default: true },
        project_id: { type: 'string', description: 'Navigate straight into this project (from flow_list_projects) instead of the Flow homepage. Skips the homepage hop entirely.' },
        profile: { type: 'string', description: `Persistent profile key selecting which chrome-profile-{key}/ directory (and therefore which Google account) to use. Just a label — no requirement to be an email or match anything. Default "${getDefaultProfileKey()}" is the original profile seeded from config's profiles map. Any other value gets its own brand-new, independently-persistent profile — use this to run under a second Google account (e.g. to work around a per-account daily generation quota). No account-mismatch verification is enforced for non-default profiles — whichever account is signed in there is accepted as-is.`, default: getDefaultProfileKey() },
        source_profile: { type: 'string', description: 'Only used with a non-default `profile`. Name of an EXISTING, already-signed-in system Chrome profile DIRECTORY (under ~/.config/google-chrome/, e.g. "Default" or "Profile 2" — not an email address) to seed the new persistent profile from, carrying over its already-authenticated Google session with no interactive sign-in step. Recommended: before handing over this profile path, sign in AND visit https://labs.google/fx/tools/flow in that system profile once to accept Flow\'s terms — otherwise the seeded copy will land on the same one-time contract-acceptance screen. Omit source_profile to start that profile completely empty instead (interactive sign-in required on first connect).' },
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
    description: 'Verify the logged-in Google account in the current browser session matches the expectedAccount recorded in config/flow.config.json for the currently-active profile (profiles[activeProfileKey].expectedAccount).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_discover_ui',
    description: 'Navigate to a Google Flow page and discover all interactive elements (buttons, inputs, links, headings). Updates the internal selectors map. Diagnostic/legacy tool, predates this session\'s live-DOM-verified selectors used by flow_generate_image and friends — not needed for normal usage, only useful when actively debugging a UI change.',
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
    description: 'WARNING: image generation SPENDS CREDITS. Always auto-detects and forces the plain bottom composer ("fresh" mode) first, closing any open follow-up Agent-chat sidebar — settings and output count are only reliable in fresh mode. This means every call starts a BRAND-NEW, BLANK generation with ZERO reference to any prior image — there is no "current image" behind this composer, so a prompt like "now change the background to black" has nothing to act on and will just generate an unrelated fresh image (silent contamination, not an error). To revise/re-render an EXISTING generation in place (e.g. a black-background pass of a white-background image you already made) — do NOT call this tool again. Call flow_edit_generation with that generation\'s id instead; that is the only tool that actually opens and edits a specific prior image. Default (auto_confirm=false): fills the prompt, selects model/ratio, and returns "ready_for_confirmation" without clicking Generate — no credits spent. With auto_confirm=true: first verifies the UI is in IMAGE mode (not Video) and that the model is an image model, THEN clicks Generate, waits for the images and downloads them, and returns their editIds/editUrls for use with flow_open_generation/flow_edit_generation/flow_download_latest. Image models only.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt for image generation. HARD LIMIT: 1400 characters (Flow-enforced) — the tool throws before typing if exceeded; shorten and retry rather than trimming blind.' },
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
    description: 'Set up a video generation in Google Flow. Always auto-detects and forces the plain bottom composer ("fresh" mode) first, closing any open follow-up Agent-chat sidebar, and forces Agent mode off. Fills prompt, selects Omni Flash or Veo model, configures settings. NOTE: Does NOT click final Generate (paid feature — stops at ready-to-generate). CAUTION: unlike flow_generate_image, the video model codenames used internally are unverified guesses by pattern-matching, not confirmed against live network traffic — this tool has not been proven end-to-end this session. Prefer flow_generate_image for anything that must work reliably; if using this, verify the result carefully before trusting it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt for video generation. HARD LIMIT: 1400 characters (Flow-enforced) — the tool throws before typing if exceeded; shorten and retry rather than trimming blind.' },
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
    description: 'Create a new character in Google Flow Characters with name and description. Uses the same Slate composer pattern as flow_generate_image. Default (auto_confirm=false): fills the description, returns "ready_for_confirmation" without spending credits. With auto_confirm=true: clicks Create (spends credits).',
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
    name: 'flow_open_characters',
    description: 'Open the Google Flow Characters page and list existing characters. UNVERIFIED: predates this session\'s live-testing work — test cautiously before relying on it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_open_tools_gallery',
    description: 'Open the Google Flow Tools Gallery (My Tools / Community / Templates) for the current project and list available tools. Confirmed live this session — lands on the real project-scoped Explore Tools page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_use_grid_architect',
    description: 'Open Grid Architect (a built-in Flow template, found under Tools → Templates) and create a personal remix of it, landing on its /tool/{uuid} config page. The tool\'s entire UI runs inside a sandboxed <iframe title="Applet preview"> — confirmed live, this is why earlier versions of this tool could never find "Start Architecting" or any config field, they were only looking at the top-level page. Now navigates the iframe, sets ENGINE/FORMAT RATIO/VISUAL LOGIC, picks Unified Theme mode (single theme_prompt) or Sequence mode (per-shot shot_prompts, up to 4 slots — extras are dropped with a warning), and fills the prompt(s). Default (auto_confirm=false): configures everything and returns "ready_for_confirmation" without clicking Generate — no credits spent. With auto_confirm=true: clicks Generate. CAUTION: reference-image upload (the "+" under GLOBAL REFERENCES, and each shot\'s "+ COMPOSITION") is NOT wired up — the `references` param is accepted but currently ignored (a warning is logged); no <input type="file"> exists anywhere in the DOM for this control, so the actual upload mechanism is still unmapped.',
    inputSchema: {
      type: 'object',
      properties: {
        theme_prompt: { type: 'string', description: 'Master prompt driving the whole grid (Unified Theme mode). Required if shot_prompts is not given.' },
        shot_prompts: { type: 'array', items: { type: 'string' }, description: 'Per-shot prompts (Sequence mode) — up to 4, one per grid slot. Takes priority over theme_prompt if both are given.' },
        engine: { type: 'string', description: 'Engine/model for the grid. Options: "Nano Banana 2", "Nano Banana Pro".', default: 'Nano Banana 2' },
        ratio: { type: 'string', description: 'Aspect ratio for all shots. Options: "1:1", "16:9", "9:16", "4:3", "3:4".', default: '16:9' },
        visual_logic: { type: 'string', description: 'Visual logic mode. Options: "Style from References", "Ultra Realistic", "Cinematic Movie", "Film Noir", "Anime / Manga". ("+ Custom Style" exists in the UI but is not wired up here.)', default: 'Style from References' },
        references: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images. NOT YET FUNCTIONAL — accepted but ignored, see tool description.' },
        project_id: { type: 'string', description: 'Exact project id to work in (from flow_list_projects). Takes priority over project_name; errors if it does not exist.' },
        project_name: { type: 'string', description: 'Project name to select. Matched against existing projects in the workspace; created under this name if no match.' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "ete-2026", "nouvelle-collection").' },
        auto_confirm: { type: 'boolean', description: 'CREDITS. If false (default): configures the grid only, spends nothing. If true: clicks Generate (spends credits).', default: false },
      },
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
    name: 'flow_queue_reset',
    description: 'Force-clear a stuck job so the (single-slot) queue can accept new work again, without restarting the MCP server. Use when flow_queue_status shows hasActiveJob=true but the tool call that started it already returned or errored — a real bug elsewhere left the job neither completed nor failed. No-op if there is no active job.',
    inputSchema: { type: 'object', properties: {} },
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
    description: 'Read the currently selected image ratio, quantity, and model. Auto-forces Agent mode off first — Agent ON has its own separate settings surface that does not reliably reflect what actually gets generated, so this always reads the Agent-OFF one-shot settings menu, the one flow_generate_image actually uses.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'flow_change_settings',
    description: 'Change ratio, model, or quantity settings, verify read-back, and save. Auto-forces Agent mode off first (see flow_get_settings) — these settings only reliably drive actual generation output when Agent is off. Throws if a setting cannot be set or verified (fail-loud, never silently applies the wrong value).',
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
    description: 'WARNING: spends credits. Follow-up (in-place) edit on an existing generation using the same composer as the edit page (e.g. "add a bee to this image", or "change the background to black, keep everything else identical") — this updates the image in place, it does not create a new gallery entry. THIS is the correct tool for a black/white background-swap pass or any other revision of a specific prior generation — flow_generate_image cannot do this, it always starts a blank generation with no reference to any existing image. If id/url is given, navigates there first; otherwise requires the browser to already be on a generation\'s edit page. Default (auto_confirm=false): fills the instruction only, no credits spent. With auto_confirm=true: clicks Create and returns the new media id(s). CAUTION: the edit composer has no ratio/settings control, so Flow can silently change the image\'s aspect ratio even on an "identical, just X" instruction — this tool auto-detects that (compares the hero image\'s pixel dimensions before/after) and retries once with an explicit ratio-lock clause appended; if it still drifts after the retry, the call throws (the edit was still applied and its media id is included in the error) rather than returning a silently wrong-shaped success.',
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
        const navResult = await navigateToFlow(page, undefined, args?.project_id);
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
      const status = await handleFlowStatus();
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    case 'flow_account_check': {
      getPage(); // throws BROWSER_NOT_CONNECTED if nothing is connected — verifyAccount reads the page itself internally
      const activeProfileKey = getActiveProfileKey();
      const expectedAccount = activeProfileKey ? getProfileEntry(activeProfileKey)?.expectedAccount : null;
      const result = await checkAccount({ expectedAccount, enforceExpected: true });
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

    case 'flow_open_characters': {
      const result = await handleOpenCharacters(args);
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

    case 'flow_queue_reset': {
      const cleared = jobQueue.forceReset();
      return { content: [{ type: 'text', text: JSON.stringify({
        status: cleared ? 'cleared' : 'no_active_job',
        clearedJob: cleared ? { id: cleared.id, type: cleared.type } : null,
      }, null, 2) }] };
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
