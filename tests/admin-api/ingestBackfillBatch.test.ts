/**
 * Route-level coverage for the admin-console batch backfill endpoint
 * (`POST /v1/ingest/calls/backfill/batch`). The batch endpoint is the
 * fan-out helper that lets a tenant operator (or platform admin) replay
 * many historical calls at once with one attestation block.
 *
 * Behaviour under test:
 *   1. Authorisation
 *      - Rejects callers with neither `tenant_owner`/`operations_manager`
 *        role nor `isPlatformAdmin`.
 *      - Tenant operators can only target their own tenant; supplying a
 *        different `tenant_id` returns 403.
 *      - Platform admins may target any tenant.
 *   2. Per-row outcomes
 *      - Valid old-enough rows return `inserted` and increment the summary.
 *      - Reused idempotency keys return `duplicate` (resumability contract).
 *      - Rows whose `start_time` is inside the live window or older than the
 *        backfill window are tagged `window_rejected`, not persisted.
 *      - Rows whose payload doesn't satisfy `CallBackfillEventV1Schema`
 *        return `validation_failed` with a `fieldErrors` JSON in `error`.
 *   3. Summary aggregates the per-row outcomes correctly.
 *   4. Idempotency keys round-trip verbatim so the operator can re-upload
 *      the same CSV after a partial failure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import {
  INGEST_BACKFILL_WINDOW_DAYS,
  INGEST_FRESH_WINDOW_DAYS,
} from '../../shared/ingest/eventTypes';

let nextIngestInsertReturnsRow = true;
const seenIdempotencyKeys = new Set<string>();

function makeFakeClient() {
  return {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      const trimmed = sql.trimStart();
      if (trimmed.startsWith('BEGIN') || trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('SELECT set_config')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('INSERT INTO ingest_events')) {
        // Honour duplicate semantics: same idempotency_key (param 2)
        // returns no rows on the second attempt.
        const key = String((values ?? [])[1]);
        if (seenIdempotencyKeys.has(key)) {
          return { rows: [], rowCount: 0 };
        }
        seenIdempotencyKeys.add(key);
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
      if (trimmed.startsWith('SELECT id, total_cost_cents, duration_seconds')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('SELECT llm_cost_cents FROM conversation_costs')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('SELECT id FROM call_quality_scores')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('INSERT INTO call_sessions')) {
        const v = values ?? [];
        return { rows: [{ id: `call-${String(v[11])}` }], rowCount: 1 };
      }
      if (
        trimmed.startsWith('INSERT INTO conversation_costs') ||
        trimmed.startsWith('INSERT INTO call_quality_scores') ||
        trimmed.startsWith('INSERT INTO usage_metrics') ||
        trimmed.startsWith('INSERT INTO daily_org_usage') ||
        trimmed.startsWith('UPDATE call_sessions') ||
        trimmed.startsWith('UPDATE agents')
      ) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => makeFakeClient(),
  }),
  withTenantContext: vi.fn(async (_client, _tenantId, fn) => {
    if (typeof fn === 'function') await fn();
  }),
}));

vi.mock('../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

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
  seenIdempotencyKeys.clear();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const router = (await import('../../server/admin-api/routes/ingest')).default;
  app.use(router);
  return app;
}

function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

let rowCounter = 0;
function rowFactory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  rowCounter += 1;
  const startDays = (overrides.startDays as number | undefined) ?? 14;
  delete overrides.startDays;
  return {
    idempotency_key: `idem-${rowCounter}-${Math.random().toString(36).slice(2, 8)}`,
    agent_remote_id: 'agent-remote-1',
    external_id: `ext-${rowCounter}-${Math.random().toString(36).slice(2, 8)}`,
    direction: 'inbound',
    from_number: '+15551112222',
    to_number: '+15553334444',
    status: 'completed',
    start_time: isoDaysAgo(startDays),
    end_time: isoDaysAgo(startDays),
    duration_seconds: 120,
    transcript: 'Replay row',
    costs: { twilio_cents: 5, openai_cents: 12, total_cents: 17, is_estimated: true },
    ...overrides,
  };
}

const ATTESTATION = {
  reason: 'Remix outage 2026-04-19; replaying dropped calls.',
  attested_by: 'ops@acme.test',
  original_system: 'remix-prod-eu',
};

describe('POST /v1/ingest/calls/backfill/batch — authorisation', () => {
  it('rejects callers without operator/admin role', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .set(
        'x-test-user',
        JSON.stringify({
          userId: 'u',
          tenantId: 'tenant-A',
          email: 'agent@acme.test',
          role: 'agent_developer',
          isPlatformAdmin: false,
        }),
      )
      .send({ attestation: ATTESTATION, rows: [rowFactory()] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/role required/i);
  });

  it('rejects a tenant operator targeting another tenant', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .send({
        tenant_id: 'tenant-B',
        attestation: ATTESTATION,
        rows: [rowFactory()],
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/another tenant/i);
  });

  it('lets a platform admin target any tenant', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .set(
        'x-test-user',
        JSON.stringify({
          userId: 'admin',
          tenantId: 'platform',
          email: 'admin@acme.test',
          role: 'support_reviewer',
          isPlatformAdmin: true,
        }),
      )
      .send({
        tenant_id: 'tenant-Z',
        attestation: ATTESTATION,
        rows: [rowFactory()],
      });

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe('tenant-Z');
    expect(res.body.summary.inserted).toBe(1);
  });
});

describe('POST /v1/ingest/calls/backfill/batch — per-row outcomes', () => {
  it('classifies inserted, duplicate, validation_failed, and window_rejected rows', async () => {
    const app = await buildApp();
    const sharedKey = `idem-shared-${Math.random().toString(36).slice(2, 8)}`;
    const rows = [
      rowFactory({ idempotency_key: sharedKey }),
      rowFactory({ idempotency_key: sharedKey, external_id: 'dup-ext' }), // duplicate
      rowFactory({ from_number: '' }), // validation_failed
      rowFactory({ startDays: 2 }), // window_rejected: inside live window
      rowFactory({ startDays: INGEST_BACKFILL_WINDOW_DAYS + 5 }), // window_rejected: too old
    ];

    const res = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .send({ attestation: ATTESTATION, rows });

    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(5);
    expect(res.body.summary.inserted).toBe(1);
    expect(res.body.summary.duplicate).toBe(1);
    expect(res.body.summary.validation_failed).toBe(1);
    expect(res.body.summary.window_rejected).toBe(2);
    expect(res.body.summary.failed).toBe(0);

    expect(res.body.results).toHaveLength(5);
    const byIndex: Record<number, { status: string; idempotency_key: string | null; error?: string }> = {};
    for (const r of res.body.results) byIndex[r.row_index] = r;

    expect(byIndex[0].status).toBe('inserted');
    expect(byIndex[0].idempotency_key).toBe(sharedKey);
    expect(byIndex[1].status).toBe('duplicate');
    expect(byIndex[2].status).toBe('validation_failed');
    expect(byIndex[3].status).toBe('window_rejected');
    expect(byIndex[3].error).toMatch(/live window/i);
    expect(byIndex[4].status).toBe('window_rejected');
    expect(byIndex[4].error).toMatch(/backfill window/i);
  });

  it('preserves idempotency keys verbatim so a re-upload is safely resumable', async () => {
    const app = await buildApp();
    const rows = [rowFactory(), rowFactory(), rowFactory()];

    const first = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .send({ attestation: ATTESTATION, rows });
    expect(first.status).toBe(200);
    expect(first.body.summary.inserted).toBe(3);

    // Re-upload the EXACT same payload — every row should now be classified
    // as a duplicate, so the operator can re-run their CSV without
    // double-processing anything.
    const second = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .send({ attestation: ATTESTATION, rows });
    expect(second.status).toBe(200);
    expect(second.body.summary.inserted).toBe(0);
    expect(second.body.summary.duplicate).toBe(3);
    for (let i = 0; i < 3; i += 1) {
      expect(second.body.results[i].idempotency_key).toBe(rows[i].idempotency_key);
    }
  });

  it('rejects an attestation block that does not satisfy the schema', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .send({
        attestation: { reason: 'short', attested_by: '' },
        rows: [rowFactory()],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation failed/i);
  });

  it('caps the batch size and rejects empty batches', async () => {
    const app = await buildApp();
    const tooMany = Array.from({ length: 501 }, () => rowFactory());
    const res = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .send({ attestation: ATTESTATION, rows: tooMany });
    expect(res.status).toBe(400);

    const empty = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .send({ attestation: ATTESTATION, rows: [] });
    expect(empty.status).toBe(400);
  });

  it('flags ages just inside the live window cutoff (~6.9d) as window_rejected', async () => {
    const app = await buildApp();
    const insideLive = rowFactory({ startDays: INGEST_FRESH_WINDOW_DAYS - 0.1 });
    const justOutside = rowFactory({ startDays: INGEST_FRESH_WINDOW_DAYS + 0.05 });

    const res = await request(app)
      .post('/v1/ingest/calls/backfill/batch')
      .send({ attestation: ATTESTATION, rows: [insideLive, justOutside] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('window_rejected');
    expect(res.body.results[1].status).toBe('inserted');
  });
});
