import { logger } from '../utils/logger.js';
import { getPage, isBrowserConnected, getActiveProfileKey } from '../browser/connect.js';
import { verifyAccount } from '../browser/account-check.js';
import { jobQueue } from '../queue/job-queue.js';
import { getActiveExpectedAccount, getDefaultProfileKey } from '../browser/launch-profile.js';

export async function handleFlowStatus() {
  const status = {
    browser: isBrowserConnected(),
    account: null,
    flowAccessible: false,
    oauthRequired: false,
    currentUrl: null,
    pageTitle: null,
    queue: jobQueue.getStatus(),
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
