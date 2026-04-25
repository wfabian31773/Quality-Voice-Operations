/**
 * Allowlist of Zoho accounts (OAuth) hostnames per Zoho's published data
 * centers. Anything outside this set is rejected so we never POST our
 * `client_secret` / `refresh_token` to an attacker-controlled host (SSRF +
 * secret-exfiltration prevention).
 *
 * Sources:
 *   https://www.zoho.com/crm/developer/docs/api/v3/multi-dc.html
 *   https://www.zoho.com/accounts/protocol/oauth/multi-dc.html
 */
export const ZOHO_ACCOUNTS_HOST_ALLOWLIST: ReadonlySet<string> = new Set([
  'accounts.zoho.com',     // US (global)
  'accounts.zoho.eu',      // EU
  'accounts.zoho.in',      // India
  'accounts.zoho.com.au',  // Australia
  'accounts.zoho.jp',      // Japan
  'accounts.zoho.com.cn',  // China
  'accounts.zoho.sa',      // Saudi Arabia
  'accounts.zohocloud.ca', // Canada
]);

/**
 * Allowlist of Zoho CRM API hostnames per Zoho's published data centers.
 * `api_domain` arrives from the OAuth token response and is then used as
 * the base URL for every CRM read/write — without an allowlist a tampered
 * credential row (or tenant-edited setting) could redirect those calls
 * (which carry the tenant's `Authorization: Zoho-oauthtoken …` header) to
 * an attacker-controlled or internal host (SSRF + token exfiltration).
 */
export const ZOHO_API_HOST_ALLOWLIST: ReadonlySet<string> = new Set([
  'www.zohoapis.com',
  'www.zohoapis.eu',
  'www.zohoapis.in',
  'www.zohoapis.com.au',
  'www.zohoapis.jp',
  'www.zohoapis.com.cn',
  'www.zohoapis.sa',
  'www.zohoapis.ca',
]);

function resolveAgainstAllowlist(
  input: string | null | undefined,
  allowlist: ReadonlySet<string>,
): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  // Force HTTPS — never POST OAuth secrets / Authorization headers over
  // plain HTTP.
  if (parsed.protocol !== 'https:') return null;
  // Reject explicit non-default ports — Zoho's endpoints are always 443.
  if (parsed.port && parsed.port !== '443') return null;

  const host = parsed.hostname.toLowerCase();
  if (!allowlist.has(host)) return null;

  return `https://${host}`;
}

/**
 * Resolve and validate a Zoho accounts-server host. Returns the canonical
 * `https://<host>` origin (no trailing slash, no path) when the host is in
 * the allowlist, or `null` if the input is missing/invalid/non-allowlisted.
 *
 * Accepts inputs like `https://accounts.zoho.eu`, `accounts.zoho.eu`, or
 * `https://accounts.zoho.eu/oauth/v2/token` and normalizes them all to
 * `https://accounts.zoho.eu`.
 */
export function resolveZohoAccountsServer(input?: string | null): string | null {
  return resolveAgainstAllowlist(input, ZOHO_ACCOUNTS_HOST_ALLOWLIST);
}

/**
 * Resolve and validate a Zoho CRM `api_domain` host (the value Zoho returns
 * in the OAuth token response and that we use as the base URL for every CRM
 * read/write). Returns the canonical `https://<host>` origin or `null` when
 * the host is missing/invalid/non-allowlisted.
 */
export function resolveZohoApiDomain(input?: string | null): string | null {
  return resolveAgainstAllowlist(input, ZOHO_API_HOST_ALLOWLIST);
}
