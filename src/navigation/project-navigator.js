import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { get } from '../utils/config.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { recoverFromCrash } from '../browser/launch-profile.js';
import { projectsPath } from '../utils/paths.js';
import { readJson, writeJsonAtomic, withFileLock } from '../utils/atomic-json.js';
import { listProjectsApi, projectIdFromUrl } from '../browser/flow-api.js';
import { dismissPopups, humanClick } from '../browser/safe-actions.js';
import fs from 'fs';
import path from 'path';

// A Flow project is a cloud entity under one account, so this registry is
// global — it used to resolve against the client's cwd, which forked it into
// per-client copies holding different projects.
const PROJECTS_FILE = projectsPath();

export function loadProjects() {
  return readJson(PROJECTS_FILE, { projects: [] });
}

function saveProjects(data) {
  withFileLock(PROJECTS_FILE, () => writeJsonAtomic(PROJECTS_FILE, data));
}

// The most-recently-used cached project, if any — lets flow_connect map straight
// to a known project's URL instead of defaulting to the bare Flow landing page
// (open_flow's old behavior when no explicit project_id was given, even though the
// project in use is usually already known from a prior call this same session).
export function getMostRecentProject() {
  const { projects } = loadProjects();
  if (!projects.length) return null;
  return [...projects].sort((a, b) => new Date(b.last_used) - new Date(a.last_used))[0];
}

/**
 * List the account's projects through Flow's own API (UpteDb, see rpc.js).
 * The home page grid is no longer worth scraping: it carries no stable ids
 * or titles since the move to flow.google.com.
 * Returns array of { id, name, url, thumbnail_url, createdAt }.
 */
export async function listExistingProjects(page) {
  if (!page.url().startsWith('https://flow.google.com/')) {
    await page.goto(get('flowUrl', 'https://flow.google.com'), { waitUntil: 'load', timeout: 30000 });
  }
  const projects = await listProjectsApi(page);
  logger.info('Existing projects found', { count: projects.length });
  return projects;
}

/**
 * Create a new project: click "New project", optionally name it,
 * wait for the project page to load, store in local registry.
 * Returns { url, id, name }.
 */
export async function createNewProject(page, name) {
  const flowUrl = get('flowUrl', 'https://flow.google.com');

  // Ensure we're on the main Flow page (not inside a project)
  const currentUrl = page.url();
  if (!currentUrl.includes(flowUrl) || currentUrl.includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2000);
    await recoverFromCrash(page);
  }

  logger.info('Creating new project...');

  // Click "New project"
  const newBtnSelectors = [
    'button:has-text("New project")',
    'a:has-text("New project")',
    '[aria-label*="New project" i]',
    'button:has-text("New Project")',
  ];

  let clicked = false;
  for (const sel of newBtnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        clicked = true;
        break;
      }
    } catch { /* continue */ }
  }

  if (!clicked) {
    // Fallback: try to find any "add" or "new" button
    const fallback = page.locator('[aria-label*="add"], button:has-text("add"), [class*="fab"]').first();
    if (await fallback.isVisible().catch(() => false)) {
      await fallback.click();
    } else {
      await takeScreenshot(page, 'no-new-project-btn');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find "New project" button on the Flow page');
    }
  }

  await page.waitForURL(/\/project\//, { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
  await dismissPopups(page);

  const finalUrl = page.url();
  if (!finalUrl.includes('/project/')) {
    await takeScreenshot(page, 'no-project-after-new');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Clicked "New project" but landed on ${finalUrl}`);
  }
  logger.info('New project created', { url: finalUrl });

  // The project title is an inline text input in the top bar ("Editable text").
  // Never fall back to [contenteditable]: that is the prompt composer.
  if (name) {
    const title = page.locator('input[aria-label="Editable text"]').first();
    await title.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await dismissPopups(page);
    if (await title.isVisible().catch(() => false)) {
      await title.click();
      await title.fill(name);
      await title.press('Enter');
      await page.waitForTimeout(1500);
    }
    const id = projectIdFromUrl(finalUrl);
    const saved = (await listProjectsApi(page).catch(() => [])).find(p => p.id === id);
    if (saved?.name !== name) {
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        `Project ${id} was created but could not be named "${name}" (Flow shows "${saved?.name}").`);
    }
  }

  // Store in local registry, keyed by the REAL Flow project id parsed from the URL —
  // not a locally-invented one, so it lines up with the id every other lookup in this
  // file uses (parsed from the URL the same way, or scraped live by listExistingProjects).
  const store = loadProjects();
  const realId = finalUrl.split('/project/')[1]?.split(/[/?#]/)[0] || `proj_${Date.now()}`;
  const entry = {
    id: realId,
    url: finalUrl,
    name: name || `Project ${new Date().toISOString().slice(0, 10)}`,
    created_at: new Date().toISOString(),
    last_used: new Date().toISOString(),
    tasks: [],
  };
  store.projects.push(entry);
  saveProjects(store);

  await takeScreenshot(page, 'new-project');

  return { url: finalUrl, id: entry.id, name: entry.name };
}

/**
 * Ensure we are inside a project context.
 * Rules:
 * 1. If already in a project → reuse it
 * 2. If context.campaign matches a stored project → reopen that project
 * 3. If context.forceNew → always create new
 * 4. Otherwise → create new project
 *
 * context = { campaign, name, forceNew }
 * Returns { url, reused, id, name }
 */
export async function ensureProjectInContext(page, context = {}) {
  const currentUrl = page.url();
  const currentId = currentUrl.split('/project/')[1]?.split(/[/?#]/)[0] || null;

  const enterProject = async (project) => {
    logger.info('Entering project', { id: project.id, name: project.name });
    await page.goto(project.url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2000);
    await recoverFromCrash(page);
    await dismissPopups(page);
    return { url: project.url, id: project.id, name: project.name, reused: true };
  };

  if (!context.forceNew) {
    // An explicit id always wins, including over whatever project is already open.
    if (context.project_id) {
      if (currentId === context.project_id) {
        return { url: currentUrl, id: currentId, reused: true };
      }
      const live = await listExistingProjects(page);
      const match = live.find(p => p.id === context.project_id);
      if (match) {
        const store = loadProjects();
        store.projects = store.projects.filter(p => p.id !== match.id);
        store.projects.push({ id: match.id, name: match.name, url: match.url, last_used: new Date().toISOString() });
        saveProjects(store);
        return await enterProject(match);
      }

      // Direct navigation fallback: if the project is older or beyond pagination limits,
      // navigate directly to verify if it exists.
      const targetUrl = `https://flow.google.com/project/${context.project_id}`;
      logger.info('Project id not in listed projects, trying direct URL navigation', { id: context.project_id, targetUrl });
      await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(2000);
      await recoverFromCrash(page);
      await dismissPopups(page);
      if (projectIdFromUrl(page.url()) === context.project_id) {
        const title = (await page.locator('input[aria-label="Editable text"]').inputValue().catch(() => null)) || context.project_id;
        const store = loadProjects();
        store.projects = store.projects.filter(p => p.id !== context.project_id);
        store.projects.push({ id: context.project_id, name: title, url: targetUrl, last_used: new Date().toISOString() });
        saveProjects(store);
        return { url: targetUrl, id: context.project_id, name: title, reused: false };
      }

      throw new FlowError(ErrorCodes.CONFIG_ERROR,
        `Project id "${context.project_id}" not found in the workspace. ` +
        `Available: ${live.map(p => `${p.name} (${p.id})`).join(', ') || 'none'}`);
    }

    // Match a requested name against the LIVE workspace, not just local history —
    // but only pay for that live scan when we actually need to. listExistingProjects()
    // unconditionally bounces to the bare Flow landing page first whenever the browser
    // is currently inside ANY project (see its own currentUrl.includes('/project/')
    // check) — which is every single time this branch used to run, since callers are
    // normally already inside a project when they ask to "ensure" one. That bounce is
    // slow (a scroll-and-scan loop) and fragile: anything that races or throws mid-bounce
    // strands the browser on the landing page, where unrelated DOM (cookie banners,
    // promo dialogs) can confuse completely unrelated logic (e.g. the Agent-chat
    // sidebar's close-button detection) that assumes it's still inside a project.
    // Fast path: if we're already sitting in the project this name last resolved to
    // (cached below), skip the live scan and the bounce entirely.
    if (context.name) {
      const wanted = context.name.trim().toLowerCase();
      const store = loadProjects();
      const cached = store.projects.find(p => p.name && p.name.trim().toLowerCase() === wanted);
      if (cached && currentId === cached.id) {
        cached.last_used = new Date().toISOString();
        saveProjects(store);
        return { url: currentUrl, id: currentId, name: cached.name, reused: true };
      }

      const live = await listExistingProjects(page);
      const match = live.find(p => p.name.trim().toLowerCase() === wanted);
      if (match) {
        store.projects = store.projects.filter(p => p.id !== match.id);
        store.projects.push({ id: match.id, name: match.name, url: match.url, last_used: new Date().toISOString() });
        saveProjects(store);
        if (currentId === match.id) return { url: currentUrl, id: currentId, name: match.name, reused: true };
        return await enterProject(match);
      }
      // Named project that does not exist yet — create it under that name.
      logger.info('Named project not found in workspace, creating it', { name: context.name });
      return await createNewProject(page, context.name);
    }

    // Campaign match from the local registry (no name given).
    if (context.campaign) {
      const store = loadProjects();
      const match = store.projects.find(p =>
        p.campaign && p.campaign.toLowerCase() === context.campaign.toLowerCase()
      );
      if (match) {
        logger.info('Found matching project from history', {
          campaign: context.campaign, name: match.name, url: match.url,
        });
        await page.goto(match.url, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(2000);
        await recoverFromCrash(page);
        match.last_used = new Date().toISOString();
        saveProjects(store);
        return { url: match.url, reused: true, id: match.id, name: match.name };
      }
    }

    // Nothing requested by name/id/campaign — stay where we are rather than
    // creating a stray project.
    if (currentId) {
      logger.info('No project requested — reusing the open project', { id: currentId });
      return { url: currentUrl, id: currentId, reused: true };
    }
  }

  return await createNewProject(page, context.name);
}

/**
 * Navigate to a section in the current project's sidebar.
 * sections: "Characters", "Scenes", "Tools", "Trash"
 * Returns true if navigation succeeded, false otherwise.
 */
// Project sidebar (flow.google.com): plain text entries "All media", "Images",
// "Characters", "Scenes", "Tools", "Trash". Characters and Tools change the
// route (/character, /tools); Scenes and Images only filter the gallery.
export async function navigateToSidebar(page, section) {
  logger.info('Navigating to sidebar section', { section });
  const entry = page.getByText(section, { exact: true }).first();
  if (!(await entry.isVisible().catch(() => false))) {
    await takeScreenshot(page, `sidebar-${section}-not-found`);
    logger.warn('Sidebar section not found', { section, url: page.url() });
    return false;
  }
  await humanClick(page, entry);
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  logger.info('Sidebar navigation done', { section, url: page.url() });
  return true;
}

export async function getActiveSidebarSection(page) {
  try {
    const section = await page.evaluate(() => {
      const active = document.querySelector(
        '[class*="sidebar"] [class*="active"], [class*="sidebar"] [aria-current="page"], nav [class*="active"]'
      );
      if (active) {
        return (active.textContent || '').trim();
      }
      return null;
    });
    return section;
  } catch {
    return null;
  }
}

/**
 * Store task metadata in the project registry after completing a task.
 */
export function registerTaskInProject(projectId, taskInfo) {
  if (!projectId) return;
  const store = loadProjects();
  const proj = store.projects.find(p => p.id === projectId);
  if (proj) {
    proj.tasks.push({
      ...taskInfo,
      timestamp: new Date().toISOString(),
    });
    proj.last_used = new Date().toISOString();
    saveProjects(store);
  }
}

/**
 * Get a human-readable description of the current project context
 * for use in tool responses.
 */
export async function getProjectContextInfo(page) {
  const url = page.url();
  const inProject = url.includes('/project/');
  let section = null;
  if (inProject) {
    section = await getActiveSidebarSection(page);
  }
  return {
    inProject,
    url,
    activeSection: section,
    projectId: inProject ? url.split('/project/')[1]?.split('/')[0] || url.split('/project/')[1] : null,
  };
}

/**
 * Switch the project's bottom toolbar from Video mode to Image mode.
 * 
 * The Flow UI has TWO levels:
 *   1. Content-type tabs: "Image" | "Vidéo" | "Ingrédients" (role="tab")
 *   2. Within Vidéo tab: a dropdown for duration (6s) and ratio (x2)
 * 
 * We click the Image tab directly to switch to Image mode.
 * The Image tab has role="tab" and id ending in "-trigger-IMAGE".
 */
export async function switchToImageMode(page) {
  logger.info('Checking current generation mode...');

  const currentImageTab = await page.evaluate(() => {
    const imageTab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
    if (imageTab) return imageTab.getAttribute('aria-selected');
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.includes('Image') && b.offsetParent !== null);
    return btn ? btn.textContent.trim().substring(0, 20) : null;
  }).catch(() => null);

  if (currentImageTab === 'true') {
    logger.info('Already in Image mode');
    return true;
  }

  const imageTab = page.locator('button[role="tab"][id*="trigger-IMAGE"]').first();
  if (await imageTab.isVisible().catch(() => false)) {
    logger.info('Clicking Image tab to switch to Image mode');

    const isDisabled = await imageTab.getAttribute('aria-disabled').catch(() => null);
    if (isDisabled === 'true') {
      logger.warn('Image tab is disabled');
    } else {
      await imageTab.click();
      await page.waitForTimeout(2000);

      const verifyImage = await page.evaluate(() => {
        const tab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
        return tab ? tab.getAttribute('aria-selected') : 'not-found';
      }).catch(() => 'error');

      if (verifyImage === 'true') {
        logger.info('Successfully switched to Image mode');
        return true;
      }

      logger.warn('First click did not switch, retrying...');
      await imageTab.click();
      await page.waitForTimeout(2000);

      const verifyAgain = await page.evaluate(() => {
        const tab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
        return tab ? tab.getAttribute('aria-selected') : 'not-found';
      }).catch(() => 'error');

      if (verifyAgain === 'true') {
        logger.info('Switched to Image mode on retry');
        return true;
      }
    }
  }

  logger.info('Trying Vidéo dropdown fallback...');
  const videoButton = page.locator('button:has-text("Vidéo")').first();
  if (await videoButton.isVisible().catch(() => false)) {
    await videoButton.click();
    await page.waitForTimeout(1500);

    const imgOption = page.locator('[role="menuitem"]:has-text("Image"), [id*="trigger-IMAGE"]').first();
    if (await imgOption.isVisible().catch(() => false)) {
      await imgOption.click();
      await page.waitForTimeout(1500);
      logger.info('Switched to Image mode via dropdown');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const vf = await page.evaluate(() => {
        const t = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
        return t ? t.getAttribute('aria-selected') : null;
      }).catch(() => null);

      if (vf === 'true') {
        return true;
      }
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await takeScreenshot(page, 'switch-to-image-mode-failed');
  throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
    'IMPOSSIBLE de passer en mode Image. Le bouton de mode Vidéo est introuvable ou ' +
    'l\'option Image est absente. Génération annulée pour éviter une génération vidéo ' +
    'payante accidentelle. Vérifie manuellement l\'interface Google Flow.');

}
