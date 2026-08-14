import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';

let browser = null;
let context = null;
let page = null;
let isConnected = false;

export async function isHandleAliveAsync() {
  if (!isConnected || !browser || !page) return false;
  try {
    if (typeof browser.isConnected === 'function' && !browser.isConnected()) {
      return false;
    }
    if (page.isClosed()) return false;
    await page.evaluate(() => 1);
    return true;
  } catch {
    return false;
  }
}

export function isHandleAlive() {
  if (!isConnected || !browser || !page) return false;
  try {
    if (typeof browser.isConnected === 'function' && !browser.isConnected()) {
      return false;
    }
    return !page.isClosed();
  } catch {
    return false;
  }
}

export function resetConnection() {
  browser = null;
  context = null;
  page = null;
  isConnected = false;
}

export async function connectToBrowser(options = {}) {
  const alive = await isHandleAliveAsync();
  if (!alive) {
    resetConnection();
  } else {
    logger.info('Already connected to browser');
    return { browser, context, page };
  }


  const cdpPort = options.cdpPort || get('cdpPort', 9222);
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;

  try {
    // Try connecting to existing Chrome instance via CDP
    logger.info('Attempting CDP connection', { url: cdpUrl });
    browser = await chromium.connectOverCDP(cdpUrl);
    logger.info('Connected via CDP');

    const contexts = browser.contexts();
    if (contexts.length > 0) {
      context = contexts[0];
    } else {
      context = await browser.newContext();
    }

    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();
    isConnected = true;
    logger.info('Browser connected successfully');
    return { browser, context, page };
  } catch (err) {
    logger.warn('CDP connection failed, will launch new browser', { error: err.message });
    return await launchNewBrowser(cdpPort, options);
  }
}

async function launchNewBrowser(cdpPort, options = {}) {
  const chromePath = options.chromePath || get('chromePath', '/opt/google/chrome/chrome');
  const profileDir = options.profileDir || path.resolve(import.meta.dirname, '../../chrome-profile-kiara');

  if (!fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Chrome not found at ${chromePath}`);
  }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--window-size=1920,1080`,
  ];

  if (get('headless', false)) {
    args.push('--headless=new');
  }

  // Kill any existing Chrome on this debugging port
  try {
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    await existing.close();
  } catch (e) {
    // No existing instance, that's fine
  }

  logger.info('Launching Chrome with Kiara profile', {
    chromePath,
    profileDir,
    cdpPort,
  });

  browser = await chromium.launch({
    executablePath: chromePath,
    args,
    headless: false,
  });

  context = browser.contexts()[0] || await browser.newContext();
  page = context.pages()[0] || await context.newPage();
  isConnected = true;

  logger.info('New browser launched successfully');
  return { browser, context, page };
}

let virtualDisplayNum = null;

// Runs Chrome fully "headed" (real GPU/font/rendering fingerprint — same
// bot-detection profile as a normal window, unlike --headless=new) but on an
// off-screen X11 framebuffer instead of the user's real display, so it never
// steals their mouse/keyboard/screen. Xvfb is a standalone X server — it
// doesn't care whether the host session is X11 or Wayland. The only thing
// that matters is NOT forwarding WAYLAND_DISPLAY to the Chrome process,
// otherwise Chrome's ozone auto-detection may prefer native Wayland (the
// user's real session) over the X11 DISPLAY we're pointing it at.
async function ensureVirtualDisplay() {
  if (virtualDisplayNum !== null) return virtualDisplayNum;

  const displayNum = get('virtualDisplayNum', 99);
  const lockFile = `/tmp/.X${displayNum}-lock`;

  if (!fs.existsSync(lockFile)) {
    const xvfbPath = get('xvfbPath', '/usr/bin/Xvfb');
    if (!fs.existsSync(xvfbPath)) {
      throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
        `Xvfb not found at ${xvfbPath}. Install it (e.g. "apt install xvfb") or set xvfbPath in config.`);
    }

    logger.info('Starting Xvfb virtual display', { displayNum });
    const xvfb = spawn(xvfbPath, [`:${displayNum}`, '-screen', '0', '1920x1080x24'], {
      detached: true,
      stdio: 'ignore',
    });
    xvfb.unref();

    let attempts = 0;
    while (!fs.existsSync(lockFile) && attempts < 20) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    if (!fs.existsSync(lockFile)) {
      throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Xvfb did not start in time on display :${displayNum}`);
    }
  } else {
    logger.info('Reusing already-running Xvfb virtual display', { displayNum });
  }

  virtualDisplayNum = displayNum;
  return displayNum;
}

/**
 * Launch Chrome DIRECTLY (not via Playwright) to avoid automation detection
 * (navigator.webdriver=false). Creates temp user-data-dir with Profile 3 cookies,
 * launches Chrome via shell, then connects Playwright via CDP.
 */
export async function launchChromeDirect(options = {}) {
  const chromePath = options.chromePath || get('chromePath', '/opt/google/chrome/chrome');
  const cdpPort = options.cdpPort || get('cdpPort', 9222);
  const headless = options.headless ?? get('headless', false);
  const userDataDir = get('chromeUserDataDir', path.resolve(process.env.HOME, '.config/google-chrome'));
  const profileName = get('chromeProfile', 'Default');
  const profileSource = options.profileSource || path.resolve(userDataDir, profileName);

  const alive = await isHandleAliveAsync();
  if (!alive) {
    resetConnection();
  } else {
    logger.info('Already connected, reusing browser');
    return { browser, context, page };
  }


  if (!fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Chrome not found at ${chromePath}`);
  }

  // Persistent, not timestamped: a fresh /tmp/chrome-kiara-cdp-{Date.now()}
  // dir on every single launch meant every launch re-triggered Google's
  // account-chooser (and, once flagged as a "new device" too many times in a
  // row, a TOTP challenge) from scratch — confirmed live, repeatedly. Seed
  // this fixed dir from the real profile ONCE; every later launch reuses it
  // as-is, so whatever gets past account-chooser/2FA here stays past it.
  const tempDir = options.persistentProfileDir || path.resolve(import.meta.dirname, '../../chrome-profile-kiara');
  const alreadySeeded = fs.existsSync(path.join(tempDir, profileName));

  if (!alreadySeeded) {
    fs.mkdirSync(tempDir, { recursive: true });
    const localStateSrc = path.join(path.dirname(profileSource), 'Local State');
    if (fs.existsSync(profileSource)) {
      fs.cpSync(profileSource, path.join(tempDir, profileName), { recursive: true });
    }
    if (fs.existsSync(localStateSrc)) {
      fs.cpSync(localStateSrc, path.join(tempDir, 'Local State'));
    } else {
      fs.writeFileSync(path.join(tempDir, 'Local State'), JSON.stringify({ profile: { info_cache: {} } }));
    }
    logger.info('Persistent profile seeded from source (first run)', { tempDir });
  } else {
    logger.info('Reusing already-seeded persistent profile', { tempDir });
  }

  try {
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    await existing.close();
    await new Promise(r => setTimeout(r, 1000));
  } catch { }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tempDir}`,
    `--profile-directory=${profileName}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
  ];
  if (headless) args.push('--headless=new');

  const useVirtualDisplay = options.virtualDisplay ?? get('virtualDisplay', false);
  let spawnEnv = process.env;
  if (useVirtualDisplay && !headless) {
    const displayNum = await ensureVirtualDisplay();
    spawnEnv = { ...process.env, DISPLAY: `:${displayNum}` };
    // Stripping WAYLAND_DISPLAY alone was not enough — confirmed live Chrome
    // still picked native Wayland (the user's real session) via ozone
    // auto-detection keyed off XDG_SESSION_TYPE, ignoring DISPLAY entirely.
    // Force X11 explicitly rather than relying on env stripping to be enough.
    delete spawnEnv.WAYLAND_DISPLAY;
    delete spawnEnv.XDG_SESSION_TYPE;
    args.push('--ozone-platform=x11');
  }

  logger.info('Launching Chrome directly', { chromePath, cdpPort, headless, virtualDisplay: useVirtualDisplay && !headless });

  const chromeProcess = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });

  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  let attempts = 0;
  while (attempts < 20) {
    try {
      const resp = await fetch(`${cdpUrl}/json/version`);
      if (resp.ok) break;
    } catch { }
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }
  if (attempts >= 20) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, 'Chrome CDP failed to start in time');
  }

  browser = await chromium.connectOverCDP(cdpUrl);
  context = browser.contexts()[0];
  page = context.pages()[0] || await context.newPage();
  isConnected = true;

  logger.info('Chrome direct + CDP connected', { webdriver: await page.evaluate(() => navigator.webdriver) });
  return { browser, context, page };
}

export async function closeBrowser() {
  // The profile dir (chrome-profile-kiara/) is intentionally persistent —
  // see launchChromeDirect — never auto-deleted on disconnect, so login/2FA
  // state survives across sessions.
  if (browser) {
    try {
      await browser.close();
    } catch (err) {
      logger.warn('Error closing browser', { error: err.message });
    }
  }
  browser = null;
  context = null;
  page = null;
  isConnected = false;
  logger.info('Browser disconnected');
}

export function getPage() {
  if (!isHandleAlive()) {
    resetConnection();
    throw new FlowError(ErrorCodes.BROWSER_NOT_CONNECTED, 'Browser not connected. Call connectToBrowser() first.');
  }
  return page;
}

export function getContext() {
  return context;
}

export function isBrowserConnected() {
  if (!isHandleAlive()) {
    resetConnection();
    return false;
  }
  return isConnected;
}

export function setPage(newPage) {
  page = newPage;
}

export function getBrowser() {
  return browser;
}

export function setBrowser(b) {
  browser = b;
}

export function setConnected(connected) {
  isConnected = connected;
}

export function setContext(ctx) {
  context = ctx;
}
