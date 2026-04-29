import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { HubSpotConnectorAdapter, fetchHubSpotDealPipelines } from './hubspot';
import type { ConnectorConfig, ConnectorPayload } from '../types';
import type { TenantId } from '../../../core/types';

vi.mock('../tokenRefresh', () => ({
  ensureFreshOAuthToken: async (cfg: ConnectorConfig) => cfg,
}));

interface FetchExpectation {
  match: (url: string, init?: RequestInit) => boolean;
  response: { status?: number; body: unknown };
}

function setupFetch(expectations: FetchExpectation[]): {
  calls: Array<{ url: string; method: string; body?: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    let parsedBody: unknown;
    try {
      parsedBody = init?.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      parsedBody = init?.body;
    }
    calls.push({ url, method, body: parsedBody });

    const found = expectations.find((e) => e.match(url, init));
    if (!found) {
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }
    const status = found.response.status ?? 200;
    return new Response(JSON.stringify(found.response.body), { status });
  }));
  return { calls };
}

const TENANT: TenantId = 'tenant-test' as TenantId;
const CONFIG: ConnectorConfig = {
  integrationId: 'int-1',
  tenantId: TENANT,
  connectorType: 'crm',
  provider: 'hubspot',
  isEnabled: true,
  credentials: { access_token: 'tok-xyz' },
};

describe('HubSpotConnectorAdapter appointment.booked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T10:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('creates contact + company + deal and returns IDs in meta', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/contacts/search') && i?.method === 'POST',
        response: { body: { total: 0, results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/contacts') && i?.method === 'POST',
        response: { body: { id: 'contact-1' } },
      },
      {
        match: (u, i) => u.endsWith('/companies/search') && i?.method === 'POST',
        response: { body: { total: 0, results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/companies') && i?.method === 'POST',
        response: { body: { id: 'company-1' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/contacts/contact-1/associations/companies/company-1'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/deals/search') && i?.method === 'POST',
        response: { body: { total: 0, results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/deals') && i?.method === 'POST',
        response: { body: { id: 'deal-1' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/deals/deal-1/associations/companies/company-1'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/notes') && i?.method === 'POST',
        response: { body: { id: 'note-1' } },
      },
    ]);

    const adapter = new HubSpotConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      callerPhone: '+15551234567',
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
      summary: 'Booked product demo',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);

    expect(result.success).toBe(true);
    expect(result.externalId).toBe('note-1');
    expect(result.meta).toMatchObject({
      contactId: 'contact-1',
      companyId: 'company-1',
      dealId: 'deal-1',
      engagementId: 'note-1',
      provider: 'hubspot',
    });

    const dealCall = calls.find((c) => c.url.endsWith('/objects/deals') && c.method === 'POST');
    expect(dealCall).toBeDefined();
    const dealBody = dealCall!.body as {
      properties: Record<string, string>;
      associations: Array<{ to: { id: string }; types: Array<{ associationTypeId: number }> }>;
    };
    expect(dealBody.properties.dealname).toContain('Acme Inc');
    expect(dealBody.associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: { id: 'contact-1' }, types: [expect.objectContaining({ associationTypeId: 3 })] }),
        expect.objectContaining({ to: { id: 'company-1' }, types: [expect.objectContaining({ associationTypeId: 5 })] }),
      ]),
    );
  });

  test('moves an existing open deal into the configured appointment stage', async () => {
    const cfg: ConnectorConfig = {
      ...CONFIG,
      credentials: {
        ...CONFIG.credentials,
        appointment_pipeline_id: 'pipe-A',
        appointment_stage_id: 'stage-appointment',
      },
    };
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/contacts/search') && i?.method === 'POST',
        response: { body: { total: 1, results: [{ id: 'contact-9' }] } },
      },
      {
        match: (u, i) => u.endsWith('/companies/search') && i?.method === 'POST',
        response: { body: { total: 1, results: [{ id: 'company-9' }] } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/contacts/contact-9/associations/companies/company-9'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/deals/search') && i?.method === 'POST',
        response: { body: { total: 1, results: [{ id: 'deal-9' }] } },
      },
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/deals/deal-9') && i?.method === 'PATCH',
        response: { body: { id: 'deal-9' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/deals/deal-9/associations/companies/company-9'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/notes') && i?.method === 'POST',
        response: { body: { id: 'note-9' } },
      },
    ]);

    const adapter = new HubSpotConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      callerPhone: '+15551234567',
      callerCompany: 'Acme Inc',
    };

    const result = await adapter.execute(TENANT, cfg, payload);

    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      contactId: 'contact-9',
      companyId: 'company-9',
      dealId: 'deal-9',
      pipelineId: 'pipe-A',
      stageId: 'stage-appointment',
      dealStageMoved: true,
    });

    const patchCall = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/objects/deals/deal-9'));
    expect(patchCall).toBeDefined();
    expect(patchCall!.body).toMatchObject({
      properties: { dealstage: 'stage-appointment', pipeline: 'pipe-A' },
    });
  });

  test('honors hint IDs from payload to skip lookups', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/objects/notes') && i?.method === 'POST',
        response: { body: { id: 'note-hint' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/deals/deal-hint/associations/companies/company-hint'),
        response: { body: { results: [] } },
      },
    ]);

    const adapter = new HubSpotConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      contactId: 'contact-hint',
      companyId: 'company-hint',
      dealId: 'deal-hint',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);
    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      contactId: 'contact-hint',
      companyId: 'company-hint',
      dealId: 'deal-hint',
    });
    // No search/create calls happened; only the deal->company association and the note creation.
    expect(calls.find((c) => c.url.includes('/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/contacts') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/companies') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/deals') && c.method === 'POST')).toBeUndefined();
  });

  test('canonical-only payload (accountId/opportunityId) skips company + deal lookups and emits aliases', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/objects/notes') && i?.method === 'POST',
        response: { body: { id: 'note-canon' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/deals/deal-canon/associations/companies/company-canon'),
        response: { body: { results: [] } },
      },
    ]);

    const adapter = new HubSpotConnectorAdapter();
    // Canonical Salesforce-style names only — no native companyId/dealId.
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      contactId: 'contact-canon',
      accountId: 'company-canon',
      opportunityId: 'deal-canon',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);
    expect(result.success).toBe(true);
    expect(result.externalId).toBe('note-canon');
    // Both native and canonical aliases present in meta.
    expect(result.meta).toMatchObject({
      contactId: 'contact-canon',
      companyId: 'company-canon',
      dealId: 'deal-canon',
      accountId: 'company-canon',
      opportunityId: 'deal-canon',
      provider: 'hubspot',
    });
    // No search or create traffic for company/deal/contact paths.
    expect(calls.find((c) => c.url.includes('/companies/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/deals/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/contacts/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/companies') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/deals') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/contacts') && c.method === 'POST')).toBeUndefined();
  });

  test('canonical-only payload on call.completed skips company lookup and emits aliases', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/objects/calls') && i?.method === 'POST',
        response: { body: { id: 'call-canon' } },
      },
    ]);

    const adapter = new HubSpotConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'call.completed',
      contactId: 'contact-canon-2',
      accountId: 'company-canon-2',
      opportunityId: 'deal-canon-2',
      summary: 'Repeat caller',
      durationSeconds: 30,
      callerCompany: 'Acme Inc',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);
    expect(result.success).toBe(true);
    expect(result.externalId).toBe('call-canon');
    expect(result.meta).toMatchObject({
      contactId: 'contact-canon-2',
      companyId: 'company-canon-2',
      dealId: 'deal-canon-2',
      accountId: 'company-canon-2',
      opportunityId: 'deal-canon-2',
      provider: 'hubspot',
    });
    // No company search/create triggered even though callerCompany was supplied,
    // because companyId was already resolved via the canonical accountId hint.
    expect(calls.find((c) => c.url.includes('/companies/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/companies') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/contacts/search'))).toBeUndefined();
  });
});

describe('HubSpotConnectorAdapter retry-with-backoff (BL-014 Task #1111)', () => {
  // Real timers because retryFetch's backoff uses setTimeout — with fake
  // timers the retry sleep would stall forever and the test would time out.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // BL-014 (Task #1111): the older HubSpot adapter routes every call through
  // the shared `hubspotFetch` -> `retryFetch` helper, but the existing tests
  // only exercised the happy path / cache-stale behaviours. Without these two
  // tests, a regression that swapped `hubspotFetch` for a plain `fetch`
  // (e.g. during a refactor) would silently pass CI even though the dispatch
  // would no longer recover from a transient upstream wobble or stay inside
  // the 60s budget on a hostile one. The pattern mirrors the QuickBooks /
  // Zoho / Google Calendar / Outlook Calendar tests added in Task #981.
  test(
    'recovers from a transient 5xx (502 → 503 → 200) on the call engagement POST and ultimately succeeds',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let attempt = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        attempt += 1;
        // Two transient gateway failures must be retried by the helper
        // BEFORE the adapter even sees them; the third attempt returns the
        // created Call engagement as if nothing happened.
        if (attempt === 1) {
          return new Response(JSON.stringify({ message: 'bad gateway' }), { status: 502 });
        }
        if (attempt === 2) {
          return new Response(JSON.stringify({ message: 'service unavailable' }), { status: 503 });
        }
        return new Response(JSON.stringify({ id: 'call-5xx' }), { status: 200 });
      }));

      const adapter = new HubSpotConnectorAdapter();
      // Hint the contactId so handleCallCompleted skips the contact search /
      // create lookup and only calls logCallEngagement — that keeps the
      // test focused on a single endpoint and lets us count attempts cleanly.
      const payload: ConnectorPayload = {
        type: 'call.completed',
        contactId: 'contact-hint',
        summary: 'AI voice call completed',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('call-5xx');
      expect(result.meta).toMatchObject({
        contactId: 'contact-hint',
        engagementId: 'call-5xx',
        provider: 'hubspot',
      });
      // Two 5xx + one successful retry, all targeting the same calls
      // engagement endpoint.
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/crm/v3/objects/calls'))).toBe(true);
      expect(calls.every((c) => c.method === 'POST')).toBe(true);
    },
  );

  test(
    'exhausts at exactly 3 attempts on persistent 5xx, surfaces a clean error within the 60s budget',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        // Persistent 503 — HubSpot's helper MUST cap at 3 attempts and let
        // the adapter convert the final failed Response into a clean
        // {success:false, error:'HubSpot API error 503: ...'} result rather
        // than looping or hanging until the per-dispatch deadline fires.
        return new Response(JSON.stringify({ message: 'service unavailable' }), {
          status: 503,
        });
      }));

      const startedAt = Date.now();
      const adapter = new HubSpotConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        contactId: 'contact-hint',
        summary: 'AI voice call completed',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);
      const elapsedMs = Date.now() - startedAt;

      expect(result.success).toBe(false);
      // The adapter wraps the helper's final response in its own status
      // string so callers get a stable, parseable failure instead of a raw
      // exception or a never-resolving promise.
      expect(result.error).toMatch(/HubSpot API error 503/);
      expect(result.externalId).toBeUndefined();
      // Exactly three POSTs to the calls engagement endpoint: the helper
      // does NOT make a 4th attempt, which is what bounds the dispatch
      // inside the 60s budget (3 attempts × 15s per-attempt + 1s + 4s
      // sleeps = 50s worst case).
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/crm/v3/objects/calls'))).toBe(true);
      expect(calls.every((c) => c.method === 'POST')).toBe(true);
      // Total wall-clock comfortably inside the 60s budget — proving the
      // helper did not stretch past it on a hostile upstream.
      expect(elapsedMs).toBeLessThan(60_000);
    },
  );

  // BL-014 (Task #1111): the same retry contract MUST also cover transport-
  // layer failures (per-attempt timeouts surfaced as `AbortError`, undici's
  // `TypeError('fetch failed')` for ECONN/ETIMEDOUT/ENOTFOUND, etc.) since
  // the 60s budget guarantee is meaningless if the helper would only retry
  // on HTTP statuses. Pair the 5xx tests above with timeout-recovery and
  // timeout-exhaustion variants so a regression that narrowed the
  // `shouldRetry` predicate would be caught here.
  test(
    'recovers from a transient transport timeout (TypeError → TypeError → 200) on the call engagement POST',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let attempt = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        attempt += 1;
        // Two transient transport failures (the shape Node's undici-based
        // fetch surfaces on ECONNRESET/ETIMEDOUT) must be retried by the
        // helper before the adapter sees them.
        if (attempt <= 2) {
          throw new TypeError('fetch failed');
        }
        return new Response(JSON.stringify({ id: 'call-timeout' }), { status: 200 });
      }));

      const adapter = new HubSpotConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        contactId: 'contact-hint',
        summary: 'AI voice call completed',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('call-timeout');
      // Two transport failures + one successful retry, all targeting the
      // same calls engagement endpoint.
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/crm/v3/objects/calls'))).toBe(true);
    },
  );

  test(
    'exhausts at exactly 3 attempts on persistent transport timeouts, surfaces a clean error within the 60s budget',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        // Persistent transport failure — the helper MUST cap at 3 attempts
        // and let the adapter's outer try/catch turn the final thrown
        // error into a {success:false, error:'fetch failed'} result rather
        // than looping or hanging.
        throw new TypeError('fetch failed');
      }));

      const startedAt = Date.now();
      const adapter = new HubSpotConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        contactId: 'contact-hint',
        summary: 'AI voice call completed',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);
      const elapsedMs = Date.now() - startedAt;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/fetch failed/);
      expect(result.externalId).toBeUndefined();
      // Exactly three attempts: the helper does NOT make a 4th, which is
      // what bounds the dispatch inside the 60s budget on a hostile
      // upstream that never returns a response at all.
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/crm/v3/objects/calls'))).toBe(true);
      expect(elapsedMs).toBeLessThan(60_000);
    },
  );
});

describe('fetchHubSpotDealPipelines', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns pipelines with stages sorted by displayOrder', async () => {
    setupFetch([
      {
        match: (u, i) =>
          u.endsWith('/crm/v3/pipelines/deals') && (i?.method ?? 'GET') === 'GET',
        response: {
          body: {
            results: [
              {
                id: 'pipe-2',
                label: 'Sales Pipeline',
                displayOrder: 1,
                stages: [
                  { id: 'stage-b', label: 'Closed Won', displayOrder: 2 },
                  { id: 'stage-a', label: 'New Lead', displayOrder: 0 },
                ],
              },
              {
                id: 'pipe-1',
                label: 'Onboarding',
                displayOrder: 0,
                stages: [{ id: 'stage-c', label: 'Welcome', displayOrder: 0 }],
              },
            ],
          },
        },
      },
    ]);

    const pipelines = await fetchHubSpotDealPipelines(TENANT, CONFIG);
    expect(pipelines.map((p) => p.id)).toEqual(['pipe-1', 'pipe-2']);
    expect(pipelines[1].stages.map((s) => s.id)).toEqual(['stage-a', 'stage-b']);
  });

  test('throws when access token is missing', async () => {
    await expect(
      fetchHubSpotDealPipelines(TENANT, {
        ...CONFIG,
        credentials: {},
      }),
    ).rejects.toThrow(/missing access_token/);
  });

  test('throws on non-OK response', async () => {
    setupFetch([
      {
        match: (u) => u.endsWith('/crm/v3/pipelines/deals'),
        response: { status: 401, body: { message: 'Invalid token' } },
      },
    ]);
    await expect(fetchHubSpotDealPipelines(TENANT, CONFIG)).rejects.toThrow(/401/);
  });
});
