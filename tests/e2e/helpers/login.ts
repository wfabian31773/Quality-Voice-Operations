import type { Page } from 'playwright';
import { totpAt } from '../../../platform/security/TotpMfa';
import { DEV_PLATFORM_ADMIN_MFA_SECRET } from '../../../platform/security/devPlatformAdminMfa';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';

export interface LoginViaUiOptions {
  totpSecret?: string;
  waitUntil?: 'networkidle' | 'domcontentloaded';
}

function leftLogin(url: URL): boolean {
  return !url.pathname.startsWith('/login');
}

/**
 * Sign in through the login page. Platform-admin accounts return 202 and
 * stay on `/login` for TOTP; tenant fixtures return 200 and navigate away.
 */
export async function loginViaUi(
  page: Page,
  email: string,
  password: string,
  options: LoginViaUiOptions = {},
): Promise<void> {
  const waitUntil = options.waitUntil ?? 'domcontentloaded';
  const totpSecret = options.totpSecret
    ?? process.env.E2E_ADMIN_MFA_SECRET
    ?? DEV_PLATFORM_ADMIN_MFA_SECRET;

  await page.goto(`${BASE_URL}/login`, { waitUntil });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);

  const loginResponse = page.waitForResponse(
    (res) => res.url().includes('/auth/login') && res.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await page.locator('form button[type="submit"]').click();
  const response = await loginResponse;

  if (response.status() === 202) {
    const mfaInput = page.locator('#platform-admin-mfa-code');
    await mfaInput.waitFor({ state: 'visible', timeout: 10_000 });
    await mfaInput.fill(totpAt(totpSecret));
    await Promise.all([
      page.waitForURL((url) => leftLogin(url), { timeout: 15_000 }),
      page.locator('form button[type="submit"]').click(),
    ]);
    return;
  }

  await page.waitForURL((url) => leftLogin(url), { timeout: 15_000 });
}
