import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { get } from '../utils/config.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { recoverFromCrash } from '../browser/launch-profile.js';
import fs from 'fs';
import path from 'path';

const PROJECTS_FILE = path.resolve(get('flowHome', '.'), 'config', 'flow.projects.json');

export function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
    }
  } catch (e) {
    logger.warn('Could not load projects file', { error: e.message });
  }
  return { projects: [] };
}

function saveProjects(data) {
  const dir = path.dirname(PROJECTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
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
 * List existing projects visible on the Flow homepage by scanning project cards.
 * Returns array of { name, url, fullText }.
 */
export async function listExistingProjects(page) {
  const flowUrl = get('flowUrl', 'https://labs.google/fx/en/tools/flow');

  // Navigate to the main Flow page if we're not there, or if we're INSIDE a project.
  // Match on the path, not the configured URL: project hrefs carry no locale segment.
  const currentUrl = page.url();
  const onHome = /\/fx\/(?:[a-z]{2}\/)?tools\/flow\/?(?:[?#]|$)/.test(currentUrl);
  if (!onHome || currentUrl.includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await recoverFromCrash(page);
  }

  // Wait for the first cards to mount.
  await page.locator('a[href*="/project/"]').first()
    .waitFor({ state: 'attached', timeout: 20000 })
    .catch(() => { });

  logger.info('Scanning for existing projects...');

  // Flow VIRTUALIZES the project grid: cards scrolled out of view are unmounted,
  // so a single snapshot only ever sees the visible slice. The page also scrolls
  // inside a nested overflow container, not the window, so window.scrollTo is a
  // no-op here. Scroll that container step by step and accumulate across steps.
  //
  // Project cards are anchored on a[href*="/project/"]. The card's styled-components
  // class hashes change on every Flow deploy, so nothing here matches on class names.
  // The project title is a bare text node inside the span that also holds the edit
  // button — reading innerText would swallow the "edit"/"Edit project" button labels.
  // The <i class="google-symbols">edit</i> ligature stays "edit" in every UI language.
  const projects = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // The scroll container is the nearest ancestor that actually overflows.
    const findScroller = () => {
      const link = document.querySelector('a[href*="/project/"]');
      let el = link?.parentElement;
      for (let i = 0; i < 10 && el; i++) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
        el = el.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    };

    const seen = new Set();
    const result = [];

    const harvest = () => {
    for (const link of document.querySelectorAll('a[href*="/project/"]')) {
      const href = link.getAttribute('href') || '';
      const id = href.split('/project/')[1]?.split(/[/?#]/)[0];
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // Walk up until we reach the element that also contains this card's edit button.
      let card = link.parentElement;
      let editBtn = null;
      for (let depth = 0; depth < 6 && card; depth++) {
        editBtn = [...card.querySelectorAll('i.google-symbols')]
          .find(i => i.textContent.trim() === 'edit');
        if (editBtn) break;
        card = card.parentElement;
      }

      // Title = direct text nodes of the element wrapping the edit button.
      let name = null;
      const titleHost = editBtn?.closest('span');
      if (titleHost) {
        name = [...titleHost.childNodes]
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent)
          .join('')
          .trim() || null;
      }

      const img = card?.querySelector('img')?.getAttribute('src') || null;

      result.push({
        id,
        name: name || 'Untitled project',
        url: href.startsWith('http') ? href : `https://labs.google${href}`,
        thumbnail_url: img && !img.startsWith('http') ? `https://labs.google${img}` : img,
      });
    }
    };

    const scroller = findScroller();
    harvest();
    let lastTop = -1;
    for (let step = 0; step < 40; step++) {
      const top = scroller.scrollTop;
      if (top === lastTop) break; // reached bottom
      lastTop = top;
      scroller.scrollTop = top + scroller.clientHeight * 0.8;
      await sleep(400);
      harvest();
    }

    return result;
  });

  logger.info('Existing projects found', { count: projects.length });
  return projects;
}

/**
 * Create a new project: click "New project", optionally name it,
 * wait for the project page to load, store in local registry.
 * Returns { url, id, name }.
 */
export async function createNewProject(page, name) {
  const flowUrl = get('flowUrl', 'https://labs.google/fx/en/tools/flow');

  // Ensure we're on the main Flow page (not inside a project)
  const currentUrl = page.url();
  if (!currentUrl.includes(flowUrl) || currentUrl.includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'networkidle', timeout: 30000 });
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

  await page.waitForTimeout(4000);

  const projectUrl = page.url();
  logger.info('New project created', { url: projectUrl });

  // If Flow asked for a project name, fill it
  const nameInputSelectors = [
    'input[placeholder*="name" i]',
    'input[placeholder*="title" i]',
    '[contenteditable="true"]',
  ];

  let named = false;
  for (const sel of nameInputSelectors) {
    try {
      const input = page.locator(sel).first();
      if (await input.isVisible().catch(() => false)) {
        const projectName = name ||
          `Project ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
        await input.click();
        await input.fill(projectName);
        await page.waitForTimeout(500);

        // Confirm / submit
        const confirmSelectors = [
          'button:has-text("Create")',
          'button:has-text("Confirm")',
          'button:has-text("OK")',
          '[type="submit"]',
        ];
        for (const cs of confirmSelectors) {
          try {
            const confirmBtn = page.locator(cs).first();
            if (await confirmBtn.isVisible().catch(() => false)) {
              await confirmBtn.click();
              await page.waitForTimeout(2500);
              break;
            }
          } catch { /* continue */ }
        }
        named = true;
        break;
      }
    } catch { /* continue */ }
  }

  let finalUrl = page.url();

  // If we're not inside a project (no /project/ in URL), click the project card
  if (!finalUrl.includes('/project/')) {
    logger.info('Not inside project page, clicking project card to enter...');
    await page.waitForTimeout(2000);

    // Find all project links, click the newest (first in DOM order)
    const cardClicked = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/project/"]');
      if (links.length > 0) {
        const link = links[0]; // newest project = first in order
        const href = link.getAttribute('href');
        if (href) {
          window.location.href = href.startsWith('http') ? href : 'https://labs.google' + href;
          return true;
        }
      }
      return false;
    });

    if (cardClicked) {
      await page.waitForTimeout(3000);
      finalUrl = page.url();
      logger.info('Navigated into project', { url: finalUrl });
    } else {
      // Fallback: try clicking via Playwright
      const projectLink = page.locator('a[href*="/project/"]').first();
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click();
        await page.waitForTimeout(3000);
        finalUrl = page.url();
        logger.info('Navigated into project via click', { url: finalUrl });
      } else {
        await takeScreenshot(page, 'no-project-links');
        throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
          'Could not find project card to navigate into. ' +
          'The project was created but no card link was found.');
      }
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
    await page.goto(project.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await recoverFromCrash(page);
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
        await page.goto(match.url, { waitUntil: 'networkidle', timeout: 30000 });
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
export async function navigateToSidebar(page, section) {
  logger.info('Navigating to sidebar section', { section });

  const selectors = [
    `[class*="sidebar"] button:has-text("${section}")`,
    `[class*="sidebar"] a:has-text("${section}")`,
    `nav button:has-text("${section}")`,
    `nav a:has-text("${section}")`,
    `[class*="nav"] button:has-text("${section}")`,
    `[class*="nav"] a:has-text("${section}")`,
    `button:has-text("${section}")`,
    `a:has-text("${section}")`,
  ];

  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(1500);
        logger.info('Sidebar navigation done', { section, selector });
        return true;
      }
    } catch { /* try next */ }
  }

  // Fallback: detect all buttons and log them
  logger.warn('Sidebar section not found via selectors', { section });
  const elements = await detectPageElements(page);
  await takeScreenshot(page, `sidebar-${section}-not-found`);
  logger.info('Available buttons on page', {
    buttons: elements.buttons.map(b => b.text).filter(Boolean),
  });

  return false;
}

/**
 * Get the current page elements and detect the active sidebar section.
 * Returns the section that appears to be active, or null.
 */
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
