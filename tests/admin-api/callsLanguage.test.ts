/**
 * API coverage for the language column added in migration 082.
 *
 * Asserts that:
 *   - GET /calls returns a `language` field for each call in the listing
 *   - GET /calls/:id returns a `language` field on the call detail
 *   - Both endpoints use the COALESCE(cs.language, a.language) fallback
 *     pattern so legacy rows that pre-date migration 082 still surface a
 *     language (the agent's currently configured one) rather than NULL.
 *
 * The SQL is asserted directly (string match on COALESCE) so that a future
 * change that drops the snapshot column or stops joining `agents.language`
 * fails loudly. Mock rows simulate three call shapes:
 *   1. snapshot wins  (cs.language = 'es', a.language = 'fr') -> 'es'
 *   2. fallback wins  (cs.language = NULL, a.language = 'fr') -> 'fr'
 *   3. nothing known  (cs.language = NULL, a.language = NULL) -> null
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ connect: connectMock, query: queryMock }),
  withTenantContext: vi.fn(
    async (
      _client: unknown,
      _tenantId: string,
      fn: () => Promise<void>,
    ) => fn(),
  ),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/core/phi/redact', () => ({
  redactPHI: (v: string) => v,
}));

vi.mock('../../platform/billing/cost', () => ({
  getConversationCost: vi.fn(async () => null),
}));

vi.mock('../../platform/analytics/CallViewSubscriberNotifier', () => ({
  notifySubscriberChanges: vi.fn(async () => undefined),
  diffSubscribers: vi.fn(() => ({ added: [], removed: [] })),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-A',
      userId: 'user-1',
      email: 'user@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    next();
  },
}));

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

async function buildApp(): Promise<express.Express> {
  const callsRouter = (await import('../../server/admin-api/routes/calls')).default;
  const app = express();
  app.use(express.json());
  app.use(callsRouter);
  return app;
}

describe('GET /calls list returns language with COALESCE fallback', () => {
  it('surfaces a language field on every row and uses COALESCE(cs.language, a.language)', async () => {
    // Mocked listing rows: each carries the value the SQL would have
    // produced for that row after applying COALESCE(cs.language, a.language).
    const rows = [
      {
        id: 'call-1',
        caller_number: '+15551112222',
        called_number: '+15553334444',
        agent_id: 'agent-1',
        direction: 'inbound',
        lifecycle_state: 'CALL_COMPLETED',
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        duration_seconds: 60,
        total_cost_cents: 100,
        environment: 'development',
        created_at: new Date().toISOString(),
        stir_status: null,
        stir_verstat: null,
        stir_attestation: null,
        // Snapshot wins: cs.language = 'es', would override a.language = 'fr'
        language: 'es',
        agent_name: 'Recepción',
        has_transcript: true,
        has_events: true,
        tool_count: 0,
        failed_tool_count: 0,
      },
      {
        id: 'call-legacy',
        caller_number: '+15551112222',
        called_number: '+15553334444',
        agent_id: 'agent-2',
        direction: 'inbound',
        lifecycle_state: 'CALL_COMPLETED',
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        duration_seconds: 30,
        total_cost_cents: 50,
        environment: 'development',
        created_at: new Date().toISOString(),
        stir_status: null,
        stir_verstat: null,
        stir_attestation: null,
        // Fallback wins: cs.language = NULL, COALESCE pulls a.language = 'fr'
        language: 'fr',
        agent_name: 'Réception',
        has_transcript: false,
        has_events: false,
        tool_count: 0,
        failed_tool_count: 0,
      },
      {
        id: 'call-unknown',
        caller_number: '+15551112222',
        called_number: '+15553334444',
        agent_id: 'agent-3',
        direction: 'inbound',
        lifecycle_state: 'CALL_COMPLETED',
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        duration_seconds: 10,
        total_cost_cents: 10,
        environment: 'development',
        created_at: new Date().toISOString(),
        stir_status: null,
        stir_verstat: null,
        stir_attestation: null,
        // Neither snapshot nor agent.language known -> NULL passes through
        language: null,
        agent_name: 'Mystery Agent',
        has_transcript: false,
        has_events: false,
        tool_count: 0,
        failed_tool_count: 0,
      },
    ];

    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (s.includes('set_config')) return { rows: [] };
      if (s.includes('AS total FROM call_sessions cs')) {
        return { rows: [{ total: '3' }] };
      }
      // The main listing SELECT
      return { rows };
    });

    const app = await buildApp();
    const res = await request(app).get('/calls?limit=10&page=1');

    expect(res.status).toBe(200);
    expect(res.body.calls).toHaveLength(3);
    expect(res.body.calls[0].language).toBe('es');
    expect(res.body.calls[1].language).toBe('fr');
    expect(res.body.calls[2].language).toBeNull();
    expect(res.body.total).toBe(3);

    // Sanity-check the SQL itself: the snapshot/fallback semantics live
    // entirely in the COALESCE expression, so a regression that drops it
    // must fail this assertion before it can reach production.
    const listingCall = queryMock.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' && (c[0] as string).includes('FROM call_sessions cs'),
    );
    expect(listingCall, 'expected a SELECT FROM call_sessions cs').toBeTruthy();
    const listingSql = String(listingCall![0]);
    expect(listingSql).toMatch(/COALESCE\s*\(\s*cs\.language\s*,\s*a\.language\s*\)\s+AS\s+language/i);
    expect(listingSql).toMatch(/LEFT JOIN agents a/i);
  });
});

describe('GET /calls/:id detail returns language with COALESCE fallback', () => {
  it('returns the snapshotted language on the detail payload', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (s.includes('set_config')) return { rows: [] };
      // Detail SELECT — snapshot wins
      return {
        rows: [
          {
            id: 'call-detail-1',
            tenant_id: 'tenant-A',
            agent_id: 'agent-1',
            caller_number: '+15551112222',
            called_number: '+15553334444',
            direction: 'inbound',
            lifecycle_state: 'CALL_COMPLETED',
            start_time: new Date().toISOString(),
            end_time: new Date().toISOString(),
            duration_seconds: 60,
            total_cost_cents: 100,
            environment: 'development',
            created_at: new Date().toISOString(),
            // The COALESCE alias overrides cs.* expansion to produce 'es'.
            language: 'es',
            agent_name: 'Recepción',
          },
        ],
      };
    });

    const app = await buildApp();
    const res = await request(app).get('/calls/call-detail-1');

    expect(res.status).toBe(200);
    expect(res.body.call.language).toBe('es');

    const detailCall = queryMock.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('FROM call_sessions cs') &&
        (c[0] as string).includes('cs.id = $1'),
    );
    expect(detailCall, 'expected a SELECT FROM call_sessions cs WHERE cs.id = $1').toBeTruthy();
    const detailSql = String(detailCall![0]);
    expect(detailSql).toMatch(/COALESCE\s*\(\s*cs\.language\s*,\s*a\.language\s*\)\s+AS\s+language/i);
    expect(detailSql).toMatch(/LEFT JOIN agents a/i);
  });

  it('returns the agent fallback language for legacy rows where cs.language is NULL', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (s.includes('set_config')) return { rows: [] };
      return {
        rows: [
          {
            id: 'call-legacy-1',
            tenant_id: 'tenant-A',
            agent_id: 'agent-2',
            caller_number: '+15551112222',
            called_number: '+15553334444',
            direction: 'inbound',
            lifecycle_state: 'CALL_COMPLETED',
            start_time: new Date().toISOString(),
            end_time: new Date().toISOString(),
            duration_seconds: 30,
            total_cost_cents: 50,
            environment: 'development',
            created_at: new Date().toISOString(),
            // cs.language = NULL on the row, but COALESCE pulled the agent's
            // currently configured language ('fr') so the API still surfaces
            // a value rather than blanking out historical reports.
            language: 'fr',
            agent_name: 'Réception',
          },
        ],
      };
    });

    const app = await buildApp();
    const res = await request(app).get('/calls/call-legacy-1');

    expect(res.status).toBe(200);
    expect(res.body.call.language).toBe('fr');
  });
});
