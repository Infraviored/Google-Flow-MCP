import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { get, updateConfig } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { launchKiaraProfile, getProfileEntry, getAllProfiles } from './launch-profile.js';
import { getPage, getContext, getLaunchMode } from './connect.js';
import { verifyAccount } from './account-check.js';

// One-time Google sign-in for a profile on a machine without a screen.
//
// Chrome runs headed on the Xvfb display (same path as virtual_display:true),
// x11vnc mirrors that display, and noVNC's websockify serves it as a web page.
// Both listen on 127.0.0.1 only: the user reaches the page through an ssh
// tunnel, so nothing about a signed-in Google session is ever exposed on the
// network. Once signed in the profile directory keeps the session, and every
// later flow_connect runs without a screen.

const FLOW_URL = get('flowUrl', 'https://flow.google.com');
// A continue= pointing at labs.google is rejected with a 400, so sign in plainly
// and open Flow ourselves once the account is there.
const SIGN_IN_URL = 'https://accounts.google.com/signin';

let viewer = null; // { profile, vnc, web }

function requireBinary(key, fallback, pkg) {
  const p = get(key, fallback);
  if (!fs.existsSync(p)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
      `${p} not found. Install it ("apt install ${pkg}") or set ${key} in config.`);
  }
  return p;
}

function stopViewer() {
  if (!viewer) return;
  for (const proc of [viewer.web, viewer.vnc]) {
    if (proc && proc.exitCode === null) proc.kill('SIGTERM');
  }
  logger.info('Login viewer stopped', { profile: viewer.profile });
  viewer = null;
}

async function waitForPort(port, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Login viewer did not come up on port ${port}`);
}

// The signed-in email, from Google's own account list. Opened directly (or via
// context.request) that endpoint answers 400; fetched from a Google page it
// works. A throwaway tab does it, so the page the user types into is left alone.
async function signedInEmail() {
  const cookies = await getContext().cookies('https://accounts.google.com').catch(() => []);
  if (!cookies.some(c => c.name === '__Secure-1PSID')) return null;
  const tab = await getContext().newPage();
  try {
    await tab.goto('https://myaccount.google.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const text = await tab.evaluate(() =>
      fetch('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard',
        { credentials: 'include' }).then(r => r.text()));
    return text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || null;
  } catch {
    return null;
  } finally {
    await tab.close().catch(() => {});
  }
}

function tunnelHint(webPort) {
  const host = get('loginSshHost', `${os.userInfo().username}@${os.hostname()}`);
  return `ssh -N -L ${webPort}:127.0.0.1:${webPort} ${host}`;
}

export async function startRemoteLogin({ profile }) {
  const x11vnc = requireBinary('x11vncPath', '/usr/bin/x11vnc', 'x11vnc');
  const websockify = requireBinary('websockifyPath', '/usr/bin/websockify', 'websockify');
  const novncDir = get('novncDir', '/usr/share/novnc');
  if (!fs.existsSync(`${novncDir}/vnc.html`)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
      `noVNC not found in ${novncDir}. Install it ("apt install novnc") or set novncDir in config.`);
  }

  stopViewer();
  await launchKiaraProfile({ profile, virtualDisplay: true, headless: false });
  const page = getPage();
  await page.goto(SIGN_IN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const display = get('virtualDisplayNum', 99);
  const vncPort = get('loginVncPort', 5999);
  const webPort = get('loginWebPort', 6080);

  const vnc = spawn(x11vnc, ['-display', `:${display}`, '-localhost', '-rfbport', String(vncPort),
    '-forever', '-shared', '-nopw', '-quiet'], { stdio: 'ignore' });
  const web = spawn(websockify, ['--web', novncDir, `127.0.0.1:${webPort}`, `127.0.0.1:${vncPort}`],
    { stdio: 'ignore' });
  viewer = { profile, vnc, web };
  await waitForPort(webPort);

  const url = `http://localhost:${webPort}/vnc.html?autoconnect=1&resize=scale`;
  logger.info('Login viewer started', { profile, webPort });
  return {
    status: 'waiting_for_sign_in',
    profile,
    open: url,
    tunnel: tunnelHint(webPort),
    next: 'Tell the user: run the tunnel command on their own computer (skip it when they sit at this '
      + 'machine), open the link, sign in to Google (2FA included) and accept Flow\'s terms if asked. '
      + 'Then call flow_login_wait with the same profile.',
  };
}

export async function waitRemoteLogin({ profile, timeoutSec = 240 }) {
  const mode = getLaunchMode();
  if (!viewer || viewer.profile !== profile || !mode) {
    throw new FlowError(ErrorCodes.BROWSER_NOT_CONNECTED,
      `No sign-in running for profile "${profile}". Call flow_login_start first.`);
  }

  const until = Date.now() + timeoutSec * 1000;
  let email = null;
  let flow = null;
  while (Date.now() < until) {
    email = await signedInEmail();
    if (email) {
      const page = getPage();
      // Flow moved from labs.google to flow.google.com; FLOW_URL may redirect.
      if (!/^https:\/\/(labs\.google|flow\.google\.com)\//.test(page.url())) {
        await page.goto(FLOW_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      }
      flow = await verifyAccount({ enforceExpected: false }).catch(() => null);
      if (flow?.verified) break;
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  if (!email || !flow?.verified) {
    return {
      status: 'still_waiting',
      profile,
      signedInToGoogle: email,
      flowOpen: !!flow?.verified,
      url: getPage().url().substring(0, 100),
      next: email
        ? 'Google sign-in done, Flow not open yet — the user may still need to accept Flow\'s terms. Call flow_login_wait again.'
        : 'Not signed in yet. Call flow_login_wait again, or flow_login_cancel.',
    };
  }

  const profiles = { ...getAllProfiles() };
  profiles[profile] = { ...(getProfileEntry(profile) || {}), expectedAccount: email };
  updateConfig({ profiles });
  stopViewer();
  logger.info('Profile signed in and registered', { profile, email });
  return {
    status: 'signed_in',
    profile,
    account: email,
    next: `Done. flow_connect({ profile: "${profile}", virtual_display: true }) now works without a screen.`,
  };
}

export function cancelRemoteLogin() {
  const was = viewer?.profile || null;
  stopViewer();
  return { status: 'cancelled', profile: was };
}
