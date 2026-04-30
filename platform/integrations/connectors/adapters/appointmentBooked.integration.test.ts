/**
 * Opt-in integration coverage for the four first-party CRM adapters'
 * `appointment.booked` `execute()` path. Each block hits the real CRM
 * sandbox for that provider, books a synthetic appointment, asserts the
 * resulting Deal/Opportunity exists in the configured pipeline/stage,
 * and deletes every fixture record it created so the suite is
 * re-runnable.
 *
 * Each provider's block is `describe.skipIf`-gated on its own sandbox
 * access token. Optional `*_SANDBOX_APPOINTMENT_PIPELINE_ID` /
 * `*_SANDBOX_APPOINTMENT_STAGE_ID` env vars enable an additional stage-
 * placement assertion.
 *
 * Token freshness is not handled in-test. The CI workflow mints fresh
 * access tokens for short-lived providers (Salesforce password flow,
 * Zoho refresh-token grant) at the top of each run; long-lived providers
 * (HubSpot private app, Pipedrive personal API token) do not need
 * refresh. The test config never sets `token_expires_at`, so the
 * adapter's internal `ensureFreshOAuthToken` returns the supplied config
 * unchanged — verification/cleanup helpers and the adapter therefore
 * agree on which token is live for the duration of the run. The
 * runbook's per-provider rotation guidance applies for local runs.
 *
 * Per the runbook in `docs/runbooks/crm-sandbox-credentials.md`, this
 * suite uses its own fixture-record namespace (unique phone + company
 * per run) so it never collides with the cached-identity validator
 * suite's hard-deleted fixture IDs.
 *
 * Cleanup runs in two layers so a partial-write failure (adapter creates
 * a Contact, then the Deal call 5xxs and the adapter returns success:
 * false with no meta) still leaves the sandbox clean:
 *   1. A namespace sweep is registered BEFORE `execute()`. It searches
 *      each CRM by the unique synthetic identifiers and deletes any
 *      leftovers.
 *   2. Meta-based cleanup is registered after `execute()` from the
 *      returned IDs. Cleanups run in reverse-registration order so
 *      meta deletes happen first and the namespace sweep mops up
 *      anything missed.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

// Adapters never write directly to `../db`, but `tokenRefresh.ts` does
// when it persists rotated credentials. The synthetic tenant/integration
// IDs below do not exist in any real schema, so stub the two helpers
// `tokenRefresh.ts` calls to make the credential-refresh side effect a
// no-op if it fires.
vi.mock('../db', () => ({
  updateConnectorCredentials: async (): Promise<void> => {},
  markConnectorReconnectNeeded: async (): Promise<void> => {},
}));

import { HubSpotConnectorAdapter } from './hubspot';
import { SalesforceConnectorAdapter } from './salesforce';
import { PipedriveConnectorAdapter } from './pipedrive';
import { ZohoConnectorAdapter } from './zoho';

const TENANT: TenantId = 'tenant-integration-test' as TenantId;

const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
};

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// E.164-shaped synthetic caller phone in the +1-555 reserved-for-fiction
// NANP block.
function uniquePhone(): string {
  const tail = Date.now().toString().slice(-7).padStart(7, '0');
  return `+1555${tail}`;
}

// Coerce an adapter-returned meta value to a string. Pipedrive returns
// numeric upstream IDs in `result.meta`; the rest return strings.
// Normalise here so the matchers below are uniform.
function metaStr(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

// Run cleanup steps in reverse-registration order so child records are
// deleted before parents (Note → Deal → Contact → Company), and so the
// namespace sweep registered first runs LAST as a safety net. Errors are
// logged, not thrown, so a partial-cleanup leak surfaces in CI without
// masking the real test failure.
type Cleanup = () => Promise<void>;
async function runCleanups(cleanups: Cleanup[], provider: string): Promise<void> {
  for (const step of [...cleanups].reverse()) {
    try {
      await step();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[${provider}] cleanup step failed:`, err instanceof Error ? err.message : err);
    }
  }
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

const HUBSPOT_TOKEN = env('HUBSPOT_SANDBOX_ACCESS_TOKEN');
const HUBSPOT_PIPELINE = env('HUBSPOT_SANDBOX_APPOINTMENT_PIPELINE_ID');
const HUBSPOT_STAGE = env('HUBSPOT_SANDBOX_APPOINTMENT_STAGE_ID');

describe.skipIf(!HUBSPOT_TOKEN)('HubSpotConnectorAdapter appointment.booked (live sandbox)', () => {
  const credentials: Record<string, string> = { access_token: HUBSPOT_TOKEN ?? '' };
  if (HUBSPOT_PIPELINE) credentials.appointment_pipeline_id = HUBSPOT_PIPELINE;
  if (HUBSPOT_STAGE) credentials.appointment_stage_id = HUBSPOT_STAGE;

  const config: ConnectorConfig = {
    integrationId: 'integration-test',
    tenantId: TENANT,
    connectorType: 'crm',
    provider: 'hubspot',
    isEnabled: true,
    credentials,
  };

  const cleanups: Cleanup[] = [];
  afterEach(async () => {
    await runCleanups(cleanups.splice(0), 'hubspot');
  });

  const hsFetch = async (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`https://api.hubapi.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  const hsDelete = (object: 'contacts' | 'companies' | 'deals' | 'notes', id: string) =>
    hsFetch(`/crm/v3/objects/${object}/${encodeURIComponent(id)}`, { method: 'DELETE' });

  // Search-and-delete leftovers matching the per-run synthetic namespace.
  // Registered as the FIRST cleanup step (so it runs LAST) — a safety
  // net for partial-write failures where the adapter never returned meta
  // IDs we could target directly.
  const sweepHubSpotNamespace = async (suffix: string, email: string): Promise<void> => {
    const search = async (
      object: 'contacts' | 'companies' | 'deals',
      filter: { propertyName: string; operator: string; value: string },
    ): Promise<string[]> => {
      const res = await hsFetch(`/crm/v3/objects/${object}/search`, {
        method: 'POST',
        body: JSON.stringify({ filterGroups: [{ filters: [filter] }], properties: ['hs_object_id'], limit: 25 }),
      });
      if (!res.ok) return [];
      const body = await res.json() as { results?: Array<{ id?: string }> };
      return (body.results ?? []).map((r) => r.id).filter((v): v is string => !!v);
    };
    const contactIds = await search('contacts', { propertyName: 'email', operator: 'EQ', value: email });
    const companyIds = await search('companies', { propertyName: 'name', operator: 'EQ', value: `Apt Booked Co ${suffix}` });
    const dealIds = await search('deals', { propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: suffix });
    for (const id of dealIds) await hsDelete('deals', id);
    for (const id of companyIds) await hsDelete('companies', id);
    for (const id of contactIds) await hsDelete('contacts', id);
  };

  test(
    'creates Contact + Company + Deal and the Deal lands in the configured pipeline/stage',
    async () => {
      const suffix = uniqueSuffix();
      const email = `apt-booked-${suffix}@example.invalid`;
      const payload: ConnectorPayload = {
        type: 'appointment.booked',
        callerPhone: uniquePhone(),
        callerFirstName: 'Apt',
        callerLastName: `Booked-${suffix}`,
        callerEmail: email,
        callerCompany: `Apt Booked Co ${suffix}`,
        summary: `appointment.booked integration test ${suffix}`,
        appointmentDate: '2099-12-31',
        appointmentTime: '12:00',
      };

      cleanups.push(() => sweepHubSpotNamespace(suffix, email));

      const adapter = new HubSpotConnectorAdapter();
      const result = await adapter.execute(TENANT, config, payload);

      const meta = (result.meta ?? {}) as Record<string, unknown>;
      const contactId = metaStr(meta, 'contactId');
      const companyId = metaStr(meta, 'companyId');
      const dealId = metaStr(meta, 'dealId');
      const engagementId = metaStr(meta, 'engagementId');
      // Push parent-first so reverse-registration cleanup deletes child
      // records (Note → Deal → Company → Contact) before parents.
      if (contactId) cleanups.push(() => hsDelete('contacts', contactId).then(() => undefined));
      if (companyId) cleanups.push(() => hsDelete('companies', companyId).then(() => undefined));
      if (dealId) cleanups.push(() => hsDelete('deals', dealId).then(() => undefined));
      if (engagementId) cleanups.push(() => hsDelete('notes', engagementId).then(() => undefined));

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(metaStr(meta, 'provider')).toBe('hubspot');
      expect(contactId).toMatch(/^\d+$/);
      expect(companyId).toMatch(/^\d+$/);
      expect(dealId).toMatch(/^\d+$/);
      expect(engagementId).toMatch(/^\d+$/);

      const dealRes = await hsFetch(
        `/crm/v3/objects/deals/${encodeURIComponent(dealId!)}?properties=pipeline,dealstage,dealname`,
      );
      expect(dealRes.status).toBe(200);
      const dealBody = await dealRes.json() as { properties?: Record<string, string> };
      expect(dealBody.properties?.dealname).toBeTruthy();
      if (HUBSPOT_PIPELINE) expect(dealBody.properties?.pipeline).toBe(HUBSPOT_PIPELINE);
      if (HUBSPOT_STAGE) expect(dealBody.properties?.dealstage).toBe(HUBSPOT_STAGE);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Salesforce
// ---------------------------------------------------------------------------

const SALESFORCE_TOKEN = env('SALESFORCE_SANDBOX_ACCESS_TOKEN');
const SALESFORCE_INSTANCE_URL = env('SALESFORCE_SANDBOX_INSTANCE_URL');

describe.skipIf(!SALESFORCE_TOKEN || !SALESFORCE_INSTANCE_URL)(
  'SalesforceConnectorAdapter appointment.booked (live sandbox)',
  () => {
    const config: ConnectorConfig = {
      integrationId: 'integration-test',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'salesforce',
      isEnabled: true,
      credentials: {
        access_token: SALESFORCE_TOKEN ?? '',
        instance_url: SALESFORCE_INSTANCE_URL ?? '',
      },
    };

    const cleanups: Cleanup[] = [];
    afterEach(async () => {
      await runCleanups(cleanups.splice(0), 'salesforce');
    });

    const sfFetch = async (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`${SALESFORCE_INSTANCE_URL}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${SALESFORCE_TOKEN}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
    const sfDelete = (sobject: string, id: string) =>
      sfFetch(`/services/data/v60.0/sobjects/${sobject}/${encodeURIComponent(id)}`, { method: 'DELETE' });

    const sweepSalesforceNamespace = async (email: string, companyName: string): Promise<void> => {
      const queryIds = async (soql: string): Promise<string[]> => {
        const res = await sfFetch(`/services/data/v60.0/query?q=${encodeURIComponent(soql)}`);
        if (!res.ok) return [];
        const body = await res.json() as { records?: Array<{ Id?: string }> };
        return (body.records ?? []).map((r) => r.Id).filter((v): v is string => !!v);
      };
      const escEmail = email.replace(/'/g, "\\'");
      const escCompany = companyName.replace(/'/g, "\\'");
      const taskIds = await queryIds(
        `SELECT Id FROM Task WHERE Who.Email = '${escEmail}' OR What.Name = '${escCompany}'`,
      );
      for (const id of taskIds) await sfDelete('Task', id);
      const oppIds = await queryIds(
        `SELECT Id FROM Opportunity WHERE Account.Name = '${escCompany}' OR Name LIKE '${escCompany}%'`,
      );
      for (const id of oppIds) await sfDelete('Opportunity', id);
      const contactIds = await queryIds(`SELECT Id FROM Contact WHERE Email = '${escEmail}'`);
      for (const id of contactIds) await sfDelete('Contact', id);
      const accountIds = await queryIds(`SELECT Id FROM Account WHERE Name = '${escCompany}'`);
      for (const id of accountIds) await sfDelete('Account', id);
      const leadIds = await queryIds(
        `SELECT Id FROM Lead WHERE Email = '${escEmail}' AND IsConverted = false`,
      );
      for (const id of leadIds) await sfDelete('Lead', id);
    };

    test(
      'converts Lead → Contact + Account + Opportunity and creates a follow-up Task',
      async () => {
        const suffix = uniqueSuffix();
        const email = `apt-booked-${suffix}@example.invalid`;
        const companyName = `Apt Booked Co ${suffix}`;
        const payload: ConnectorPayload = {
          type: 'appointment.booked',
          callerPhone: uniquePhone(),
          callerFirstName: 'Apt',
          callerLastName: `Booked-${suffix}`,
          callerEmail: email,
          callerCompany: companyName,
          summary: `appointment.booked integration test ${suffix}`,
          appointmentDate: '2099-12-31',
          appointmentTime: '12:00',
        };

        cleanups.push(() => sweepSalesforceNamespace(email, companyName));

        const adapter = new SalesforceConnectorAdapter();
        const result = await adapter.execute(TENANT, config, payload);

        const meta = (result.meta ?? {}) as Record<string, unknown>;
        const convertedFromLeadId = metaStr(meta, 'convertedFromLeadId');
        const accountId = metaStr(meta, 'accountId');
        const contactId = metaStr(meta, 'contactId');
        const opportunityId = metaStr(meta, 'opportunityId');
        const noteId = metaStr(meta, 'noteId');
        const taskId = metaStr(meta, 'taskId');

        // Children registered last so they run first (reverse order):
        // Task references Opportunity; Opportunity is converted from
        // Lead. Converted Leads are deletable by the integration user
        // in sandboxes — best-effort.
        if (convertedFromLeadId) cleanups.push(() => sfDelete('Lead', convertedFromLeadId).then(() => undefined));
        if (accountId) cleanups.push(() => sfDelete('Account', accountId).then(() => undefined));
        if (contactId) cleanups.push(() => sfDelete('Contact', contactId).then(() => undefined));
        if (opportunityId) cleanups.push(() => sfDelete('Opportunity', opportunityId).then(() => undefined));
        if (noteId) cleanups.push(() => sfDelete('ContentDocument', noteId).then(() => undefined));
        if (taskId) cleanups.push(() => sfDelete('Task', taskId).then(() => undefined));

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(metaStr(meta, 'provider')).toBe('salesforce');
        expect(metaStr(meta, 'eventType')).toBe('appointment.booked');
        // First-time-caller path always exercises Lead conversion.
        expect(meta.convertedFromLead).toBe(true);
        expect(convertedFromLeadId).toMatch(/^00Q/);
        expect(contactId).toMatch(/^003/);
        expect(accountId).toMatch(/^001/);
        expect(opportunityId).toMatch(/^006/);
        expect(taskId).toMatch(/^00T/);

        const oppRes = await sfFetch(
          `/services/data/v60.0/sobjects/Opportunity/${encodeURIComponent(opportunityId!)}`,
        );
        expect(oppRes.status).toBe(200);
        const oppBody = await oppRes.json() as { Id?: string; AccountId?: string; Name?: string };
        expect(oppBody.Id).toBe(opportunityId);
        expect(oppBody.AccountId).toBe(accountId);
        expect(oppBody.Name).toBeTruthy();
      },
      60_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Pipedrive
// ---------------------------------------------------------------------------

const PIPEDRIVE_ACCESS_TOKEN = env('PIPEDRIVE_SANDBOX_ACCESS_TOKEN');
const PIPEDRIVE_API_TOKEN = env('PIPEDRIVE_SANDBOX_API_TOKEN');
const PIPEDRIVE_COMPANY_DOMAIN = env('PIPEDRIVE_SANDBOX_COMPANY_DOMAIN');
const PIPEDRIVE_STAGE = env('PIPEDRIVE_SANDBOX_APPOINTMENT_STAGE_ID');
const PIPEDRIVE_PIPELINE = env('PIPEDRIVE_SANDBOX_APPOINTMENT_PIPELINE_ID');

describe.skipIf(!PIPEDRIVE_ACCESS_TOKEN && !PIPEDRIVE_API_TOKEN)(
  'PipedriveConnectorAdapter appointment.booked (live sandbox)',
  () => {
    const credentials: Record<string, string> = {};
    if (PIPEDRIVE_ACCESS_TOKEN) credentials.access_token = PIPEDRIVE_ACCESS_TOKEN;
    if (PIPEDRIVE_API_TOKEN) credentials.api_token = PIPEDRIVE_API_TOKEN;
    if (PIPEDRIVE_COMPANY_DOMAIN) credentials.company_domain = PIPEDRIVE_COMPANY_DOMAIN;
    if (PIPEDRIVE_PIPELINE) credentials.default_pipeline_id = PIPEDRIVE_PIPELINE;
    if (PIPEDRIVE_STAGE) credentials.appointment_stage_id = PIPEDRIVE_STAGE;

    const config: ConnectorConfig = {
      integrationId: 'integration-test',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'pipedrive',
      isEnabled: true,
      credentials,
    };

    const cleanups: Cleanup[] = [];
    afterEach(async () => {
      await runCleanups(cleanups.splice(0), 'pipedrive');
    });

    // Match adapter base URL: company-domain → /api/v1, fallback → /v1.
    const apiBase = PIPEDRIVE_COMPANY_DOMAIN
      ? `https://${PIPEDRIVE_COMPANY_DOMAIN}.pipedrive.com/api/v1`
      : 'https://api.pipedrive.com/v1';

    const pdFetch = async (path: string, init?: RequestInit): Promise<Response> => {
      // Match adapter auth precedence: OAuth bearer first, then api_token query param.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      let url = `${apiBase}${path}`;
      if (PIPEDRIVE_ACCESS_TOKEN) {
        headers.Authorization = `Bearer ${PIPEDRIVE_ACCESS_TOKEN}`;
      } else if (PIPEDRIVE_API_TOKEN) {
        url += `${path.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(PIPEDRIVE_API_TOKEN)}`;
      }
      return fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    };
    const pdDelete = (resource: 'persons' | 'organizations' | 'deals' | 'activities', id: string) =>
      pdFetch(`/${resource}/${encodeURIComponent(id)}`, { method: 'DELETE' });

    const sweepPipedriveNamespace = async (
      phone: string,
      companyName: string,
      summary: string,
    ): Promise<void> => {
      const search = async (
        resource: 'persons' | 'organizations' | 'deals',
        term: string,
        fields: string,
      ): Promise<string[]> => {
        const res = await pdFetch(
          `/${resource}/search?term=${encodeURIComponent(term)}&fields=${fields}&exact_match=false&limit=25`,
        );
        if (!res.ok) return [];
        const body = await res.json() as { data?: { items?: Array<{ item?: { id?: number | string } }> } };
        return (body.data?.items ?? [])
          .map((it) => it.item?.id)
          .filter((v): v is number | string => v !== undefined && v !== null)
          .map((v) => String(v));
      };
      const personIds = await search('persons', phone, 'phone');
      const orgIds = await search('organizations', companyName, 'name');
      const dealIds = await search('deals', summary, 'title');
      for (const id of dealIds) await pdDelete('deals', id);
      for (const id of personIds) await pdDelete('persons', id);
      for (const id of orgIds) await pdDelete('organizations', id);
    };

    test(
      'creates Person + Organization + Deal and the Deal lands in the configured stage/pipeline',
      async () => {
        const suffix = uniqueSuffix();
        const phone = uniquePhone();
        const companyName = `Apt Booked Co ${suffix}`;
        const summary = `appointment.booked integration test ${suffix}`;
        const payload: ConnectorPayload = {
          type: 'appointment.booked',
          callerPhone: phone,
          callerFirstName: 'Apt',
          callerLastName: `Booked-${suffix}`,
          callerEmail: `apt-booked-${suffix}@example.invalid`,
          callerCompany: companyName,
          summary,
          appointmentDate: '2099-12-31',
          appointmentTime: '12:00',
        };

        cleanups.push(() => sweepPipedriveNamespace(phone, companyName, summary));

        const adapter = new PipedriveConnectorAdapter();
        const result = await adapter.execute(TENANT, config, payload);

        const meta = (result.meta ?? {}) as Record<string, unknown>;
        const personId = metaStr(meta, 'personId');
        const orgId = metaStr(meta, 'orgId');
        const dealId = metaStr(meta, 'dealId');
        const activityId = metaStr(meta, 'activityId');
        // Push parent-first so reverse-registration cleanup deletes child
        // records (Activity → Deal → Person → Organization) before parents.
        if (orgId) cleanups.push(() => pdDelete('organizations', orgId).then(() => undefined));
        if (personId) cleanups.push(() => pdDelete('persons', personId).then(() => undefined));
        if (dealId) cleanups.push(() => pdDelete('deals', dealId).then(() => undefined));
        if (activityId) cleanups.push(() => pdDelete('activities', activityId).then(() => undefined));

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(metaStr(meta, 'provider')).toBe('pipedrive');
        expect(personId).toMatch(/^\d+$/);
        expect(orgId).toMatch(/^\d+$/);
        expect(dealId).toMatch(/^\d+$/);
        expect(activityId).toMatch(/^\d+$/);

        const dealRes = await pdFetch(`/deals/${encodeURIComponent(dealId!)}`);
        expect(dealRes.status).toBe(200);
        const dealBody = await dealRes.json() as {
          success?: boolean;
          data?: {
            person_id?: { value?: number } | number;
            org_id?: { value?: number } | number;
            stage_id?: number;
            pipeline_id?: number;
          };
        };
        expect(dealBody.success).toBe(true);
        const personIdRaw = typeof dealBody.data?.person_id === 'object'
          ? dealBody.data?.person_id?.value
          : dealBody.data?.person_id;
        expect(String(personIdRaw)).toBe(personId);
        const orgIdRaw = typeof dealBody.data?.org_id === 'object'
          ? dealBody.data?.org_id?.value
          : dealBody.data?.org_id;
        expect(String(orgIdRaw)).toBe(orgId);
        if (PIPEDRIVE_STAGE) expect(String(dealBody.data?.stage_id)).toBe(PIPEDRIVE_STAGE);
        if (PIPEDRIVE_PIPELINE) expect(String(dealBody.data?.pipeline_id)).toBe(PIPEDRIVE_PIPELINE);
      },
      60_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Zoho
// ---------------------------------------------------------------------------

const ZOHO_TOKEN = env('ZOHO_SANDBOX_ACCESS_TOKEN');
const ZOHO_API_DOMAIN = env('ZOHO_SANDBOX_API_DOMAIN');
const ZOHO_STAGE = env('ZOHO_SANDBOX_APPOINTMENT_STAGE_ID');
const ZOHO_PIPELINE = env('ZOHO_SANDBOX_APPOINTMENT_PIPELINE_ID');
const ZOHO_ACCOUNTS_SERVER = env('ZOHO_SANDBOX_ACCOUNTS_SERVER');

describe.skipIf(!ZOHO_TOKEN || !ZOHO_API_DOMAIN)(
  'ZohoConnectorAdapter appointment.booked (live sandbox)',
  () => {
    const credentials: Record<string, string> = {
      access_token: ZOHO_TOKEN ?? '',
      api_domain: ZOHO_API_DOMAIN ?? '',
    };
    if (ZOHO_ACCOUNTS_SERVER) credentials.accounts_server = ZOHO_ACCOUNTS_SERVER;
    if (ZOHO_PIPELINE) credentials.appointment_pipeline_id = ZOHO_PIPELINE;
    if (ZOHO_STAGE) credentials.appointment_stage_id = ZOHO_STAGE;

    const config: ConnectorConfig = {
      integrationId: 'integration-test',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'zoho',
      isEnabled: true,
      credentials,
    };

    const cleanups: Cleanup[] = [];
    afterEach(async () => {
      await runCleanups(cleanups.splice(0), 'zoho');
    });

    const zohoFetch = async (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`${ZOHO_API_DOMAIN}/crm/v2${path}`, {
        ...init,
        headers: {
          Authorization: `Zoho-oauthtoken ${ZOHO_TOKEN}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
    const zohoDelete = (module: 'Contacts' | 'Accounts' | 'Deals' | 'Notes', id: string) =>
      zohoFetch(`/${module}/${encodeURIComponent(id)}`, { method: 'DELETE' });

    const sweepZohoNamespace = async (email: string, companyName: string): Promise<void> => {
      const search = async (
        module: 'Contacts' | 'Accounts' | 'Deals',
        query: string,
      ): Promise<string[]> => {
        const res = await zohoFetch(`/${module}/search?${query}`);
        // Zoho returns 204 on no-match (no body) — guard the parse.
        if (!res.ok || res.status === 204) return [];
        const body = await res.json() as { data?: Array<{ id?: string }> };
        return (body.data ?? []).map((r) => r.id).filter((v): v is string => !!v);
      };
      const dealIds = await search('Deals', `criteria=${encodeURIComponent(`(Deal_Name:starts_with:${companyName})`)}`);
      for (const id of dealIds) await zohoDelete('Deals', id);
      const contactIds = await search('Contacts', `email=${encodeURIComponent(email)}`);
      for (const id of contactIds) await zohoDelete('Contacts', id);
      const accountIds = await search('Accounts', `criteria=${encodeURIComponent(`(Account_Name:equals:${companyName})`)}`);
      for (const id of accountIds) await zohoDelete('Accounts', id);
    };

    test(
      'creates Contact + Account + Deal and the Deal lands in the configured stage/layout',
      async () => {
        const suffix = uniqueSuffix();
        const email = `apt-booked-${suffix}@example.invalid`;
        const companyName = `Apt Booked Co ${suffix}`;
        const payload: ConnectorPayload = {
          type: 'appointment.booked',
          callerPhone: uniquePhone(),
          callerFirstName: 'Apt',
          callerLastName: `Booked-${suffix}`,
          callerEmail: email,
          callerCompany: companyName,
          summary: `appointment.booked integration test ${suffix}`,
          appointmentDate: '2099-12-31',
          appointmentTime: '12:00',
        };

        cleanups.push(() => sweepZohoNamespace(email, companyName));

        const adapter = new ZohoConnectorAdapter();
        const result: ConnectorResult = await adapter.execute(TENANT, config, payload);

        const meta = (result.meta ?? {}) as Record<string, unknown>;
        const contactId = metaStr(meta, 'contactId');
        const accountId = metaStr(meta, 'accountId');
        const dealId = metaStr(meta, 'dealId');
        const noteId = metaStr(meta, 'noteId');
        // Push parent-first so reverse-registration cleanup deletes child
        // records (Notes → Deals → Contacts → Accounts) before parents.
        if (accountId) cleanups.push(() => zohoDelete('Accounts', accountId).then(() => undefined));
        if (contactId) cleanups.push(() => zohoDelete('Contacts', contactId).then(() => undefined));
        if (dealId) cleanups.push(() => zohoDelete('Deals', dealId).then(() => undefined));
        if (noteId) cleanups.push(() => zohoDelete('Notes', noteId).then(() => undefined));

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(metaStr(meta, 'provider')).toBe('zoho');
        expect(contactId).toMatch(/^\d+$/);
        expect(accountId).toMatch(/^\d+$/);
        expect(dealId).toMatch(/^\d+$/);
        expect(noteId).toMatch(/^\d+$/);

        const dealRes = await zohoFetch(`/Deals/${encodeURIComponent(dealId!)}`);
        expect(dealRes.status).toBe(200);
        const dealBody = await dealRes.json() as {
          data?: Array<{ id: string; Stage?: string; Layout?: { id: string } | null; Account_Name?: { id: string } | null }>;
        };
        const dealRecord = dealBody.data?.[0];
        expect(dealRecord?.id).toBe(dealId);
        expect(dealRecord?.Account_Name?.id).toBe(accountId);
        if (ZOHO_STAGE) expect(dealRecord?.Stage).toBe(ZOHO_STAGE);
        if (ZOHO_PIPELINE) expect(dealRecord?.Layout?.id).toBe(ZOHO_PIPELINE);
      },
      60_000,
    );
  },
);
