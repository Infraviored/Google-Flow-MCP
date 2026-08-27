import path from 'path';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { launchChromeDirect, getActiveProfileKey } from './connect.js';

const CHROME_PATH = get('chromePath', '/opt/google/chrome/chrome');
const CDP_PORT = get('cdpPort', 9222);
const FLOW_URL = get('flowUrl', 'https://labs.google/fx/en/tools/flow');
const CHROME_USER_DATA_DIR = get('chromeUserDataDir', path.resolve(process.env.HOME, '.config/google-chrome'));

// config's `profiles` map is the single source of truth for every known
// account: { [profileKey]: { sourceProfile, expectedAccount } }. `profiles`
// is read fresh (not cached at import time) so a self-registered entry
// written mid-session (see index.js's flow_connect handler) is picked up
// immediately, not just after a restart.
export function getDefaultProfileKey() {
  return get('defaultProfile', 'default');
}

export function getProfileEntry(profileKey) {
  return get('profiles', {})[profileKey] || null;
}

export function getAllProfiles() {
  return get('profiles', {});
}

// Convenience for any module that needs "the expected account for whichever
// profile is currently connected" without re-deriving it — e.g. tool result
// payloads reporting which account a generation ran under.
export function getActiveExpectedAccount() {
  const key = getActiveProfileKey();
  if (!key) return null;
  return getProfileEntry(key)?.expectedAccount || null;
}

export function profileDirFor(profileKey) {
  return path.resolve(import.meta.dirname, '../..', `chrome-profile-${profileKey}`);
}

// `profile` selects which persistent chrome-profile-{key}/ directory to use
// — each is a fully independent Chrome profile/Google account. Key is just
// a label (no requirement to be an email or match anything) — nothing
// downstream depends on it beyond naming the directory; account identity
// always comes from whichever Google account is actually signed in there.
// Omitted defaults to config's `defaultProfile`.
//
// Seed source resolution order: explicit `sourceProfile` arg > config's
// profiles[profileKey].sourceProfile (a profile connected before, with a
// known seed) > nothing (starts completely empty — first connect lands on
// Google's account chooser for a fresh interactive sign-in). `sourceProfile`
// is a system Chrome profile DIRECTORY NAME under chromeUserDataDir (e.g.
// "Default" or "Profile 3" — NOT an email address); when resolved, the new
// persistent profile is seeded from that already-signed-in system profile,
// carrying its session over with no interactive sign-in step at all.
export async function launchKiaraProfile({ headless = false, virtualDisplay, profile, sourceProfile } = {}) {
  const profileKey = profile || getDefaultProfileKey();
  const persistentProfileDir = profileDirFor(profileKey);

  const effectiveSourceProfile = sourceProfile || getProfileEntry(profileKey)?.sourceProfile;
  const profileSource = effectiveSourceProfile ? path.resolve(CHROME_USER_DATA_DIR, effectiveSourceProfile) : undefined;

  logger.info('Launching Chrome via direct+CDP method (anti-detection)', { profileKey, persistentProfileDir, profileSource });

  // launchChromeDirect (connect.js) is the single source of truth for
  // whether an already-alive browser can be reused — it compares display
  // mode AND profile dir before deciding to reuse vs. relaunch. No
  // duplicate reuse-shortcut here; a duplicate that didn't check profile
  // identity was exactly how a profile switch used to silently keep
  // reusing the wrong account's browser.
  return await launchChromeDirect({
    chromePath: CHROME_PATH,
    cdpPort: CDP_PORT,
    headless,
    profileSource,
    noSeed: !profileSource,
    persistentProfileDir,
    virtualDisplay: virtualDisplay ?? get('virtualDisplay', false),
  });
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

// Distinct from recoverFromCrash's transient client-side exception: this is
// Flow's own "you can't open this" error boundary (seen live when a project
// is opened under a Google account that isn't the owner/a collaborator —
// e.g. switching flow_connect to a second account still points at the first
// account's project id). Reloading does not fix it, so it is reported rather
// than retried.
export async function checkProjectAccessError(page) {
  const hasError = await page.locator('text=Something went wrong').first().isVisible().catch(() => false);
  if (!hasError) return false;
  return await page.locator('text=Back to projects').first().isVisible().catch(() => false);
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

  if (projectId && await checkProjectAccessError(page)) {
    logger.warn('Flow project failed to load (access error, not a transient crash)', { projectId });
    return { authenticated: true, url: currentUrl, projectAccessError: true,
      message: `The signed-in account cannot open project ${projectId} — either it does not exist under this `
        + 'account or this account has no access to it (not the owner, not a collaborator). Reloading will not fix '
        + 'this. Either connect with the account that owns the project, or open/create a project this account '
        + 'actually has access to.' };
  }

  return { authenticated: true, url: currentUrl };
}
