import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { launchChromeDirect, setPage, setContext, setConnected, setBrowser, isBrowserConnected, isHandleAliveAsync, resetConnection } from './connect.js';

const CHROME_PATH = get('chromePath', '/opt/google/chrome/chrome');
const CDP_PORT = get('cdpPort', 9222);
const FLOW_URL = get('flowUrl', 'https://labs.google/fx/en/tools/flow');
const CHROME_PROFILE = get('chromeProfile', 'Default');
const CHROME_USER_DATA_DIR = get('chromeUserDataDir', path.resolve(process.env.HOME, '.config/google-chrome'));

export async function launchKiaraProfile(headless = false) {
  if (isBrowserConnected()) {
    const alive = await isHandleAliveAsync();
    if (alive) {
      logger.info('Browser already connected, reusing');
      return { success: true, message: 'Already connected' };
    }
    logger.warn('Stale browser connection detected, clearing state before reconnecting');
    resetConnection();
  }


  const profileSource = path.resolve(CHROME_USER_DATA_DIR, CHROME_PROFILE);

  if (!fs.existsSync(profileSource)) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR,
      `Chrome profile "${CHROME_PROFILE}" not found at ${profileSource}. Check chromeProfile/chromeUserDataDir in config/flow.config.json.`);
  }

  logger.info('Launching Chrome via direct+CDP method (anti-detection)', { profileSource });

  try {
    // Try connecting to existing Chrome instance first
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    logger.info('Found existing Chrome instance, reusing');
    const ctx = existing.contexts()[0];
    const pg = ctx?.pages()[0];
    setBrowser(existing);
    setContext(ctx);
    setConnected(true);
    if (pg) { setPage(pg); return { browser: existing, context: ctx, page: pg }; }
    const newPage = await ctx.newPage();
    setPage(newPage);
    return { browser: existing, context: ctx, page: newPage };
  } catch {
    // Launch Chrome directly (not via Playwright) for anti-detection
    return await launchChromeDirect({
      chromePath: CHROME_PATH,
      cdpPort: CDP_PORT,
      headless,
      profileSource,
    });
  }
}

// Flow's own client bundle intermittently throws "Cannot read properties of
// undefined (reading 'service')" on project page load, tripping Next.js's error
// boundary ("Application error: a client-side exception has occurred"). A single
// reload reliably recovers — this is a race in Flow's own code, not ours. Call
// after any page.goto into a Flow project page.
export async function recoverFromCrash(page) {
  const hasCrashed = await page.locator('text=Application error').first().isVisible().catch(() => false);
  if (!hasCrashed) return;

  logger.warn('Flow client-side crash detected, reloading once');
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  const stillCrashed = await page.locator('text=Application error').first().isVisible().catch(() => false);
  if (stillCrashed) {
    throw new Error('Flow client-side crash persisted after reload');
  }
}

export async function navigateToFlow(page, toolPage, projectId) {
  const targetUrl = projectId
    ? `https://labs.google/fx/en/tools/flow/project/${projectId}`
    : toolPage === true
      ? 'https://labs.google/fx/en/tools/flow'
      : FLOW_URL;

  logger.info('Navigating to Google Flow', { url: targetUrl });
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await recoverFromCrash(page);

  const currentUrl = page.url();
  logger.info('Flow page loaded', { url: currentUrl.substring(0, 100) });

  if (currentUrl.includes('accounts.google.com')) {
    return { authenticated: false, url: currentUrl,
      message: 'OAuth blocked — Google detects automation. Use Chrome direct+CDP launch method.' };
  }

  return { authenticated: true, url: currentUrl };
}
