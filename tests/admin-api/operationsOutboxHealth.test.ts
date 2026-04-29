import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const clientQueryMock = vi.fn();
const clientReleaseMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    query: queryMock,
    connect: vi.fn(async () => ({
      query: clientQueryMock,
      release: clientReleaseMock,
    })),
  }),
  withTenantContext: vi.fn(async (_c: unknown, _t: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../platform/infra/rate-limit/sseConnectionLimiter', () => ({
  getTenantSseConnectionLimiter: () => ({ acquire: () => true }),
  attachSseHeartbeat: () => Object.assign(() => {}, { ack: () => {} }),
  resolveLiveStreamCap: () => 10,
  registerSseConnection: () => () => {},
  ackSseConnection: () => true,
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireOpsRole: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-A',
      email: 'ops@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    next();
  },
}));

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  clientReleaseMock.mockReset();
  // Default: connector-dispatch path returns no rows so it doesn't interfere
  // with the tests below — they're focused on the outbox health surfaces.
  clientQueryMock.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    return { rows: [] };
  });
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/operations')).default;
  app.use(router);
  return app;
}

describe('GET /operations/integration-diagnostics outbox health', () => {
  it('returns aggregate counters, sparklines, provider breakdown, and redacts payload PII', async () => {
    // 1) webhooks listing
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'evt-1',
          event_type: 'appointment.created',
          status: 'failed',
          attempts: 3,
          max_attempts: 5,
          last_error: 'POST failed for caller 415-555-1212',
          payload: {
            phone: '4155551212',
            note: 'Call John Doe at 415-555-1212 about appt',
            nested: { email: 'caller@example.com', other: 'safe' },
          },
          created_at: '2026-04-29T10:00:00Z',
          updated_at: '2026-04-29T10:01:00Z',
          delivered_at: null,
          next_attempt_at: '2026-04-29T10:05:00Z',
          integration_name: 'HubSpot',
          integration_provider: 'hubspot',
        },
      ],
    });
    // 2) outbox summary
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          pending: 4,
          processing: 1,
          failed: 7,
          dead_letter: 2,
          delivered_24h: 312,
          oldest_unresolved_at: '2026-04-29T08:00:00Z',
        },
      ],
    });
    // 3) sparkline rows
    queryMock.mockResolvedValueOnce({
      rows: [
        { bucket: '2026-04-29T09:00:00Z', status: 'failed', count: 3 },
        { bucket: '2026-04-29T10:00:00Z', status: 'failed', count: 4 },
        { bucket: '2026-04-29T10:00:00Z', status: 'delivered', count: 100 },
      ],
    });
    // 4) provider breakdown
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          provider: 'hubspot',
          integration_name: 'HubSpot',
          failed: 7,
          dead_letter: 2,
          pending: 0,
          last_failure_at: '2026-04-29T10:01:00Z',
        },
      ],
    });
    // 5) outbox provider list
    queryMock.mockResolvedValueOnce({ rows: [{ provider: 'hubspot' }, { provider: 'salesforce' }] });
    // 6) integration health (existing query, no rows for this test)
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app).get('/operations/integration-diagnostics');

    expect(res.status).toBe(200);
    expect(res.body.outboxSummary).toEqual({
      pending: 4,
      processing: 1,
      failed: 7,
      dead_letter: 2,
      delivered_24h: 312,
      oldest_unresolved_at: '2026-04-29T08:00:00Z',
    });
    expect(res.body.outboxSparklines.failed).toHaveLength(2);
    expect(res.body.outboxSparklines.delivered).toHaveLength(1);
    expect(res.body.outboxSparklines.pending).toEqual([]);
    expect(res.body.outboxProviderBreakdown).toEqual([
      {
        provider: 'hubspot',
        integration_name: 'HubSpot',
        failed: 7,
        dead_letter: 2,
        pending: 0,
        last_failure_at: '2026-04-29T10:01:00Z',
      },
    ]);
    expect(res.body.outboxProviders).toEqual(['hubspot', 'salesforce']);

    const wh = res.body.webhooks[0];
    // Sensitive field-name keys are tagged as redacted.
    expect(wh.payload.phone).toBe('[REDACTED]');
    expect(wh.payload.nested.email).toBe('[REDACTED]');
    expect(wh.payload.nested.other).toBe('safe');
    // Free-text strings still get the platform PHI scrubber applied (phone
    // numbers, SSNs, DOBs, and tagged-name patterns are redacted).
    expect(wh.payload.note).not.toContain('415-555-1212');
    expect(wh.payload.note).toContain('[PHONE_REDACTED]');
    expect(wh.last_error).not.toContain('415-555-1212');
    expect(wh.last_error).toContain('[PHONE_REDACTED]');
  });

  it('redacts sensitive object-valued and non-string fields wholesale (address sub-object, numeric zip)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'evt-2',
          event_type: 'patient.upserted',
          status: 'failed',
          attempts: 1,
          max_attempts: 5,
          last_error: null,
          payload: {
            address: {
              line1: '123 Main St',
              line2: 'Apt 4B',
              city: 'Springfield',
              zip: 90210,
            },
            ssn: 123456789,
            phone: null,
            outer: {
              dob: '1985-04-12',
              note: 'safe sibling text',
            },
          },
          created_at: '2026-04-29T10:00:00Z',
          updated_at: '2026-04-29T10:01:00Z',
          delivered_at: null,
          next_attempt_at: null,
          integration_name: 'Athena',
          integration_provider: 'athena',
        },
      ],
    });
    // outbox summary / sparklines / breakdown / providers / health — all empty
    queryMock.mockResolvedValueOnce({ rows: [{ pending: 0, processing: 0, failed: 0, dead_letter: 0, delivered_24h: 0, oldest_unresolved_at: null }] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app).get('/operations/integration-diagnostics');

    expect(res.status).toBe(200);
    const wh = res.body.webhooks[0];
    // Whole sub-object values for sensitive keys collapse to a tagged scalar.
    expect(wh.payload.address).toBe('[REDACTED]');
    // Numeric values for sensitive keys are redacted, not leaked.
    expect(wh.payload.ssn).toBe('[REDACTED]');
    // null on a sensitive key stays null (no fake placeholder).
    expect(wh.payload.phone).toBeNull();
    // Non-sensitive parents are still walked, and sensitive keys inside them
    // still get redacted. Sibling safe text passes through untouched.
    expect(wh.payload.outer.dob).toBe('[REDACTED]');
    expect(wh.payload.outer.note).toBe('safe sibling text');
  });

  it('honors the outboxProvider filter on the listing query', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const app = await buildApp();
    await request(app).get('/operations/integration-diagnostics?outboxProvider=salesforce');

    // First call is the webhooks listing; verify the provider filter SQL bound to tenant + provider.
    const firstCall = queryMock.mock.calls[0];
    expect(firstCall[0]).toContain('i.provider = $');
    expect(firstCall[1]).toEqual(['tenant-A', 'salesforce']);
  });

  it('treats whitespace-only outboxProvider as "no filter" rather than binding an empty string', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const app = await buildApp();
    await request(app).get('/operations/integration-diagnostics?outboxProvider=%20%20%20');

    const firstCall = queryMock.mock.calls[0];
    expect(firstCall[0]).not.toContain('i.provider = $');
    expect(firstCall[1]).toEqual(['tenant-A']);
  });

  it('keeps the per-provider breakdown query global even when outboxProvider is set, so operators can compare providers', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const app = await buildApp();
    await request(app).get('/operations/integration-diagnostics?outboxProvider=salesforce');

    // Order: 1=webhooks, 2=summary, 3=sparkline, 4=providerBreakdown, 5=providers
    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    const breakdownCall = queryMock.mock.calls[3];
    const breakdownSql = breakdownCall[0] as string;
    const breakdownParams = breakdownCall[1] as unknown[];
    // The breakdown is intentionally tenant-scoped only — it must NOT be
    // narrowed by the active provider filter, otherwise the operator loses
    // their cross-provider comparison view.
    expect(breakdownSql).not.toContain('i.provider = $');
    expect(breakdownParams).toEqual(['tenant-A']);
  });
});

describe('POST /operations/integration-diagnostics/bulk-retry', () => {
  it('requeues every failed row for the tenant when no provider filter is supplied', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 12, rows: new Array(12).fill({ id: 'x' }) });

    const app = await buildApp();
    const res = await request(app)
      .post('/operations/integration-diagnostics/bulk-retry')
      .send({ status: 'failed' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, requeued: 12 });
    const sql = queryMock.mock.calls[0][0] as string;
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(sql).toContain('UPDATE outbox_events');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('attempts = 0');
    // No provider sub-select when no provider filter is supplied.
    expect(sql).not.toContain('FROM integrations');
    expect(params).toEqual(['tenant-A', ['failed']]);
  });

  it('scopes the retry to the requested provider when supplied', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 5, rows: [] });
    const app = await buildApp();
    const res = await request(app)
      .post('/operations/integration-diagnostics/bulk-retry')
      .send({ status: 'all', provider: 'salesforce' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, requeued: 5 });
    const sql = queryMock.mock.calls[0][0] as string;
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(sql).toContain('FROM integrations WHERE tenant_id = $1 AND provider = $3');
    expect(params).toEqual(['tenant-A', ['failed', 'dead_letter'], 'salesforce']);
  });

  it('per-row retry resets attempts and clears last_error so dead-letter rows can be claimed again', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'oe-1' }] });
    const app = await buildApp();
    const res = await request(app)
      .post('/operations/integration-diagnostics/oe-1/retry')
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const sql = queryMock.mock.calls[0][0] as string;
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(sql).toContain('UPDATE outbox_events');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('attempts = 0');
    expect(sql).toContain('last_error = NULL');
    expect(sql).toContain('archived_at IS NULL');
    expect(sql).toContain("status IN ('failed', 'dead_letter')");
    expect(params).toEqual(['oe-1', 'tenant-A']);
  });

  it('rejects unknown status filters', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/operations/integration-diagnostics/bulk-retry')
      .send({ status: 'delivered' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid status filter/);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
