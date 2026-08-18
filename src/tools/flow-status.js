import { logger } from '../utils/logger.js';
import { getPage, isBrowserConnected, getActiveProfileKey } from '../browser/connect.js';
import { verifyAccount } from '../browser/account-check.js';
import { jobQueue } from '../queue/job-queue.js';
import { getActiveExpectedAccount, getDefaultProfileKey } from '../browser/launch-profile.js';

const WORKFLOW_HINT = 'flow_connect -> flow_generate_image(auto_confirm=true) -> flow_list_generations -> ' +
  'flow_open_generation / flow_download_latest / flow_edit_generation(auto_confirm=true). ' +
  'Generation and edit tools auto-force fresh composer mode; no manual sidebar handling needed.';

export async function handleFlowStatus() {
  const status = {
    browser: isBrowserConnected(),
    account: null,
    flowAccessible: false,
    oauthRequired: false,
    currentUrl: null,
    pageTitle: null,
    queue: jobQueue.getStatus(),
    workflow: WORKFLOW_HINT,
  };

  const activeProfileKey = getActiveProfileKey();
  const expectedAccount = getActiveExpectedAccount();

  if (isBrowserConnected()) {
    try {
      const page = getPage();
      status.currentUrl = page.url();
      status.pageTitle = await page.title();
      status.flowAccessible = status.currentUrl?.includes('labs.google') || false;
      status.oauthRequired = status.currentUrl?.includes('accounts.google.com') || false;

      if (status.flowAccessible && !status.oauthRequired) {
        const verified = await verifyAccount({ expectedAccount, enforceExpected: true }).catch(() => null);
        status.account = verified?.verified ? verified.account : null;
      }
    } catch (err) {
      status.browserError = err.message;
    }
  }

  status.profile = activeProfileKey || (isBrowserConnected() ? null : getDefaultProfileKey());
  status.expectedAccount = expectedAccount;

  logger.info('Status check', status);
  return status;
}
