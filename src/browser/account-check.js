import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getPage } from './connect.js';

const EXPECTED_ACCOUNT = get('expectedAccount', 'your-email@gmail.com');

export async function verifyAccount() {
  const page = getPage();
  const currentUrl = page.url();

  logger.info('Verifying Google account on Flow', { expectedAccount: EXPECTED_ACCOUNT });

  try {
    // 1. Check if page is sitting on Google OAuth sign-in page
    if (currentUrl.includes('accounts.google.com')) {
      logger.warn('Account check failed: sitting on accounts.google.com OAuth page');
      return { verified: false, account: null, method: 'none', reason: 'Sitting on Google sign-in page' };
    }

    // 2. Check if sitting on marketing landing page without logged-in session
    const landingCheck = await page.evaluate(() => {
      const href = window.location.href;
      const isMarketingUrl = /\/tools\/flow\/?$/i.test(href) || /\/fx\/[a-z]{2}\/tools\/flow\/?$/i.test(href);
      const buttonsText = Array.from(document.querySelectorAll('button, a')).map(el => el.textContent.trim());
      const hasSignInBtn = buttonsText.some(t =>
        /^(sign in|se connecter|create with google flow|connexion)$/i.test(t) ||
        t.includes('Create with Google Flow')
      );
      return { isMarketingUrl, hasSignInBtn };
    }).catch(() => ({ isMarketingUrl: false, hasSignInBtn: false }));

    if (landingCheck.hasSignInBtn && landingCheck.isMarketingUrl) {
      logger.warn('Account check failed: detected marketing landing page with sign-in button');
      return { verified: false, account: null, method: 'none', reason: 'Not signed in (marketing landing page detected)' };
    }

    // 3. Look at Google account chip / email text in DOM
    const accountChip = await page.$('[data-account-email], [aria-label*="gmail"], [data-test-id*="account"]');
    if (accountChip) {
      const text = await accountChip.textContent();
      if (text && text.includes(EXPECTED_ACCOUNT)) {
        logger.info('Account verified via UI chip', { account: EXPECTED_ACCOUNT });
        return { verified: true, account: EXPECTED_ACCOUNT, method: 'ui-chip' };
      }
      if (text && text.includes('@gmail.com') && !text.includes(EXPECTED_ACCOUNT)) {
        await takeScreenshot(page, 'wrong-account');
        throw new FlowError(
          ErrorCodes.WRONG_GOOGLE_ACCOUNT,
          `Wrong Google account detected. Expected ${EXPECTED_ACCOUNT}, found account with: ${text.trim()}`
        );
      }
    }

    // 4. Try reading user email from page internals (__NEXT_DATA__)
    try {
      const emailFromNext = await page.evaluate(() => {
        const flowData = document.getElementById('__NEXT_DATA__')?.textContent;
        if (flowData) {
          try {
            const parsed = JSON.parse(flowData);
            return parsed?.props?.pageProps?.user?.email || parsed?.props?.pageProps?.session?.user?.email || null;
          } catch { return null; }
        }
        return null;
      });
      if (emailFromNext) {
        if (emailFromNext === EXPECTED_ACCOUNT) {
          logger.info('Account verified via __NEXT_DATA__', { account: emailFromNext });
          return { verified: true, account: emailFromNext, method: 'next-data' };
        } else if (emailFromNext.includes('@')) {
          await takeScreenshot(page, 'wrong-account');
          throw new FlowError(
            ErrorCodes.WRONG_GOOGLE_ACCOUNT,
            `Wrong Google account detected in session. Expected ${EXPECTED_ACCOUNT}, found: ${emailFromNext}`
          );
        }
      }
    } catch (e) {
      if (e instanceof FlowError) throw e;
    }

    // 5. Look for signed-in app shell profile avatar / user menu button
    const hasProfileAvatar = await page.evaluate(() => {
      const avatarImg = document.querySelector('img[src*="googleusercontent.com"], img[alt*="profile" i], img[alt*="avatar" i]');
      const accountBtn = document.querySelector('[aria-label*="Google Account" i], [aria-label*="Compte Google" i], [data-identifier]');
      return !!(avatarImg || accountBtn);
    }).catch(() => false);

    if (hasProfileAvatar) {
      logger.info('Signed-in profile avatar found in app shell', { account: EXPECTED_ACCOUNT });
      return { verified: true, account: EXPECTED_ACCOUNT, method: 'profile-avatar' };
    }

    logger.info('Account verification unconfirmed (not logged in or no avatar/chip found)', {
      currentUrl: currentUrl?.substring(0, 80),
    });

    return { verified: false, account: null, method: 'unconfirmed' };
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError(
      ErrorCodes.PLAYWRIGHT_ERROR,
      `Failed to verify account: ${err.message}`
    );
  }
}
