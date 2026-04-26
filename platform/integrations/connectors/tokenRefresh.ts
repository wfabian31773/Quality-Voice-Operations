import { createLogger } from '../../core/logger';
import { writeAuditLog } from '../../audit/AuditService';
import { updateConnectorCredentials, markConnectorReconnectNeeded } from './db';
import { resolveZohoAccountsServer } from './zohoRegion';
import type { ConnectorConfig } from './types';

const logger = createLogger('CONNECTOR_TOKEN_REFRESH');

const REFRESH_LEAD_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;

const inflight = new Map<string, Promise<ConnectorConfig>>();

interface ProviderRefreshResult {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  extra?: Record<string, string>;
}

type ProviderRefresher = (
  refreshToken: string,
  credentials?: Record<string, string>,
) => Promise<ProviderRefreshResult>;

function shouldRefresh(config: ConnectorConfig, leadMs: number = REFRESH_LEAD_MS): boolean {
  const expiresAtRaw = config.credentials.token_expires_at;
  if (!expiresAtRaw) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) return false;
  return Date.now() + leadMs >= expiresAt;
}

async function refreshHubSpot(refreshToken: string): Promise<ProviderRefreshResult> {
  const clientId = process.env.HUBSPOT_CLIENT_ID ?? '';
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('HubSpot OAuth env vars missing (HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET)');
  }
  const res = await timedFetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  const json = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
  };
}

async function refreshPipedrive(refreshToken: string): Promise<ProviderRefreshResult> {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID ?? '';
  const clientSecret = process.env.PIPEDRIVE_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('Pipedrive OAuth env vars missing (PIPEDRIVE_CLIENT_ID / PIPEDRIVE_CLIENT_SECRET)');
  }
  const res = await timedFetch('https://oauth.pipedrive.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  const json = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    api_domain?: string;
  };
  const extra: Record<string, string> = {};
  if (json.api_domain) {
    const domain = json.api_domain.replace(/^https?:\/\//, '').split('.')[0];
    if (domain) extra.company_domain = domain;
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
    extra,
  };
}

async function refreshZoho(
  refreshToken: string,
  credentials?: Record<string, string>,
): Promise<ProviderRefreshResult> {
  const clientId = process.env.ZOHO_CLIENT_ID ?? '';
  const clientSecret = process.env.ZOHO_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('Zoho OAuth env vars missing (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET)');
  }
  // Zoho stores the per-region token endpoint on the connector credentials at
  // connect time (e.g. https://accounts.zoho.com, .eu, .in, .com.au, .jp).
  // Use it first so EU/IN/AU/JP tenants don't fail refresh against the global
  // endpoint. Each candidate is allowlist-validated against Zoho's published
  // data-center hosts before we POST our `client_secret` + `refresh_token`,
  // so a tampered/credential-injected `accounts_server` cannot redirect the
  // exchange to an attacker-controlled host.
  const accountsServer = resolveZohoAccountsServer(credentials?.accounts_server)
    ?? resolveZohoAccountsServer(process.env.ZOHO_ACCOUNTS_SERVER)
    ?? 'https://accounts.zoho.com';
  if (credentials?.accounts_server && !resolveZohoAccountsServer(credentials.accounts_server)) {
    throw new Error(
      `Zoho refresh refused: stored accounts_server "${credentials.accounts_server}" is not in the allowed Zoho hosts list. Reconnect required.`,
    );
  }
  const res = await timedFetch(`${accountsServer}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  const json = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    api_domain?: string;
  };
  const extra: Record<string, string> = {};
  if (json.api_domain) extra.api_domain = json.api_domain;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
    extra,
  };
}

async function refreshSalesforce(
  refreshToken: string,
  _credentials?: Record<string, string>,
): Promise<ProviderRefreshResult> {
  const clientId = process.env.SALESFORCE_CLIENT_ID ?? '';
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('Salesforce OAuth env vars missing (SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET)');
  }
  const loginUrl = process.env.SALESFORCE_LOGIN_URL ?? 'https://login.salesforce.com';
  const res = await timedFetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  const json = await res.json() as {
    access_token: string;
    refresh_token?: string;
    instance_url?: string;
    expires_in?: number;
  };
  const extra: Record<string, string> = {};
  // Salesforce can rotate the instance_url (e.g. on org migration); persist
  // the new value when it's returned so subsequent API calls hit the right
  // host. When omitted, the existing stored instance_url is left intact.
  if (json.instance_url) extra.instance_url = json.instance_url;
  // Salesforce's refresh_token grant typically omits expires_in. Fall back to
  // 90 minutes — the same conservative TTL the inline adapter used previously
  // (Salesforce session tokens default to ~2 hours).
  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0
    ? json.expires_in
    : 90 * 60;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: expiresIn,
    extra,
  };
}

async function refreshOutlookCalendar(
  refreshToken: string,
  credentials?: Record<string, string>,
): Promise<ProviderRefreshResult> {
  const clientId = credentials?.client_id ?? process.env.MICROSOFT_CLIENT_ID ?? '';
  const clientSecret = credentials?.client_secret ?? process.env.MICROSOFT_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw new Error(
      'Outlook OAuth credentials missing (client_id/client_secret on connector or MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET env)',
    );
  }
  const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const res = await timedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/Calendars.ReadWrite offline_access',
    }).toString(),
  });
  const json = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
  };
}

async function refreshGoogleCalendar(
  refreshToken: string,
  credentials?: Record<string, string>,
): Promise<ProviderRefreshResult> {
  const clientId = credentials?.client_id ?? process.env.GOOGLE_CLIENT_ID ?? '';
  const clientSecret = credentials?.client_secret ?? process.env.GOOGLE_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google Calendar OAuth credentials missing (client_id/client_secret on connector or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET env)',
    );
  }
  const res = await timedFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  const json = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
  };
}

async function refreshQuickBooks(refreshToken: string): Promise<ProviderRefreshResult> {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID ?? '';
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('QuickBooks OAuth env vars missing (QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET)');
  }
  const res = await timedFetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  const json = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
  };
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Token refresh HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

const REFRESHERS: Record<string, ProviderRefresher> = {
  hubspot: refreshHubSpot,
  pipedrive: refreshPipedrive,
  quickbooks: refreshQuickBooks,
  zoho: refreshZoho,
  salesforce: refreshSalesforce,
  'outlook-calendar': refreshOutlookCalendar,
  'google-calendar': refreshGoogleCalendar,
};

export function isRefreshableProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(REFRESHERS, provider);
}

/**
 * Returns the list of provider keys that have a registered token refresher.
 *
 * This is the single source of truth for "which providers can have their
 * OAuth tokens proactively refreshed". The overnight token refresh sweep
 * (`OAuthTokenRefreshScheduler`) derives its provider list from here so
 * adding a new entry to `REFRESHERS` above is sufficient — no separate
 * hand-maintained list to keep in sync.
 */
export function getRefreshableProviders(): string[] {
  return Object.keys(REFRESHERS);
}

export interface EnsureFreshOAuthTokenOptions {
  /** Refresh window in milliseconds — refresh if token expires within this lead time. */
  leadMs?: number;
  /**
   * When true, perform the refresh exchange unconditionally — bypass the
   * `shouldRefresh` check so callers (e.g. ops triggering "Retry refresh
   * now" from the admin Connector Health panel) can force a token rotation
   * even when the cached `token_expires_at` says the token is still valid.
   * The integration must still have a refreshable provider and a stored
   * `refresh_token`; otherwise this still throws after marking
   * needs_reconnect.
   */
  force?: boolean;
}

/**
 * Refresh the OAuth access_token if it is expired or about to expire.
 * Returns the (possibly updated) config. On refresh failure, marks the
 * integration as `needs_reconnect` and emits an audit event, then throws.
 *
 * Pass a larger `leadMs` to proactively refresh tokens earlier (e.g. from a
 * scheduled background job). Pass `force: true` to skip the expiry check
 * entirely (e.g. operator-triggered manual retry).
 */
export async function ensureFreshOAuthToken(
  config: ConnectorConfig,
  options: EnsureFreshOAuthTokenOptions = {},
): Promise<ConnectorConfig> {
  const refresher = REFRESHERS[config.provider];
  if (!refresher) return config;
  if (!options.force && !shouldRefresh(config, options.leadMs)) return config;

  const refreshToken = config.credentials.refresh_token ?? '';
  if (!refreshToken) {
    await handleRefreshFailure(config, new Error('No refresh_token stored'));
    throw new Error(`${config.provider} access_token expired and no refresh_token is stored. Reconnect required.`);
  }

  const key = `${config.tenantId}:${config.integrationId}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<ConnectorConfig> => {
    try {
      const result = await refresher(refreshToken, config.credentials);
      const newCreds: Record<string, string> = {
        access_token: result.access_token,
        token_expires_at: String(Date.now() + result.expires_in * 1000),
        ...(result.refresh_token ? { refresh_token: result.refresh_token } : {}),
        ...(result.extra ?? {}),
      };
      await updateConnectorCredentials(config.tenantId, config.integrationId, newCreds);
      logger.info('OAuth token refreshed', {
        tenantId: config.tenantId,
        provider: config.provider,
        integrationId: config.integrationId,
      });
      return {
        ...config,
        credentials: { ...config.credentials, ...newCreds },
      };
    } catch (err) {
      await handleRefreshFailure(config, err);
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

async function handleRefreshFailure(config: ConnectorConfig, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('OAuth token refresh failed', {
    tenantId: config.tenantId,
    provider: config.provider,
    integrationId: config.integrationId,
    error: message,
  });
  await markConnectorReconnectNeeded(config.tenantId, config.integrationId, {
    errorMessage: `OAuth token refresh failed: ${message.slice(0, 400)}`,
    provider: config.provider,
    connectorType: config.connectorType,
  });
  try {
    await writeAuditLog({
      tenantId: config.tenantId,
      actorUserId: 'system',
      actorRole: 'system',
      action: 'connector.token_refresh_failed',
      resourceType: 'connector',
      resourceId: config.integrationId,
      severity: 'warning',
      changes: { provider: config.provider, error: message.slice(0, 500) },
    });
  } catch {
    // best-effort
  }
}
