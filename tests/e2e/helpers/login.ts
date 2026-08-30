import type { Page } from 'playwright';
import { totpAt } from '../../../platform/security/TotpMfa';
import { DEV_PLATFORM_ADMIN_MFA_SECRET } from '../../../platform/security/devPlatformAdminMfa';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const TOTP_STEP_MS = 30_000;

export interface LoginViaUiOptions {
  totpSecret?: string;
  waitUntil?: 'networkidle' | 'domcontentloaded';
}

function leftLogin(url: URL): boolean {
  return !url.pathname.startsWith('/login');
}

function msUntilNextTotpWindow(): number {
  return TOTP_STEP_MS - (Date.now() % TOTP_STEP_MS) + 250;
}

async function submitPlatformAdminMfa(page: Page, totpSecret: string): Promise<number> {
  const mfaInput = page.locator('#platform-admin-mfa-code');
  await mfaInput.waitFor({ state: 'visible', timeout: 10_000 });
  await mfaInput.fill('');
  await mfaInput.fill(totpAt(totpSecret));
  const challenge = page.waitForResponse(
    (res) => res.url().includes('/auth/mfa/challenge') && res.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await page.locator('form button[type="submit"]').click();
  return (await challenge).status();
}

/**
 * Sign in through the login page. Platform-admin accounts return 202 and
 * stay on `/login` for TOTP; tenant fixtures return 200 and navigate away.
 *
 * MFA challenge rejects reused codes in the same 30s window. Specs that
 * share `admin@voiceaihub.dev` on one runner therefore retry once on the
 * next TOTP step instead of failing closed on replay protection.
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
    let status = await submitPlatformAdminMfa(page, totpSecret);
    if (status === 401) {
      await new Promise((resolve) => setTimeout(resolve, msUntilNextTotpWindow()));
      status = await submitPlatformAdminMfa(page, totpSecret);
    }
    if (status !== 200) {
      throw new Error(`Platform admin MFA challenge failed with HTTP ${status}`);
    }
    await page.waitForURL((url) => leftLogin(url), { timeout: 15_000 });
    return;
  }

  await page.waitForURL((url) => leftLogin(url), { timeout: 15_000 });
}
