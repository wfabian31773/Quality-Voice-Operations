/**
 * Opt-in integration coverage for the four `validate*CachedIdentity`
 * adapters. Each block hits the *real* CRM sandbox for that provider with
 * a known-deleted record ID and asserts the validator marks it stale.
 *
 * These tests intentionally do not mock `fetch` — that is what the unit
 * tests in `validateCachedIdentity.test.ts` already cover. The point of
 * this suite is to catch upstream drift (HubSpot moving the 404 body
 * shape, Zoho returning a 200 wrapper around a missing record,
 * Salesforce key-prefix changes, etc.) before it silently disables
 * proactive cleanup in production.
 *
 * Each provider's block is `describe.skipIf`-gated on its own env vars,
 * so CI can opt in per provider without forcing every team to provision
 * every sandbox at once. See the "Validating cached CRM identity against
 * live sandboxes" section of `./README.md` for the per-provider env-var
 * matrix and how to wire it into CI.
 *
 * Optionally, each provider can additionally set `*_SANDBOX_REFRESH_TOKEN`
 * (alongside the production `*_CLIENT_ID` / `*_CLIENT_SECRET` env vars
 * that `tokenRefresh.ts` already reads). When that triple is present, the
 * test stamps a stale `token_expires_at` on the synthetic config so the
 * validator's internal `ensureFreshOAuthToken` call mints a fresh access
 * token via the production refresh path before the validator runs. This
 * keeps CI green even when sandbox access tokens have expired (HubSpot /
 * Salesforce: ~hours, Zoho: ~1h) without a human babysitting secret
 * rotations.
 *
 * The DB-persistence side of `ensureFreshOAuthToken` is stubbed out below
 * so the integration test never writes the rotated credentials back to
 * the platform DB — the synthetic `tenant-integration-test` /
 * `integration-test` rows do not exist in any real schema.
 */

import { describe, test, expect, vi } from 'vitest';
import type { ConnectorConfig } from '../types';
import type { TenantId } from '../../../core/types';

// Avoid persisting refreshed credentials / reconnect flags against the
// synthetic tenant — these rows do not exist in any real DB. Only the two
// db helpers `tokenRefresh.ts` actually calls are stubbed; the validators
// themselves do not import `../db` directly, so this mock is scoped to
// the refresh side effect.
vi.mock('../db', () => ({
  updateConnectorCredentials: async (): Promise<void> => {},
  markConnectorReconnectNeeded: async (): Promise<void> => {},
}));

import { validateHubSpotCachedIdentity } from './hubspot';
import { validateSalesforceCachedIdentity } from './salesforce';
import { validatePipedriveCachedIdentity } from './pipedrive';
import { validateZohoCachedIdentity } from './zoho';

const TENANT: TenantId = 'tenant-integration-test' as TenantId;

const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
};

/**
 * Stamp the credentials so the validator's internal `ensureFreshOAuthToken`
 * call exchanges the supplied refresh_token for a fresh access_token via
 * the production refresh path. Only invoked when the caller has provided
 * both a refresh token and the provider's OAuth client credentials.
 */
function withRefreshGrant(
  credentials: Record<string, string>,
  refreshToken: string,
): Record<string, string> {
  return {
    ...credentials,
    refresh_token: refreshToken,
    // Force `shouldRefresh` to fire regardless of clock skew between CI
    // and the upstream provider.
    token_expires_at: '0',
  };
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

const HUBSPOT_TOKEN = env('HUBSPOT_SANDBOX_ACCESS_TOKEN');
const HUBSPOT_DELETED_CONTACT = env('HUBSPOT_SANDBOX_DELETED_CONTACT_ID');
const HUBSPOT_DELETED_COMPANY = env('HUBSPOT_SANDBOX_DELETED_COMPANY_ID');
const HUBSPOT_DELETED_DEAL = env('HUBSPOT_SANDBOX_DELETED_DEAL_ID');
const HUBSPOT_REFRESH_TOKEN = env('HUBSPOT_SANDBOX_REFRESH_TOKEN');
const HUBSPOT_CAN_REFRESH = !!(HUBSPOT_REFRESH_TOKEN && env('HUBSPOT_CLIENT_ID') && env('HUBSPOT_CLIENT_SECRET'));

describe.skipIf(!HUBSPOT_TOKEN || (!HUBSPOT_DELETED_CONTACT && !HUBSPOT_DELETED_COMPANY && !HUBSPOT_DELETED_DEAL))(
  'validateHubSpotCachedIdentity (live sandbox)',
  () => {
    const baseCredentials: Record<string, string> = { access_token: HUBSPOT_TOKEN ?? '' };
    const config: ConnectorConfig = {
      integrationId: 'integration-test',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'hubspot',
      isEnabled: true,
      credentials: HUBSPOT_CAN_REFRESH
        ? withRefreshGrant(baseCredentials, HUBSPOT_REFRESH_TOKEN!)
        : baseCredentials,
    };

    test('marks the known-deleted record(s) stale under HubSpot-native field names', async () => {
      const out = await validateHubSpotCachedIdentity(TENANT, config, {
        contactId: HUBSPOT_DELETED_CONTACT,
        accountId: HUBSPOT_DELETED_COMPANY,
        opportunityId: HUBSPOT_DELETED_DEAL,
      });

      const expected: { contactId?: string; companyId?: string; dealId?: string } = {};
      if (HUBSPOT_DELETED_CONTACT) expected.contactId = HUBSPOT_DELETED_CONTACT;
      if (HUBSPOT_DELETED_COMPANY) expected.companyId = HUBSPOT_DELETED_COMPANY;
      if (HUBSPOT_DELETED_DEAL) expected.dealId = HUBSPOT_DELETED_DEAL;
      expect(out.stale).toEqual(expected);
    }, 30_000);
  },
);

// ---------------------------------------------------------------------------
// Salesforce
// ---------------------------------------------------------------------------

const SALESFORCE_TOKEN = env('SALESFORCE_SANDBOX_ACCESS_TOKEN');
const SALESFORCE_INSTANCE_URL = env('SALESFORCE_SANDBOX_INSTANCE_URL');
const SALESFORCE_DELETED_CONTACT = env('SALESFORCE_SANDBOX_DELETED_CONTACT_ID');
const SALESFORCE_DELETED_ACCOUNT = env('SALESFORCE_SANDBOX_DELETED_ACCOUNT_ID');
const SALESFORCE_DELETED_OPPORTUNITY = env('SALESFORCE_SANDBOX_DELETED_OPPORTUNITY_ID');
const SALESFORCE_REFRESH_TOKEN = env('SALESFORCE_SANDBOX_REFRESH_TOKEN');
const SALESFORCE_CAN_REFRESH = !!(SALESFORCE_REFRESH_TOKEN && env('SALESFORCE_CLIENT_ID') && env('SALESFORCE_CLIENT_SECRET'));

describe.skipIf(
  !SALESFORCE_TOKEN
    || !SALESFORCE_INSTANCE_URL
    || (!SALESFORCE_DELETED_CONTACT && !SALESFORCE_DELETED_ACCOUNT && !SALESFORCE_DELETED_OPPORTUNITY),
)('validateSalesforceCachedIdentity (live sandbox)', () => {
  const baseCredentials: Record<string, string> = {
    access_token: SALESFORCE_TOKEN ?? '',
    instance_url: SALESFORCE_INSTANCE_URL ?? '',
  };
  const config: ConnectorConfig = {
    integrationId: 'integration-test',
    tenantId: TENANT,
    connectorType: 'crm',
    provider: 'salesforce',
    isEnabled: true,
    credentials: SALESFORCE_CAN_REFRESH
      ? withRefreshGrant(baseCredentials, SALESFORCE_REFRESH_TOKEN!)
      : baseCredentials,
  };

  // Salesforce's validator skips IDs whose key prefix does not match the
  // slot — guard the test so a misconfigured env var fails loudly instead
  // of silently producing an empty `stale` object.
  if (SALESFORCE_DELETED_CONTACT && !SALESFORCE_DELETED_CONTACT.startsWith('003')) {
    throw new Error('SALESFORCE_SANDBOX_DELETED_CONTACT_ID must be a Salesforce Contact ID (key prefix "003").');
  }
  if (SALESFORCE_DELETED_ACCOUNT && !SALESFORCE_DELETED_ACCOUNT.startsWith('001')) {
    throw new Error('SALESFORCE_SANDBOX_DELETED_ACCOUNT_ID must be a Salesforce Account ID (key prefix "001").');
  }
  if (SALESFORCE_DELETED_OPPORTUNITY && !SALESFORCE_DELETED_OPPORTUNITY.startsWith('006')) {
    throw new Error('SALESFORCE_SANDBOX_DELETED_OPPORTUNITY_ID must be a Salesforce Opportunity ID (key prefix "006").');
  }

  test('marks the known-deleted record(s) stale under canonical slot names', async () => {
    const out = await validateSalesforceCachedIdentity(TENANT, config, {
      contactId: SALESFORCE_DELETED_CONTACT,
      accountId: SALESFORCE_DELETED_ACCOUNT,
      opportunityId: SALESFORCE_DELETED_OPPORTUNITY,
    });

    const expected: { contactId?: string; accountId?: string; opportunityId?: string } = {};
    if (SALESFORCE_DELETED_CONTACT) expected.contactId = SALESFORCE_DELETED_CONTACT;
    if (SALESFORCE_DELETED_ACCOUNT) expected.accountId = SALESFORCE_DELETED_ACCOUNT;
    if (SALESFORCE_DELETED_OPPORTUNITY) expected.opportunityId = SALESFORCE_DELETED_OPPORTUNITY;
    expect(out.stale).toEqual(expected);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Pipedrive
// ---------------------------------------------------------------------------

const PIPEDRIVE_ACCESS_TOKEN = env('PIPEDRIVE_SANDBOX_ACCESS_TOKEN');
const PIPEDRIVE_API_TOKEN = env('PIPEDRIVE_SANDBOX_API_TOKEN');
const PIPEDRIVE_COMPANY_DOMAIN = env('PIPEDRIVE_SANDBOX_COMPANY_DOMAIN');
const PIPEDRIVE_DELETED_PERSON = env('PIPEDRIVE_SANDBOX_DELETED_PERSON_ID');
const PIPEDRIVE_DELETED_ORG = env('PIPEDRIVE_SANDBOX_DELETED_ORG_ID');
const PIPEDRIVE_DELETED_DEAL = env('PIPEDRIVE_SANDBOX_DELETED_DEAL_ID');
const PIPEDRIVE_REFRESH_TOKEN = env('PIPEDRIVE_SANDBOX_REFRESH_TOKEN');
// Pipedrive's API-token mode is not OAuth; refresh only applies when the
// caller wired up the OAuth access_token path.
const PIPEDRIVE_CAN_REFRESH = !!(
  PIPEDRIVE_ACCESS_TOKEN
    && PIPEDRIVE_REFRESH_TOKEN
    && env('PIPEDRIVE_CLIENT_ID')
    && env('PIPEDRIVE_CLIENT_SECRET')
);

describe.skipIf(
  (!PIPEDRIVE_ACCESS_TOKEN && !PIPEDRIVE_API_TOKEN)
    || (!PIPEDRIVE_DELETED_PERSON && !PIPEDRIVE_DELETED_ORG && !PIPEDRIVE_DELETED_DEAL),
)('validatePipedriveCachedIdentity (live sandbox)', () => {
  const credentials: Record<string, string> = {};
  if (PIPEDRIVE_ACCESS_TOKEN) credentials.access_token = PIPEDRIVE_ACCESS_TOKEN;
  if (PIPEDRIVE_API_TOKEN) credentials.api_token = PIPEDRIVE_API_TOKEN;
  if (PIPEDRIVE_COMPANY_DOMAIN) credentials.company_domain = PIPEDRIVE_COMPANY_DOMAIN;

  const config: ConnectorConfig = {
    integrationId: 'integration-test',
    tenantId: TENANT,
    connectorType: 'crm',
    provider: 'pipedrive',
    isEnabled: true,
    credentials: PIPEDRIVE_CAN_REFRESH
      ? withRefreshGrant(credentials, PIPEDRIVE_REFRESH_TOKEN!)
      : credentials,
  };

  test('marks the known-deleted record(s) stale under Pipedrive-native field names', async () => {
    const out = await validatePipedriveCachedIdentity(TENANT, config, {
      contactId: PIPEDRIVE_DELETED_PERSON,
      accountId: PIPEDRIVE_DELETED_ORG,
      opportunityId: PIPEDRIVE_DELETED_DEAL,
    });

    const expected: { personId?: string; orgId?: string; dealId?: string } = {};
    if (PIPEDRIVE_DELETED_PERSON) expected.personId = PIPEDRIVE_DELETED_PERSON;
    if (PIPEDRIVE_DELETED_ORG) expected.orgId = PIPEDRIVE_DELETED_ORG;
    if (PIPEDRIVE_DELETED_DEAL) expected.dealId = PIPEDRIVE_DELETED_DEAL;
    expect(out.stale).toEqual(expected);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Zoho
// ---------------------------------------------------------------------------

const ZOHO_TOKEN = env('ZOHO_SANDBOX_ACCESS_TOKEN');
const ZOHO_API_DOMAIN = env('ZOHO_SANDBOX_API_DOMAIN');
const ZOHO_DELETED_CONTACT = env('ZOHO_SANDBOX_DELETED_CONTACT_ID');
const ZOHO_DELETED_ACCOUNT = env('ZOHO_SANDBOX_DELETED_ACCOUNT_ID');
const ZOHO_DELETED_DEAL = env('ZOHO_SANDBOX_DELETED_DEAL_ID');
const ZOHO_REFRESH_TOKEN = env('ZOHO_SANDBOX_REFRESH_TOKEN');
const ZOHO_ACCOUNTS_SERVER = env('ZOHO_SANDBOX_ACCOUNTS_SERVER');
const ZOHO_CAN_REFRESH = !!(ZOHO_REFRESH_TOKEN && env('ZOHO_CLIENT_ID') && env('ZOHO_CLIENT_SECRET'));

describe.skipIf(
  !ZOHO_TOKEN
    || !ZOHO_API_DOMAIN
    || (!ZOHO_DELETED_CONTACT && !ZOHO_DELETED_ACCOUNT && !ZOHO_DELETED_DEAL),
)('validateZohoCachedIdentity (live sandbox)', () => {
  const baseCredentials: Record<string, string> = {
    access_token: ZOHO_TOKEN ?? '',
    api_domain: ZOHO_API_DOMAIN ?? '',
  };
  // Zoho's refresh exchange POSTs to the per-region accounts server. Allow
  // CI to pin it explicitly so EU / IN / AU / JP sandboxes don't get
  // routed at the default `accounts.zoho.com` endpoint.
  if (ZOHO_ACCOUNTS_SERVER) baseCredentials.accounts_server = ZOHO_ACCOUNTS_SERVER;

  const config: ConnectorConfig = {
    integrationId: 'integration-test',
    tenantId: TENANT,
    connectorType: 'crm',
    provider: 'zoho',
    isEnabled: true,
    credentials: ZOHO_CAN_REFRESH
      ? withRefreshGrant(baseCredentials, ZOHO_REFRESH_TOKEN!)
      : baseCredentials,
  };

  test('marks the known-deleted record(s) stale under Zoho-native field names', async () => {
    const out = await validateZohoCachedIdentity(TENANT, config, {
      contactId: ZOHO_DELETED_CONTACT,
      accountId: ZOHO_DELETED_ACCOUNT,
      opportunityId: ZOHO_DELETED_DEAL,
    });

    const expected: { contactId?: string; accountId?: string; dealId?: string } = {};
    if (ZOHO_DELETED_CONTACT) expected.contactId = ZOHO_DELETED_CONTACT;
    if (ZOHO_DELETED_ACCOUNT) expected.accountId = ZOHO_DELETED_ACCOUNT;
    if (ZOHO_DELETED_DEAL) expected.dealId = ZOHO_DELETED_DEAL;
    expect(out.stale).toEqual(expected);
  }, 30_000);
});
