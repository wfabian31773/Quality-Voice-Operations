import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipedriveConnectorAdapter, fetchPipedrivePipelinesAndStages } from './pipedrive';
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
  provider: 'pipedrive',
  isEnabled: true,
  credentials: { access_token: 'tok', company_domain: 'acmedomain' },
};

describe('PipedriveConnectorAdapter appointment.booked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T10:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('creates org + person + deal and returns IDs in meta', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.includes('/organizations/search') && (!i?.method || i.method === 'GET'),
        response: { body: { success: true, data: { items: [] } } },
      },
      {
        match: (u, i) => u.includes('/organizations') && i?.method === 'POST',
        response: { body: { success: true, data: { id: 555 } } },
      },
      {
        match: (u, i) => u.includes('/persons/search') && (!i?.method || i.method === 'GET'),
        response: { body: { success: true, data: { items: [] } } },
      },
      {
        match: (u, i) => u.endsWith('/persons') || (u.includes('/persons?') && i?.method === 'POST'),
        response: { body: { success: true, data: { id: 111 } } },
      },
      {
        match: (u, i) => u.includes('/persons/111/deals') && (!i?.method || i.method === 'GET'),
        response: { body: { success: true, data: null } },
      },
      {
        match: (u, i) => (u.endsWith('/deals') || u.includes('/deals?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 999 } } },
      },
      {
        match: (u, i) => (u.endsWith('/activities') || u.includes('/activities?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 777 } } },
      },
    ]);

    const adapter = new PipedriveConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      callerPhone: '+15551234567',
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);

    expect(result.success).toBe(true);
    expect(result.externalId).toBe('777');
    expect(result.meta).toMatchObject({
      personId: 111,
      orgId: 555,
      dealId: 999,
      // Salesforce-style aliases so the cross-provider caller-identity cache
      // can store both shapes verbatim and the next event for the same
      // caller can re-inject either name as a hint.
      contactId: '111',
      accountId: '555',
      opportunityId: '999',
      activityId: '777',
      provider: 'pipedrive',
    });

    // Person create body should include org_id linking it to the org.
    const personCreate = calls.find((c) => c.method === 'POST' && /\/persons(\?|$)/.test(c.url));
    expect(personCreate).toBeDefined();
    expect(personCreate!.body).toMatchObject({ org_id: 555 });

    // Deal create body should include person_id and org_id.
    const dealCreate = calls.find((c) => c.method === 'POST' && /\/deals(\?|$)/.test(c.url));
    expect(dealCreate).toBeDefined();
    expect(dealCreate!.body).toMatchObject({ person_id: 111, org_id: 555, status: 'open' });
  });

  test('moves an existing open deal into the configured stage on appointment.booked', async () => {
    const cfg: ConnectorConfig = {
      ...CONFIG,
      credentials: { ...CONFIG.credentials, appointment_stage_id: '42' },
    };
    const { calls } = setupFetch([
      {
        match: (u) => u.includes('/organizations/search'),
        response: { body: { success: true, data: { items: [{ item: { id: 33 } }] } } },
      },
      {
        match: (u) => u.includes('/persons/search'),
        response: { body: { success: true, data: { items: [{ item: { id: 22 } }] } } },
      },
      {
        match: (u) => u.includes('/persons/22/deals'),
        response: { body: { success: true, data: [{ id: 88, status: 'open', title: 'existing' }] } },
      },
      {
        match: (u, i) => u.includes('/deals/88') && i?.method === 'PUT',
        response: { body: { success: true } },
      },
      {
        match: (u, i) => (u.endsWith('/activities') || u.includes('/activities?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 7 } } },
      },
    ]);

    const adapter = new PipedriveConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      callerPhone: '+15551234567',
      callerCompany: 'Acme Inc',
    };

    const result = await adapter.execute(TENANT, cfg, payload);
    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      personId: 22,
      orgId: 33,
      dealId: 88,
      contactId: '22',
      accountId: '33',
      opportunityId: '88',
      activityId: '7',
      stageId: 42,
      dealStageMoved: true,
    });

    const putDeal = calls.find((c) => c.method === 'PUT' && c.url.includes('/deals/88'));
    expect(putDeal).toBeDefined();
    expect(putDeal!.body).toMatchObject({ stage_id: 42, org_id: 33 });
  });

  test('honors hint IDs from payload to skip lookups', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.includes('/deals/3') && i?.method === 'PUT',
        response: { body: { success: true } },
      },
      {
        match: (u, i) => (u.endsWith('/activities') || u.includes('/activities?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 5 } } },
      },
    ]);

    const adapter = new PipedriveConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      personId: 1,
      orgId: 2,
      dealId: 3,
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);
    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      personId: 1,
      orgId: 2,
      dealId: 3,
      contactId: '1',
      accountId: '2',
      opportunityId: '3',
      activityId: '5',
    });

    expect(calls.find((c) => c.url.includes('/persons/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/organizations/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/deals') && c.method === 'POST')).toBeUndefined();
  });

  test('honors canonical Salesforce-style hint IDs (contactId/accountId/opportunityId) to skip lookups', async () => {
    // The cache layer stores Pipedrive's native IDs *and* the Salesforce-style
    // canonical aliases. If a downstream caller (or a legacy cache row that
    // pre-dates the `extras` JSONB column) re-injects only the canonical
    // names, the adapter must treat them as equivalent to personId/orgId/dealId
    // so the lookup-skipping speed-up still applies.
    const { calls } = setupFetch([
      {
        match: (u, i) => u.includes('/deals/3') && i?.method === 'PUT',
        response: { body: { success: true } },
      },
      {
        match: (u, i) => (u.endsWith('/activities') || u.includes('/activities?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 9 } } },
      },
    ]);

    const adapter = new PipedriveConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      // String form is what the cache replays — the adapter must coerce.
      contactId: '1',
      accountId: '2',
      opportunityId: '3',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);
    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      personId: 1,
      orgId: 2,
      dealId: 3,
      contactId: '1',
      accountId: '2',
      opportunityId: '3',
      activityId: '9',
    });

    expect(calls.find((c) => c.url.includes('/persons/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/organizations/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/deals') && c.method === 'POST')).toBeUndefined();

    // The activity body should still use Pipedrive's native field names — i.e.
    // the canonical hints are translated, not passed through to the API.
    const activity = calls.find((c) => c.method === 'POST' && /\/activities(\?|$)/.test(c.url));
    expect(activity).toBeDefined();
    expect(activity!.body).toMatchObject({ person_id: 1, org_id: 2, deal_id: 3 });
  });

  test('canonical hints round-trip through call.completed too', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => (u.endsWith('/activities') || u.includes('/activities?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 12 } } },
      },
    ]);

    const adapter = new PipedriveConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'call.completed',
      callerPhone: '+15551234567',
      summary: 'Cached caller',
      durationSeconds: 30,
      contactId: '111',
      accountId: '555',
      opportunityId: '999',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);
    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      personId: 111,
      orgId: 555,
      dealId: 999,
      contactId: '111',
      accountId: '555',
      opportunityId: '999',
      activityId: '12',
    });

    // Zero search/create traffic — canonical hints fully short-circuited.
    expect(calls.find((c) => c.url.includes('/persons/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/organizations/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/persons/111/deals'))).toBeUndefined();
    expect(calls.find((c) => c.method === 'POST' && /\/persons(\?|$)/.test(c.url))).toBeUndefined();
    expect(calls.find((c) => c.method === 'POST' && /\/organizations(\?|$)/.test(c.url))).toBeUndefined();
    expect(calls.find((c) => c.method === 'POST' && /\/deals(\?|$)/.test(c.url))).toBeUndefined();

    const activity = calls.find((c) => c.method === 'POST' && /\/activities(\?|$)/.test(c.url));
    expect(activity).toBeDefined();
    expect(activity!.body).toMatchObject({ person_id: 111, org_id: 555, deal_id: 999 });
  });
});

describe('PipedriveConnectorAdapter retry-with-backoff (BL-014 Task #1111)', () => {
  // Real timers because retryFetch's backoff uses setTimeout — with fake
  // timers the retry sleep would stall forever and the test would time out.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // BL-014 (Task #1111): the older Pipedrive adapter routes every call through
  // the shared `pdFetch` -> `retryFetch` helper, but the existing tests only
  // exercised the happy path / cache-stale behaviours. Without these two tests
  // a regression that swapped `retryFetch` for a plain `fetch` (e.g. during a
  // refactor) would silently pass CI even though the dispatch would no longer
  // recover from a transient upstream wobble or stay inside the 60s budget on
  // a hostile one. The pattern mirrors the QuickBooks / Zoho / Google Calendar
  // / Outlook Calendar tests added in Task #981.
  test(
    'recovers from a transient 5xx (502 → 503 → 200) on the activities POST and ultimately succeeds',
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
        // created Activity as if nothing happened.
        if (attempt === 1) {
          return new Response(JSON.stringify({ success: false, error: 'bad gateway' }), {
            status: 502,
          });
        }
        if (attempt === 2) {
          return new Response(JSON.stringify({ success: false, error: 'service unavailable' }), {
            status: 503,
          });
        }
        return new Response(
          JSON.stringify({ success: true, data: { id: 5151 } }),
          { status: 200 },
        );
      }));

      const adapter = new PipedriveConnectorAdapter();
      // Hint personId/orgId/dealId so handleCallCompleted skips the
      // person/org/deal lookups and only calls POST /activities — that keeps
      // the test focused on a single endpoint and lets us count attempts
      // cleanly.
      const payload: ConnectorPayload = {
        type: 'call.completed',
        personId: 111,
        orgId: 555,
        dealId: 999,
        summary: 'AI voice call completed',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('5151');
      expect(result.meta).toMatchObject({
        personId: 111,
        orgId: 555,
        dealId: 999,
        activityId: '5151',
        provider: 'pipedrive',
      });
      // Two 5xx + one successful retry, all targeting the same activities
      // endpoint.
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => /\/activities(\?|$)/.test(c.url))).toBe(true);
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
        // Persistent 503 — Pipedrive's helper MUST cap at 3 attempts and
        // let the adapter convert the final failed Response into a clean
        // {success:false, error:'Pipedrive 503: ...'} result rather than
        // looping or hanging until the per-dispatch deadline fires. The
        // body deliberately does NOT include "not found" / "deleted"
        // wording so it isn't misclassified as a stale-record signal.
        return new Response(JSON.stringify({ success: false, error: 'service unavailable' }), {
          status: 503,
        });
      }));

      const startedAt = Date.now();
      const adapter = new PipedriveConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        personId: 111,
        orgId: 555,
        dealId: 999,
        summary: 'AI voice call completed',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);
      const elapsedMs = Date.now() - startedAt;

      expect(result.success).toBe(false);
      // The adapter wraps the helper's final response in its own status
      // string so callers get a stable, parseable failure instead of a raw
      // exception or a never-resolving promise.
      expect(result.error).toMatch(/Pipedrive 503/);
      expect(result.externalId).toBeUndefined();
      // Exactly three POSTs to the activities endpoint: the helper does NOT
      // make a 4th attempt, which is what bounds the dispatch inside the
      // 60s budget (3 attempts × 15s per-attempt + 1s + 4s sleeps =
      // 50s worst case).
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => /\/activities(\?|$)/.test(c.url))).toBe(true);
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
    'recovers from a transient transport timeout (TypeError → TypeError → 200) on the activities POST',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let attempt = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        attempt += 1;
        if (attempt <= 2) {
          throw new TypeError('fetch failed');
        }
        return new Response(
          JSON.stringify({ success: true, data: { id: 7777 } }),
          { status: 200 },
        );
      }));

      const adapter = new PipedriveConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        personId: 111,
        orgId: 555,
        dealId: 999,
        summary: 'AI voice call completed',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('7777');
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => /\/activities(\?|$)/.test(c.url))).toBe(true);
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
        // Persistent transport failure — pdFetch catches the final thrown
        // error from retryFetch and converts it to a non-OK envelope; the
        // adapter then surfaces a clean {success:false} result.
        throw new TypeError('fetch failed');
      }));

      const startedAt = Date.now();
      const adapter = new PipedriveConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        personId: 111,
        orgId: 555,
        dealId: 999,
        summary: 'AI voice call completed',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);
      const elapsedMs = Date.now() - startedAt;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/fetch failed/);
      expect(result.externalId).toBeUndefined();
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => /\/activities(\?|$)/.test(c.url))).toBe(true);
      expect(elapsedMs).toBeLessThan(60_000);
    },
  );
});

describe('fetchPipedrivePipelinesAndStages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('groups stages under their pipelines and sorts by order_nr', async () => {
    setupFetch([
      {
        match: (u) => u.includes('/api/v1/pipelines'),
        response: {
          body: {
            success: true,
            data: [
              { id: 2, name: 'Pipeline B', order_nr: 1 },
              { id: 1, name: 'Pipeline A', order_nr: 0 },
            ],
          },
        },
      },
      {
        match: (u) => u.includes('/api/v1/stages'),
        response: {
          body: {
            success: true,
            data: [
              { id: 11, name: 'Won', pipeline_id: 1, order_nr: 1 },
              { id: 10, name: 'Lead', pipeline_id: 1, order_nr: 0 },
              { id: 20, name: 'Welcome', pipeline_id: 2, order_nr: 0 },
            ],
          },
        },
      },
    ]);

    const pipelines = await fetchPipedrivePipelinesAndStages(TENANT, CONFIG);
    expect(pipelines.map((p) => p.id)).toEqual([1, 2]);
    expect(pipelines[0].stages.map((s) => s.id)).toEqual([10, 11]);
    expect(pipelines[1].stages.map((s) => s.id)).toEqual([20]);
  });

  test('throws when both access_token and api_token are missing', async () => {
    await expect(
      fetchPipedrivePipelinesAndStages(TENANT, {
        ...CONFIG,
        credentials: { company_domain: 'acmedomain' },
      }),
    ).rejects.toThrow(/missing access_token or api_token/);
  });

  test('throws on non-OK pipelines response', async () => {
    setupFetch([
      {
        match: (u) => u.includes('/api/v1/pipelines'),
        response: { status: 500, body: { success: false } },
      },
      {
        match: (u) => u.includes('/api/v1/stages'),
        response: { body: { success: true, data: [] } },
      },
    ]);
    await expect(fetchPipedrivePipelinesAndStages(TENANT, CONFIG)).rejects.toThrow(/500/);
  });
});
