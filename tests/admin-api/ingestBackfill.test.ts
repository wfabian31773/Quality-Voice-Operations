/**
 * Route-level coverage for the federated call ingestion backfill endpoint
 * (`POST /v1/ingest/calls/backfill`) and the freshness window enforcement
 * added to the live endpoint (`POST /v1/ingest/calls`). Tracks task BL-041.
 *
 * The behavioural contract under test:
 *
 *   1. The live endpoint rejects events whose `start_time` is older than
 *      `INGEST_FRESH_WINDOW_DAYS` (currently 7) and points the caller at the
 *      backfill endpoint.
 *   2. The backfill endpoint requires a `backfill_attestation` block.
 *   3. The backfill endpoint accepts events older than 7 days but younger
 *      than `INGEST_BACKFILL_WINDOW_DAYS` (currently 30).
 *   4. Events older than 30 days or in the future are rejected by both
 *      endpoints.
 *   5. Idempotency is keyed on `(tenant_id, idempotency_key)` only — never
 *      on `external_id` — so a fresh idempotency token always re-issues a
 *      correction even for the same `external_id`. Duplicate keys return 409.
 *
 * The DB and rate limiter are mocked so the tests focus on the HTTP contract
 * (status codes, error shapes, attestation echo).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import {
  INGEST_BACKFILL_WINDOW_DAYS,
  INGEST_FRESH_WINDOW_DAYS,
} from '../../shared/ingest/eventTypes';

// --------------------------------------------------------------------------
// Mock the platform pool. `pool.connect()` returns a fake client whose
// `query` method is dispatched by SQL prefix. Each test resets the dispatch
// table via `setNextEventInsertResult()` so we can simulate "first time"
// vs "duplicate idempotency key" cases without rewiring everything.
// --------------------------------------------------------------------------

let nextIngestInsertReturnsRow = true;

/**
 * In-memory state shared by the fake DB so multi-request tests (e.g.
 * "submit then correct") see consistent reads. Keyed by external_id.
 */
interface ExistingCallRow {
  id: string;
  total_cost_cents: number;
  duration_seconds: number;
  start_time: string;
  direction: string;
  llm_cost_cents: number;
}
const existingCallsByExternalId = new Map<string, ExistingCallRow>();
const existingCallsBySessionId = new Map<string, ExistingCallRow>();

function makeFakeClient() {
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      const trimmed = sql.trimStart();
      if (trimmed.startsWith('BEGIN') || trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('SELECT set_config')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('INSERT INTO ingest_events')) {
        return nextIngestInsertReturnsRow
          ? { rows: [{ id: 'evt-1' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('UPDATE ingest_events')) {
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith('SELECT id FROM agents')) {
        return { rows: [{ id: 'agent-1' }], rowCount: 1 };
      }
      if (trimmed.startsWith('SELECT external_id FROM call_sessions')) {
        const v = values ?? [];
        const candidates = (v[1] as string[]) ?? [];
        const found = candidates.filter((id) => existingCallsByExternalId.has(id));
        return {
          rows: found.map((id) => ({ external_id: id })),
          rowCount: found.length,
        };
      }
      if (trimmed.startsWith('SELECT id, total_cost_cents, duration_seconds')) {
        const externalId = String((values ?? [])[1]);
        const row = existingCallsByExternalId.get(externalId);
        return row
          ? {
              rows: [{
                id: row.id,
                total_cost_cents: row.total_cost_cents,
                duration_seconds: row.duration_seconds,
                start_time: row.start_time,
                direction: row.direction,
              }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('SELECT llm_cost_cents FROM conversation_costs')) {
        const callSessionId = String((values ?? [])[1]);
        const row = existingCallsBySessionId.get(callSessionId);
        return row
          ? { rows: [{ llm_cost_cents: row.llm_cost_cents }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('SELECT id FROM call_quality_scores')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('INSERT INTO call_sessions')) {
        const v = values ?? [];
        const externalId = String(v[11]);
        const id = `call-${externalId}`;
        const row: ExistingCallRow = {
          id,
          total_cost_cents: Number(v[10]),
          duration_seconds: Number(v[9]),
          start_time: String(v[7]),
          direction: String(v[3]),
          llm_cost_cents: 0,
        };
        existingCallsByExternalId.set(externalId, row);
        existingCallsBySessionId.set(id, row);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (trimmed.startsWith('UPDATE call_sessions')) {
        // Index map matches the production query:
        //   $1 tenant_id, $2 external_id, $3 call_sid, $4 agent_id,
        //   $5 lifecycle_state, $6 start_time, $7 end_time,
        //   $8 duration_seconds, $9 total_cost_cents, $10 context,
        //   $11 escalation_reason
        const v = values ?? [];
        const externalId = String(v[1]);
        const row = existingCallsByExternalId.get(externalId);
        if (row) {
          row.start_time = String(v[6]);
          row.duration_seconds = Number(v[7]);
          row.total_cost_cents = Number(v[8]);
        }
        return { rows: [{ id: row?.id ?? `call-${externalId}` }], rowCount: 1 };
      }
      if (trimmed.startsWith('INSERT INTO conversation_costs')) {
        const v = values ?? [];
        const callSessionId = String(v[1]);
        const row = existingCallsBySessionId.get(callSessionId);
        if (row) row.llm_cost_cents = Number(v[2]);
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith('INSERT INTO call_quality_scores') ||
          trimmed.startsWith('INSERT INTO usage_metrics') ||
          trimmed.startsWith('INSERT INTO daily_org_usage') ||
          trimmed.startsWith('UPDATE agents')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return client;
}

const allClients: ReturnType<typeof makeFakeClient>[] = [];

// `pool.query` exists on the real pg.Pool and is used by best-effort writes
// (e.g. the post-commit `recordBackfillCrossDayAlert` finance alert) that
// don't want to manage their own transaction. The test mock pipes those
// calls through a fresh fake client so test assertions keep working with the
// existing `allClients.flatMap(c => c.query.mock.calls)` pattern.
vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => {
      const c = makeFakeClient();
      allClients.push(c);
      return c;
    },
    query: async (sql: string, values?: unknown[]) => {
      const c = makeFakeClient();
      allClients.push(c);
      return c.query(sql, values);
    },
  }),
  withTenantContext: vi.fn(async (_client, _tenantId, fn) => {
    if (typeof fn === 'function') await fn();
  }),
}));

// Stub the rate limiter so it never blocks tests.
vi.mock('../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Stub auth: the live + backfill endpoints sit behind `requireApiKeyOrJwt`,
// which will short-circuit to the JWT path when no `Bearer vai_*` header is
// present. Stubbing both layers lets us inject a fake user via header.
vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    const headerUser = req.headers['x-test-user'];
    req.user = headerUser
      ? JSON.parse(String(headerUser))
      : {
          userId: 'user-1',
          tenantId: 'tenant-A',
          email: 'svc@acme.test',
          role: 'tenant_owner',
          isPlatformAdmin: false,
        };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/apiKeyAuth', () => ({
  requireApiKeyOrJwt: (jwtMiddleware: (r: Request, s: Response, n: NextFunction) => void) =>
    (req: Request, res: Response, next: NextFunction) => jwtMiddleware(req, res, next),
}));

vi.mock('../../server/admin-api/middleware/apiKeyScope', () => ({
  requireApiKeyPermission: () =>
    (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

beforeEach(() => {
  nextIngestInsertReturnsRow = true;
  allClients.length = 0;
  existingCallsByExternalId.clear();
  existingCallsBySessionId.clear();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/ingest')).default;
  app.use(router);
  return app;
}

// --------------------------------------------------------------------------
// Payload helpers
// --------------------------------------------------------------------------

function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

function isoMinutesFromNow(minutes: number, now = Date.now()): string {
  return new Date(now + minutes * 60 * 1000).toISOString();
}

function baseCallEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const start = (overrides.start_time as string) ?? isoDaysAgo(0.5);
  const end = (overrides.end_time as string) ?? isoDaysAgo(0.5);
  return {
    version: 'v1',
    event_type: 'call.completed',
    timestamp: new Date().toISOString(),
    idempotency_key: `idem-${Math.random().toString(36).slice(2, 12)}`,
    tenant_id: 'tenant-A',
    agent_remote_id: 'agent-remote-1',

    external_id: `ext-${Math.random().toString(36).slice(2, 10)}`,
    direction: 'inbound',
    from_number: '+15551112222',
    to_number: '+15553334444',
    status: 'completed',
    start_time: start,
    end_time: end,
    duration_seconds: 120,

    transcript: 'Hello.',
    costs: { twilio_cents: 5, openai_cents: 12, total_cents: 17, is_estimated: false },
    ...overrides,
  };
}

function baseAttestation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reason: 'Remix outage 2026-04-19; replaying 11 dropped calls.',
    attested_by: 'ops@acme.test',
    original_system: 'remix-prod-eu',
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Live endpoint window enforcement
// --------------------------------------------------------------------------

describe('POST /v1/ingest/calls — freshness window', () => {
  it('accepts an event within the live window', async () => {
    const app = await buildApp();
    const event = baseCallEvent({ start_time: isoDaysAgo(2), end_time: isoDaysAgo(2) });

    const res = await request(app).post('/v1/ingest/calls').send(event);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('processed');
    expect(res.body.idempotency_key).toBe(event.idempotency_key);
  });

  it('rejects an event older than the freshness window and points at /backfill', async () => {
    const app = await buildApp();
    const event = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 2),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 2),
    });

    const res = await request(app).post('/v1/ingest/calls').send(event);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/too old/i);
    expect(res.body.details.fresh_window_days).toBe(INGEST_FRESH_WINDOW_DAYS);
    expect(res.body.details.backfill_window_days).toBe(INGEST_BACKFILL_WINDOW_DAYS);
    expect(res.body.details.backfill_endpoint).toBe('/v1/ingest/calls/backfill');
  });

  it('rejects an event with a future start_time', async () => {
    const app = await buildApp();
    const event = baseCallEvent({
      start_time: isoMinutesFromNow(60 * 48),
      end_time: isoMinutesFromNow(60 * 48 + 5),
    });

    const res = await request(app).post('/v1/ingest/calls').send(event);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/future/i);
  });
});

// --------------------------------------------------------------------------
// Backfill endpoint
// --------------------------------------------------------------------------

describe('POST /v1/ingest/calls/backfill', () => {
  it('requires a backfill_attestation block', async () => {
    const app = await buildApp();
    const event = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 3),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 3),
    });

    const res = await request(app).post('/v1/ingest/calls/backfill').send(event);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toHaveProperty('backfill_attestation');
  });

  it('rejects an attestation with a too-short reason', async () => {
    const app = await buildApp();
    const event = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 3),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 3),
      backfill_attestation: baseAttestation({ reason: 'too' }),
    });

    const res = await request(app).post('/v1/ingest/calls/backfill').send(event);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Validation failed');
  });

  it('accepts an event that is older than the live window but within the backfill window', async () => {
    const app = await buildApp();
    const event = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 5),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 5),
      backfill_attestation: baseAttestation(),
    });

    const res = await request(app).post('/v1/ingest/calls/backfill').send(event);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('processed');
    expect(res.body.backfill).toBe(true);
    expect(typeof res.body.age_days).toBe('number');
    expect(res.body.age_days).toBeGreaterThan(INGEST_FRESH_WINDOW_DAYS);
    expect(res.body.idempotency_key).toBe(event.idempotency_key);
  });

  it('persists the attestation block on the ingest_events row', async () => {
    const app = await buildApp();
    const attestation = baseAttestation({ reason: 'Reconcile dropped batch from 2026-04-22.' });
    const event = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      backfill_attestation: attestation,
    });

    await request(app).post('/v1/ingest/calls/backfill').send(event).expect(201);

    const insertCall = allClients
      .flatMap((c) => c.query.mock.calls)
      .find(([sql]) => typeof sql === 'string' && sql.trimStart().startsWith('INSERT INTO ingest_events'));
    expect(insertCall).toBeDefined();
    const args = insertCall![1] as unknown[];
    expect(args[4]).toBe('remix-backfill');
    const persistedPayload = JSON.parse(args[5] as string);
    expect(persistedPayload.backfill_attestation).toMatchObject({
      reason: attestation.reason,
      attested_by: attestation.attested_by,
    });
  });

  it('rejects a fresh event and points the caller at the live endpoint', async () => {
    // The backfill endpoint is for OLD events only — fresh events should go
    // through `/v1/ingest/calls`. Otherwise everything that happens to land
    // on the wrong route would be silently stamped as `remix-backfill` with
    // a meaningless attestation block.
    const app = await buildApp();
    const event = baseCallEvent({
      start_time: isoDaysAgo(2),
      end_time: isoDaysAgo(2),
      backfill_attestation: baseAttestation(),
    });

    const res = await request(app).post('/v1/ingest/calls/backfill').send(event);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/live ingest window/i);
    expect(res.body.details.live_endpoint).toBe('/v1/ingest/calls');
    expect(res.body.details.fresh_window_days).toBe(INGEST_FRESH_WINDOW_DAYS);
  });

  it('boundary: rejects an event aged just under the live window cutoff (~6.9d)', async () => {
    // Pin "now" so age math is deterministic and not subject to test
    // scheduling jitter — important for boundary tests.
    const now = Date.UTC(2026, 3, 27, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    try {
      const app = await buildApp();
      const event = baseCallEvent({
        start_time: isoDaysAgo(6.9, now),
        end_time: isoDaysAgo(6.9, now),
        backfill_attestation: baseAttestation(),
      });
      const res = await request(app).post('/v1/ingest/calls/backfill').send(event);
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/live ingest window/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('boundary: accepts an event aged just over the live window cutoff (~7.05d)', async () => {
    const now = Date.UTC(2026, 3, 27, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    try {
      const app = await buildApp();
      const event = baseCallEvent({
        start_time: isoDaysAgo(7.05, now),
        end_time: isoDaysAgo(7.05, now),
        backfill_attestation: baseAttestation(),
      });
      const res = await request(app).post('/v1/ingest/calls/backfill').send(event);
      expect(res.status).toBe(201);
      expect(res.body.backfill).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an event older than the backfill window (30 days)', async () => {
    const app = await buildApp();
    const event = baseCallEvent({
      start_time: isoDaysAgo(INGEST_BACKFILL_WINDOW_DAYS + 2),
      end_time: isoDaysAgo(INGEST_BACKFILL_WINDOW_DAYS + 2),
      backfill_attestation: baseAttestation(),
    });

    const res = await request(app).post('/v1/ingest/calls/backfill').send(event);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/too old/i);
    expect(res.body.details.backfill_window_days).toBe(INGEST_BACKFILL_WINDOW_DAYS);
  });

  it('rejects a payload whose tenant_id does not match the authenticated tenant', async () => {
    const app = await buildApp();
    const event = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 3),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 3),
      tenant_id: 'tenant-OTHER',
      backfill_attestation: baseAttestation(),
    });

    const res = await request(app).post('/v1/ingest/calls/backfill').send(event);

    expect(res.status).toBe(403);
  });

  it('returns 409 when the idempotency_key is reused, even with a fresh external_id', async () => {
    const app = await buildApp();
    const event = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 3),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 3),
      backfill_attestation: baseAttestation(),
    });

    nextIngestInsertReturnsRow = false;

    const res = await request(app).post('/v1/ingest/calls/backfill').send(event);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Duplicate event');
    expect(res.body.idempotency_key).toBe(event.idempotency_key);
  });

  it('keys idempotency on idempotency_key alone — same external_id with a fresh key is accepted', async () => {
    const app = await buildApp();
    const sharedExternalId = 'ext-corrected-call-1';

    const first = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      external_id: sharedExternalId,
      idempotency_key: 'idem-original',
      backfill_attestation: baseAttestation(),
    });
    const correction = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      external_id: sharedExternalId,
      idempotency_key: 'idem-correction',
      backfill_attestation: baseAttestation({ reason: 'Restate cost figures after pricing audit.' }),
    });

    await request(app).post('/v1/ingest/calls/backfill').send(first).expect(201);
    const res = await request(app).post('/v1/ingest/calls/backfill').send(correction);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('processed');
    expect(res.body.idempotency_key).toBe('idem-correction');
  });

  it('does not double-count usage when correcting a previously-ingested call', async () => {
    // Reproduces the audit finding: re-ingesting the same external_id with a
    // new idempotency key was incrementing usage_metrics / daily_org_usage as
    // if the call were brand new, inflating call counts and billing totals.
    // The correction must apply only the DELTA between the old and new event.
    const app = await buildApp();
    const sharedExternalId = 'ext-double-count-guard';

    const first = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 5),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 5),
      external_id: sharedExternalId,
      idempotency_key: 'idem-orig-double',
      duration_seconds: 120,
      // 2 minutes, $0.17 total (12c openai + 5c twilio)
      costs: { twilio_cents: 5, openai_cents: 12, total_cents: 17, is_estimated: false },
      backfill_attestation: baseAttestation(),
    });
    const correction = baseCallEvent({
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 5),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 5),
      external_id: sharedExternalId,
      idempotency_key: 'idem-corr-double',
      duration_seconds: 180,
      // 3 minutes, $0.25 total (18c openai + 7c twilio) — bigger than the first
      costs: { twilio_cents: 7, openai_cents: 18, total_cents: 25, is_estimated: false },
      backfill_attestation: baseAttestation({ reason: 'Recovered missing trailing segment of call.' }),
    });

    await request(app).post('/v1/ingest/calls/backfill').send(first).expect(201);
    const correctionRes = await request(app).post('/v1/ingest/calls/backfill').send(correction);
    expect(correctionRes.status).toBe(201);

    // The correction request used the SECOND fake client. Inspect the SQL
    // that was issued during it and confirm the aggregate inserts use deltas,
    // not full event values.
    const correctionClient = allClients[allClients.length - 1];
    const calls = correctionClient.query.mock.calls as Array<[string, unknown[] | undefined]>;

    const callsMetricInsert = calls.find(([sql]) =>
      sql.trimStart().startsWith('INSERT INTO usage_metrics') &&
      sql.includes('$2::usage_metric_type'),
    );
    expect(callsMetricInsert).toBeDefined();
    const callsMetricArgs = callsMetricInsert![1] as unknown[];
    // tenant, metricType, periodStart, periodEnd, callsDelta, totalCostDelta
    expect(callsMetricArgs[4]).toBe(0);  // callsDelta — call already counted
    expect(callsMetricArgs[5]).toBe(25 - 17);  // totalCostDelta = 8c

    const aiMinutesInsert = calls.find(([sql]) =>
      sql.trimStart().startsWith('INSERT INTO usage_metrics') &&
      sql.includes("'ai_minutes'::usage_metric_type"),
    );
    expect(aiMinutesInsert).toBeDefined();
    const aiArgs = aiMinutesInsert![1] as unknown[];
    // tenant, periodStart, periodEnd, minutesDelta, openaiDelta, openaiDelta
    expect(aiArgs[3]).toBe(3 - 2);  // minutesDelta = 1
    expect(aiArgs[4]).toBe(18 - 12);  // openaiDelta = 6c

    const dailyInsert = calls.find(([sql]) =>
      sql.trimStart().startsWith('INSERT INTO daily_org_usage'),
    );
    expect(dailyInsert).toBeDefined();
    const dailyArgs = dailyInsert![1] as unknown[];
    // tenant, callDate, callsDelta, minutesDelta, totalCostDelta
    expect(dailyArgs[2]).toBe(0);   // total_calls delta — no new call
    expect(dailyArgs[3]).toBe(1);   // total_ai_minutes delta = 1
    expect(dailyArgs[4]).toBe(8);   // total_cost_cents delta = 8
  });
});

// --------------------------------------------------------------------------
// Cross-day backfill correction → auto-rebalance + finance alert
//
// When a backfill correction shifts an existing call into a different
// calendar day, the ingest pipeline now reverses the OLD day's
// daily_org_usage / usage_metrics contribution and credits the NEW day in
// the same transaction so finance no longer needs to run the manual
// rebalance SQL. The structured alert (operations_alerts, type
// `billing_backfill_cross_day`) still fires but is informational only —
// severity `info`, metadata flags `auto_rebalanced: true`, and the message
// directs the operator to verify rather than rebalance.
// --------------------------------------------------------------------------

describe('POST /v1/ingest/calls/backfill — cross-day auto-rebalance + alert', () => {
  function findOpsAlertInsert() {
    return allClients
      .flatMap((c) => c.query.mock.calls as Array<[string, unknown[] | undefined]>)
      .find(([sql]) =>
        typeof sql === 'string' &&
        sql.trimStart().startsWith('INSERT INTO operations_alerts'),
      );
  }

  /**
   * Filters the SQL captured during a single request down to the
   * `usage_metrics` / `daily_org_usage` mutations and tags each one with the
   * calendar day it targeted (read off the period_start / date arg). Used to
   * assert that a cross-day shift produces both NEW-day credits and OLD-day
   * debits — i.e. the auto-rebalance landed.
   */
  function collectUsageWrites(client: ReturnType<typeof makeFakeClient>) {
    const writes: Array<{
      table: 'usage_metrics_calls' | 'usage_metrics_minutes' | 'daily_org_usage';
      day: string;
      args: unknown[];
    }> = [];
    for (const [sql, values] of client.query.mock.calls as Array<[string, unknown[] | undefined]>) {
      if (typeof sql !== 'string') continue;
      const trimmed = sql.trimStart();
      const args = (values ?? []) as unknown[];
      if (trimmed.startsWith('INSERT INTO usage_metrics') && sql.includes('$2::usage_metric_type')) {
        const periodStart = String(args[2]);
        writes.push({ table: 'usage_metrics_calls', day: periodStart.slice(0, 10), args });
      } else if (
        trimmed.startsWith('INSERT INTO usage_metrics') &&
        sql.includes("'ai_minutes'::usage_metric_type")
      ) {
        const periodStart = String(args[1]);
        writes.push({ table: 'usage_metrics_minutes', day: periodStart.slice(0, 10), args });
      } else if (trimmed.startsWith('INSERT INTO daily_org_usage')) {
        writes.push({ table: 'daily_org_usage', day: String(args[1]), args });
      }
    }
    return writes;
  }

  // Pin "now" so events stamped 7-9 days ago land deterministically inside
  // the backfill window (>7d, <30d) regardless of when the test suite runs.
  const FROZEN_NOW = Date.UTC(2026, 3, 27, 12, 0, 0); // 2026-04-27T12:00:00Z

  it('writes an informational billing_backfill_cross_day alert when a correction moves the call to a new day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW));
    try {
      const app = await buildApp();
      const sharedExternalId = 'ext-cross-day-shift';

      // Original ingest pinned to 2026-04-19 (~8 days old → backfill window).
      const first = baseCallEvent({
        start_time: '2026-04-19T23:30:00.000Z',
        end_time: '2026-04-19T23:32:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-cross-orig',
        backfill_attestation: baseAttestation(),
      });
      // Correction moves it to 2026-04-20 (different calendar day).
      const correction = baseCallEvent({
        start_time: '2026-04-20T00:05:00.000Z',
        end_time: '2026-04-20T00:07:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-cross-correction',
        backfill_attestation: baseAttestation({
          reason: 'Recover dropped call: clock-skew correction crossed midnight.',
        }),
      });

      await request(app).post('/v1/ingest/calls/backfill').send(first).expect(201);
      // Reset captured clients so we only see queries from the correction.
      allClients.length = 0;
      await request(app).post('/v1/ingest/calls/backfill').send(correction).expect(201);

      const alertInsert = findOpsAlertInsert();
      expect(alertInsert).toBeDefined();

      const args = alertInsert![1] as unknown[];
      // tenant_id, type, severity, message, metadata, call_session_id
      expect(args[0]).toBe('tenant-A');
      expect(args[1]).toBe('billing_backfill_cross_day');
      // Severity dropped from 'warning' to 'info' now that the rebalance is
      // automatic — the operator's only job is to verify.
      expect(args[2]).toBe('info');
      const message = String(args[3]);
      expect(message).toContain(sharedExternalId);
      expect(message).toContain('2026-04-19');
      expect(message).toContain('2026-04-20');
      expect(message).toContain('docs/runbooks/billing-backfill-cross-day-rebalance.md');
      expect(message).toMatch(/auto-rebalanced/i);
      expect(message).toMatch(/verify only/i);

      const metadata = JSON.parse(String(args[4])) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        tenant_id: 'tenant-A',
        external_id: sharedExternalId,
        old_date: '2026-04-19',
        new_date: '2026-04-20',
        source: 'remix-backfill',
        auto_rebalanced: true,
        runbook_url: 'docs/runbooks/billing-backfill-cross-day-rebalance.md',
      });

      // call_session_id must point at the existing call, not be NULL — the
      // alert is useless if finance can't trace it back to the row.
      expect(args[5]).toBe(`call-${sharedExternalId}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debits the OLD day and credits the NEW day inside the same transaction on a cross-day shift', async () => {
    // The original ingest credited 2026-04-19 with (+1 call, +2 ai_minutes,
    // +17c total, +12c openai). The correction shifts the call onto
    // 2026-04-20 AND restates duration/cost. The auto-rebalance must:
    //   * credit 2026-04-20 with the FULL new amount (+1, +3, +25, +18)
    //   * debit  2026-04-19 by the original amount (-1, -2, -17, -12)
    // so that summing daily_org_usage across both days reflects the call
    // exactly once at its restated values.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW));
    try {
      const app = await buildApp();
      const sharedExternalId = 'ext-cross-day-rebalance';

      const first = baseCallEvent({
        start_time: '2026-04-19T23:30:00.000Z',
        end_time: '2026-04-19T23:32:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-rebalance-orig',
        duration_seconds: 120, // 2 ai minutes
        costs: { twilio_cents: 5, openai_cents: 12, total_cents: 17, is_estimated: false },
        backfill_attestation: baseAttestation(),
      });
      const correction = baseCallEvent({
        start_time: '2026-04-20T00:05:00.000Z',
        end_time: '2026-04-20T00:08:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-rebalance-correction',
        duration_seconds: 180, // 3 ai minutes
        costs: { twilio_cents: 7, openai_cents: 18, total_cents: 25, is_estimated: false },
        backfill_attestation: baseAttestation({ reason: 'Cross-midnight correction.' }),
      });

      await request(app).post('/v1/ingest/calls/backfill').send(first).expect(201);
      allClients.length = 0;
      await request(app).post('/v1/ingest/calls/backfill').send(correction).expect(201);

      // Find the persistence client. Each request opens TWO connections in
      // sequence: an audit client (recordReceivedEvent) and the actual
      // persist client (persistCallEvent). The cross-day rebalance writes
      // run on the persist client — index 1 in the captured list.
      const persistClient = allClients[1];
      const writes = collectUsageWrites(persistClient);

      // NEW day (2026-04-20) credit: full new amount, NOT a same-day delta.
      const newDayCalls = writes.find(
        (w) => w.table === 'usage_metrics_calls' && w.day === '2026-04-20',
      );
      expect(newDayCalls).toBeDefined();
      // tenant, metricType, periodStart, periodEnd, callsDelta, totalCostDelta
      expect(newDayCalls!.args[4]).toBe(1);
      expect(newDayCalls!.args[5]).toBe(25);

      const newDayMinutes = writes.find(
        (w) => w.table === 'usage_metrics_minutes' && w.day === '2026-04-20',
      );
      expect(newDayMinutes).toBeDefined();
      // tenant, periodStart, periodEnd, minutesDelta, openaiDelta, openaiDelta
      expect(newDayMinutes!.args[3]).toBe(3);
      expect(newDayMinutes!.args[4]).toBe(18);

      const newDayDaily = writes.find(
        (w) => w.table === 'daily_org_usage' && w.day === '2026-04-20',
      );
      expect(newDayDaily).toBeDefined();
      // tenant, callDate, callsDelta, minutesDelta, totalCostDelta
      expect(newDayDaily!.args[2]).toBe(1);
      expect(newDayDaily!.args[3]).toBe(3);
      expect(newDayDaily!.args[4]).toBe(25);

      // OLD day (2026-04-19) debit: full original amount as negative deltas.
      const oldDayCalls = writes.find(
        (w) => w.table === 'usage_metrics_calls' && w.day === '2026-04-19',
      );
      expect(oldDayCalls).toBeDefined();
      expect(oldDayCalls!.args[4]).toBe(-1);
      expect(oldDayCalls!.args[5]).toBe(-17);

      const oldDayMinutes = writes.find(
        (w) => w.table === 'usage_metrics_minutes' && w.day === '2026-04-19',
      );
      expect(oldDayMinutes).toBeDefined();
      expect(oldDayMinutes!.args[3]).toBe(-2);
      expect(oldDayMinutes!.args[4]).toBe(-12);

      const oldDayDaily = writes.find(
        (w) => w.table === 'daily_org_usage' && w.day === '2026-04-19',
      );
      expect(oldDayDaily).toBeDefined();
      expect(oldDayDaily!.args[2]).toBe(-1);
      expect(oldDayDaily!.args[3]).toBe(-2);
      expect(oldDayDaily!.args[4]).toBe(-17);

      // The rebalance must run on the SAME client (= same transaction) as
      // the call upsert — otherwise a partial failure could leave OLD-day
      // debits applied without NEW-day credits, or vice versa.
      const upsertSql = (persistClient.query.mock.calls as Array<[string, unknown[] | undefined]>)
        .map(([sql]) => sql)
        .filter((sql) => typeof sql === 'string') as string[];
      expect(upsertSql.some((s) => s.trimStart().startsWith('UPDATE call_sessions'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaying the same cross-day correction is idempotent (no second debit/credit)', async () => {
    // The duplicate idempotency_key short-circuits at recordReceivedEvent
    // and persistCallEvent never runs again, so the OLD/NEW day buckets are
    // touched exactly once even when the operator hits "submit" twice.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW));
    try {
      const app = await buildApp();
      const sharedExternalId = 'ext-cross-day-replay';
      const correctionKey = 'idem-cross-replay-correction';

      const first = baseCallEvent({
        start_time: '2026-04-19T23:30:00.000Z',
        end_time: '2026-04-19T23:32:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-cross-replay-orig',
        backfill_attestation: baseAttestation(),
      });
      const correction = baseCallEvent({
        start_time: '2026-04-20T00:05:00.000Z',
        end_time: '2026-04-20T00:07:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: correctionKey,
        backfill_attestation: baseAttestation({ reason: 'Cross-midnight idempotent replay.' }),
      });

      await request(app).post('/v1/ingest/calls/backfill').send(first).expect(201);
      await request(app).post('/v1/ingest/calls/backfill').send(correction).expect(201);

      // Second submission of the SAME correction must be rejected as a
      // duplicate. Reset capture so we can prove no usage writes happened.
      allClients.length = 0;
      nextIngestInsertReturnsRow = false;
      const replay = await request(app).post('/v1/ingest/calls/backfill').send(correction);
      expect(replay.status).toBe(409);
      expect(replay.body.idempotency_key).toBe(correctionKey);

      // After a duplicate-key short-circuit the only SQL captured is the
      // ingest_events insert (which collided) plus tx control. Critically,
      // there must be NO usage_metrics / daily_org_usage / operations_alerts
      // writes — replaying the correction must not double-debit the OLD day
      // nor double-credit the NEW day.
      const replayWrites = allClients.flatMap((c) => collectUsageWrites(c));
      expect(replayWrites).toHaveLength(0);
      expect(findOpsAlertInsert()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a follow-up same-day correction after a cross-day shift only deltas the NEW day', async () => {
    // Regression guard: after a cross-day shift moves a call from day A to
    // day B, the call_sessions row's start_time MUST reflect day B so any
    // subsequent correction (with a fresh idempotency key) is treated as a
    // same-day correction on day B — NOT as another cross-day shift back to
    // day A. Without persisting start_time on UPDATE, every subsequent
    // correction would re-run the OLD-day debit forever.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW));
    try {
      const app = await buildApp();
      const sharedExternalId = 'ext-cross-day-then-sameday';

      const first = baseCallEvent({
        start_time: '2026-04-19T23:30:00.000Z',
        end_time: '2026-04-19T23:32:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-multi-1-orig',
        duration_seconds: 120,
        costs: { twilio_cents: 5, openai_cents: 12, total_cents: 17, is_estimated: false },
        backfill_attestation: baseAttestation(),
      });
      const crossDayCorrection = baseCallEvent({
        start_time: '2026-04-20T00:05:00.000Z',
        end_time: '2026-04-20T00:08:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-multi-2-crossday',
        duration_seconds: 180,
        costs: { twilio_cents: 7, openai_cents: 18, total_cents: 25, is_estimated: false },
        backfill_attestation: baseAttestation({ reason: 'First correction crosses midnight.' }),
      });
      // Third request: same external_id, STILL on 2026-04-20, just a cost
      // restate. Because the second request persisted start_time = day 20,
      // this third one must be a same-day correction — no day-19 debit.
      const sameDayCorrection = baseCallEvent({
        start_time: '2026-04-20T00:05:00.000Z',
        end_time: '2026-04-20T00:09:30.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-multi-3-sameday',
        duration_seconds: 270,
        costs: { twilio_cents: 9, openai_cents: 22, total_cents: 31, is_estimated: false },
        backfill_attestation: baseAttestation({ reason: 'Second correction restates trailing audio.' }),
      });

      await request(app).post('/v1/ingest/calls/backfill').send(first).expect(201);
      await request(app).post('/v1/ingest/calls/backfill').send(crossDayCorrection).expect(201);
      // Reset captured clients so we only see queries from the third request.
      allClients.length = 0;
      await request(app).post('/v1/ingest/calls/backfill').send(sameDayCorrection).expect(201);

      // The third request must NOT touch 2026-04-19 at all — that day was
      // already balanced by the cross-day rebalance in the second request.
      const persistClient = allClients[1];
      const writes = collectUsageWrites(persistClient);
      const day19Writes = writes.filter((w) => w.day === '2026-04-19');
      expect(day19Writes).toHaveLength(0);

      // Day-20 receives the same-day delta (call already counted there):
      //   callsDelta = 0
      //   minutesDelta = 5 - 3 = 2  (270s = 5min, prior was 180s = 3min)
      //   totalCostDelta = 31 - 25 = 6
      //   openaiDelta = 22 - 18 = 4
      const day20Calls = writes.find(
        (w) => w.table === 'usage_metrics_calls' && w.day === '2026-04-20',
      );
      expect(day20Calls).toBeDefined();
      expect(day20Calls!.args[4]).toBe(0);
      expect(day20Calls!.args[5]).toBe(6);

      const day20Minutes = writes.find(
        (w) => w.table === 'usage_metrics_minutes' && w.day === '2026-04-20',
      );
      expect(day20Minutes).toBeDefined();
      expect(day20Minutes!.args[3]).toBe(2);
      expect(day20Minutes!.args[4]).toBe(4);

      const day20Daily = writes.find(
        (w) => w.table === 'daily_org_usage' && w.day === '2026-04-20',
      );
      expect(day20Daily).toBeDefined();
      expect(day20Daily!.args[2]).toBe(0);
      expect(day20Daily!.args[3]).toBe(2);
      expect(day20Daily!.args[4]).toBe(6);

      // And no second cross-day alert fires — there was no shift this time.
      expect(findOpsAlertInsert()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not double-count when the alert insert fails after a successful auto-rebalance', async () => {
    // The OLD-day debit + NEW-day credit happen INSIDE the ingest txn (and
    // thus commit atomically), while the alert insert is a best-effort
    // post-commit write. If the alert insert blows up we must NOT undo the
    // rebalance, and we must NOT re-apply it — the call upsert and the
    // rebalance have already committed exactly once.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW));
    try {
      const app = await buildApp();
      const sharedExternalId = 'ext-cross-day-alert-broken-rebalance-once';

      const first = baseCallEvent({
        start_time: '2026-04-19T23:30:00.000Z',
        end_time: '2026-04-19T23:32:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-broken-alert-orig',
        duration_seconds: 120,
        costs: { twilio_cents: 5, openai_cents: 12, total_cents: 17, is_estimated: false },
        backfill_attestation: baseAttestation(),
      });
      const correction = baseCallEvent({
        start_time: '2026-04-20T00:05:00.000Z',
        end_time: '2026-04-20T00:08:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-broken-alert-correction',
        duration_seconds: 180,
        costs: { twilio_cents: 7, openai_cents: 18, total_cents: 25, is_estimated: false },
        backfill_attestation: baseAttestation({ reason: 'Auto-rebalance survives broken alert sink.' }),
      });

      await request(app).post('/v1/ingest/calls/backfill').send(first).expect(201);
      allClients.length = 0;

      // Patch every newly-created client so its operations_alerts insert
      // throws — same trick as the broader best-effort test below.
      const originalPush = allClients.push.bind(allClients);
      const failOpsAlertInsert = (client: ReturnType<typeof makeFakeClient>) => {
        const original = client.query;
        client.query = vi.fn(async (sql: string, values?: unknown[]) => {
          if (typeof sql === 'string' && sql.trimStart().startsWith('INSERT INTO operations_alerts')) {
            throw new Error('simulated operations_alerts outage');
          }
          return original(sql, values);
        }) as typeof client.query;
      };
      allClients.push = ((...items: ReturnType<typeof makeFakeClient>[]) => {
        for (const c of items) failOpsAlertInsert(c);
        return originalPush(...items);
      }) as typeof allClients.push;

      try {
        const res = await request(app).post('/v1/ingest/calls/backfill').send(correction);
        expect(res.status).toBe(201);

        // The persistence client (allClients[1] — index 0 is the audit
        // client used by recordReceivedEvent) should still show exactly
        // one debit on 2026-04-19 and exactly one credit on 2026-04-20 in
        // each of the three rollup tables — no duplication caused by the
        // failing alert path.
        const persistClient = allClients[1];
        const writes = collectUsageWrites(persistClient);
        const debits19 = writes.filter((w) => w.day === '2026-04-19');
        const credits20 = writes.filter((w) => w.day === '2026-04-20');
        expect(debits19.map((w) => w.table).sort()).toEqual([
          'daily_org_usage',
          'usage_metrics_calls',
          'usage_metrics_minutes',
        ]);
        expect(credits20.map((w) => w.table).sort()).toEqual([
          'daily_org_usage',
          'usage_metrics_calls',
          'usage_metrics_minutes',
        ]);
      } finally {
        allClients.push = originalPush;
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not write an alert for a same-day correction', async () => {
    // Same external_id, same calendar day, just a duration/cost correction —
    // the rebalancing problem only exists when the day changes, so noisy
    // alerts on every restated cost would be useless.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW));
    try {
      const app = await buildApp();
      const sharedExternalId = 'ext-same-day-correction';

      const first = baseCallEvent({
        start_time: '2026-04-19T10:00:00.000Z',
        end_time: '2026-04-19T10:02:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-sameday-orig',
        backfill_attestation: baseAttestation(),
      });
      const correction = baseCallEvent({
        start_time: '2026-04-19T10:00:00.000Z',
        end_time: '2026-04-19T10:03:30.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-sameday-correction',
        duration_seconds: 210,
        costs: { twilio_cents: 7, openai_cents: 18, total_cents: 25, is_estimated: false },
        backfill_attestation: baseAttestation({ reason: 'Restate trailing audio segment.' }),
      });

      await request(app).post('/v1/ingest/calls/backfill').send(first).expect(201);
      allClients.length = 0;
      await request(app).post('/v1/ingest/calls/backfill').send(correction).expect(201);

      expect(findOpsAlertInsert()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not write an alert for a brand-new call (no prior session row)', async () => {
    // A first-time ingest is not a correction at all — there's no OLD day
    // bucket to rebalance, so the alert must not fire.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW));
    try {
      const app = await buildApp();
      const event = baseCallEvent({
        start_time: '2026-04-19T12:00:00.000Z',
        end_time: '2026-04-19T12:02:00.000Z',
        external_id: 'ext-brand-new-no-alert',
        idempotency_key: 'idem-brand-new',
        backfill_attestation: baseAttestation(),
      });

      await request(app).post('/v1/ingest/calls/backfill').send(event).expect(201);

      expect(findOpsAlertInsert()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still returns 201 when the alert insert itself fails (best-effort)', async () => {
    // The alert insert must NEVER fail the ingest — if operations_alerts is
    // unavailable, finance loses the signal but the call data still lands.
    // Patch the fake-client factory so any pool.connect() created after we
    // flip the flag returns a client whose operations_alerts insert throws.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW));
    try {
      const app = await buildApp();
      const sharedExternalId = 'ext-cross-day-alert-failure';

      const first = baseCallEvent({
        start_time: '2026-04-19T23:30:00.000Z',
        end_time: '2026-04-19T23:32:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-alertfail-orig',
        backfill_attestation: baseAttestation(),
      });
      const correction = baseCallEvent({
        start_time: '2026-04-20T00:05:00.000Z',
        end_time: '2026-04-20T00:07:00.000Z',
        external_id: sharedExternalId,
        idempotency_key: 'idem-alertfail-correction',
        backfill_attestation: baseAttestation({ reason: 'Cross-day correction with broken alert sink.' }),
      });

      await request(app).post('/v1/ingest/calls/backfill').send(first).expect(201);
      allClients.length = 0;

      // Wrap allClients.push to monkey-patch every newly-created client so
      // its operations_alerts insert throws — this catches the post-commit
      // helper which connects on a fresh client.
      const originalPush = allClients.push.bind(allClients);
      const failOpsAlertInsert = (client: ReturnType<typeof makeFakeClient>) => {
        const original = client.query;
        client.query = vi.fn(async (sql: string, values?: unknown[]) => {
          if (typeof sql === 'string' && sql.trimStart().startsWith('INSERT INTO operations_alerts')) {
            throw new Error('simulated operations_alerts outage');
          }
          return original(sql, values);
        }) as typeof client.query;
      };
      allClients.push = ((...items: ReturnType<typeof makeFakeClient>[]) => {
        for (const c of items) failOpsAlertInsert(c);
        return originalPush(...items);
      }) as typeof allClients.push;

      try {
        const res = await request(app).post('/v1/ingest/calls/backfill').send(correction);
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('processed');
      } finally {
        allClients.push = originalPush;
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// --------------------------------------------------------------------------
// Preview-existing helper used by the admin "Backfill calls" console
// --------------------------------------------------------------------------

describe('POST /v1/ingest/calls/preview-existing', () => {
  it('reports which external_ids already have a call_sessions row', async () => {
    const app = await buildApp();

    // Seed two existing calls under tenant-A by submitting them through the
    // backfill endpoint first; this exercises the same persistence path as
    // production and avoids hand-rolling fake state.
    const seed = baseCallEvent({
      external_id: 'ext-known-1',
      idempotency_key: 'idem-seed-1',
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      backfill_attestation: baseAttestation(),
    });
    await request(app).post('/v1/ingest/calls/backfill').send(seed).expect(201);

    const res = await request(app)
      .post('/v1/ingest/calls/preview-existing')
      .send({ external_ids: ['ext-known-1', 'ext-new-1', 'ext-new-2'] });

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe('tenant-A');
    expect(res.body.checked).toBe(3);
    expect(res.body.existing).toEqual(['ext-known-1']);
  });

  it('returns 422 when external_ids is missing or empty', async () => {
    const app = await buildApp();

    const empty = await request(app)
      .post('/v1/ingest/calls/preview-existing')
      .send({ external_ids: [] });
    expect(empty.status).toBe(422);

    const missing = await request(app)
      .post('/v1/ingest/calls/preview-existing')
      .send({});
    expect(missing.status).toBe(422);
  });

  it('caps the lookup at 1000 ids per call', async () => {
    const app = await buildApp();
    const ids = Array.from({ length: 1001 }, (_, i) => `ext-${i}`);

    const res = await request(app)
      .post('/v1/ingest/calls/preview-existing')
      .send({ external_ids: ids });

    expect(res.status).toBe(422);
  });

  it('deduplicates duplicate external_ids in the input', async () => {
    const app = await buildApp();
    const seed = baseCallEvent({
      external_id: 'ext-dup',
      idempotency_key: 'idem-seed-dup',
      start_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      end_time: isoDaysAgo(INGEST_FRESH_WINDOW_DAYS + 4),
      backfill_attestation: baseAttestation(),
    });
    await request(app).post('/v1/ingest/calls/backfill').send(seed).expect(201);

    const res = await request(app)
      .post('/v1/ingest/calls/preview-existing')
      .send({ external_ids: ['ext-dup', 'ext-dup', 'ext-dup'] });

    expect(res.status).toBe(200);
    expect(res.body.checked).toBe(1);
    expect(res.body.existing).toEqual(['ext-dup']);
  });
});
