import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  getCallTracesMock: vi.fn(),
  getIntegrationEventsMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.queryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/core/observability/traceLogger', () => ({
  getCallTraces: a.getCallTracesMock,
  getIntegrationEvents: a.getIntegrationEventsMock,
  maskPIIPublic: (v: unknown) => v,
}));

import router from './callDebug';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.getCallTracesMock.mockReset().mockResolvedValue([]);
  a.getIntegrationEventsMock.mockReset().mockResolvedValue([]);
});

describe('GET /calls/:id/traces', () => {
  it('returns traces', async () => {
    a.getCallTracesMock.mockResolvedValue([{ id: 't1' }]);
    const res = await request(app()).get('/calls/c1/traces');
    expect(res.body).toMatchObject({ callId: 'c1' });
    expect(res.body.traces).toHaveLength(1);
  });
  it('500 on failure', async () => {
    a.getCallTracesMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/calls/c1/traces')).status).toBe(500);
  });
});

describe('GET /calls/:id/integration-events', () => {
  it('returns integration events', async () => {
    a.getIntegrationEventsMock.mockResolvedValue([{ id: 'e1' }]);
    expect((await request(app()).get('/calls/c1/integration-events')).body.integrationEvents).toHaveLength(1);
  });
  it('500 on failure', async () => {
    a.getIntegrationEventsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/calls/c1/integration-events')).status).toBe(500);
  });
});

describe('GET /calls/:id/replay', () => {
  it('returns 404 when the call is not found', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM call_sessions cs') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).get('/calls/c1/replay')).status).toBe(404);
  });

  it('returns a redacted replay bundle', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM call_sessions cs') && sql.includes('cs.id = $1')) {
        return { rows: [{ id: 'c1', caller_number: '+15551234567', called_number: '+15557654321', agent_name: 'Bot' }] };
      }
      if (sql.includes('FROM call_transcripts')) return { rows: [{ id: 'tr1', role: 'agent', content: 'hi' }] };
      if (sql.includes('FROM call_events')) return { rows: [{ id: 'ev1', event_type: 'x', payload: {} }] };
      if (sql.includes('FROM tool_invocations')) return { rows: [{ id: 'ti1', input: {}, output: {}, result: {} }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/calls/c1/replay');
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({ id: 'c1' });
    expect(res.body.transcript).toHaveLength(1);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.toolInvocations).toHaveLength(1);
  });

  it('500 + rollback on error', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK|COMMIT)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/calls/c1/replay')).status).toBe(500);
  });
});

describe('GET /calls-debug/search', () => {
  it('applies filters and returns a paged result', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: '3' }] };
      if (sql.includes('FROM call_sessions cs')) return { rows: [{ id: 'c1', caller_number: '+15551234567' }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/calls-debug/search?agent_id=a1&has_tool_failure=true&escalated=true&sort_by=cost&sort_order=asc&search=foo');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.calls).toHaveLength(1);
  });
  it('500 on failure', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/calls-debug/search')).status).toBe(500);
  });
});

describe('GET /operations/live-board', () => {
  it('returns active calls with tool calls and current step', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("NOT IN ('CALL_COMPLETED'")) {
        return { rows: [{ id: 'c1', agent_id: 'a1', agent_name: 'Bot', direction: 'inbound', lifecycle_state: 'ACTIVE_CONVERSATION', start_time: 'now', caller_number: '+15551234567', elapsed_seconds: 12 }] };
      }
      if (sql.includes("status IN ('pending', 'running')")) {
        return { rows: [{ id: 'ti1', call_session_id: 'c1', tool_name: 'lookup', status: 'running', invoked_at: 'now' }] };
      }
      if (sql.includes('FROM execution_traces')) {
        return { rows: [{ id: 'tr1', call_session_id: 'c1', trace_type: 'llm', step_name: 'plan', started_at: 'now', duration_ms: 5 }] };
      }
      return { rows: [] };
    });
    const res = await request(app()).get('/operations/live-board');
    expect(res.status).toBe(200);
    expect(res.body.totalActive).toBe(1);
    expect(res.body.activeCalls[0].activeToolCalls).toHaveLength(1);
    expect(res.body.activeCalls[0].currentStep).toMatchObject({ stepName: 'plan' });
  });

  it('handles no active calls (skips sub-queries)', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    const res = await request(app()).get('/operations/live-board');
    expect(res.body.totalActive).toBe(0);
  });

  it('500 on failure', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/operations/live-board')).status).toBe(500);
  });
});
