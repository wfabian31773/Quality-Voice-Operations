import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'me@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  getConversationCostMock: vi.fn(),
  getTenantBillingCurrencyMock: vi.fn(),
  notifyMock: vi.fn(),
  diffMock: vi.fn(),
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
vi.mock('../../../platform/billing/cost', () => ({ getConversationCost: a.getConversationCostMock }));
vi.mock('../../../platform/billing/tenantCurrency', () => ({ getTenantBillingCurrency: a.getTenantBillingCurrencyMock }));
vi.mock('../../../platform/analytics/CallViewSubscriberNotifier', () => ({
  notifySubscriberChanges: a.notifyMock,
  diffSubscribers: a.diffMock,
}));

import router from './calls';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.userId = 'u1';
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
  a.getConversationCostMock.mockReset().mockResolvedValue(null);
  a.getTenantBillingCurrencyMock.mockReset().mockResolvedValue('USD');
  a.notifyMock.mockReset().mockResolvedValue(undefined);
  a.diffMock.mockReset().mockReturnValue({ added: [], removed: [] });
});

describe('GET /calls', () => {
  it('lists calls with filters and redacts numbers', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ORDER BY cs.created_at DESC')) return { rows: [{ id: 'c1', caller_number: '555-123-4567', called_number: '555-765-4321' }] };
      if (sql.includes('COUNT(*) AS total')) return { rows: [{ total: '1' }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/calls?has_transcript=true&has_events=false&tool_failures_only=1&q=foo&agent_id=a1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.calls[0].caller_number).toContain('[PHONE_REDACTED]');
  });
  it('500 + rollback on error', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/calls')).status).toBe(500);
  });
});

describe('GET /calls/:id', () => {
  it('returns 404 when not found', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('WHERE cs.id = $1 AND cs.tenant_id = $2') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).get('/calls/c1')).status).toBe(404);
  });
  it('returns the call with cost + currency', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('WHERE cs.id = $1 AND cs.tenant_id = $2')
        ? { rows: [{ id: 'c1', caller_number: '555-123-4567' }] } : { rows: [] },
    );
    a.getConversationCostMock.mockResolvedValue({ cents: 10 });
    const res = await request(app()).get('/calls/c1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ costBreakdown: { cents: 10 }, currency: 'USD' });
    expect(res.body.call.caller_number).toContain('[PHONE_REDACTED]');
  });
});

describe('GET /calls/:id/outcome', () => {
  it('returns a tenant-scoped healthcare dashboard projection', async () => {
    a.queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM call_sessions cs') && sql.includes('transcript_count')) {
        expect(values).toEqual(['c1', 't1']);
        return { rows: [{
          id: 'c1', language: 'es', lifecycle_state: 'CALL_COMPLETED',
          context: { recordingPolicy: { policy: 'disabled', status: 'not_recorded' } },
          transcript_count: 2,
        }] };
      }
      if (sql.includes('FROM outbox_messages')) {
        expect(values).toEqual(['t1', 'c1']);
        return { rows: [{ id: 'o1', status: 'sent', payload: {
          type: 'answering_service_ticket', callerFirstName: 'Ana', callerLastName: 'Lopez',
          callerPhone: '+15555550100', reasonForCall: 'Needs an appointment',
          outcomeType: 'appointment_request', summary: 'Appointment request; staff confirmation required.',
          requestedAction: 'Call back to arrange a time', urgency: 'routine',
        } }] };
      }
      if (sql.includes('FROM tickets t')) {
        expect(values).toEqual(['t1', 'c1']);
        return { rows: [{ id: 'tk1', ticket_number: 12, status: 'open', priority: 'medium' }] };
      }
      if (sql.includes('FROM tool_invocations')) return { rows: [{ id: 'ti1', tool_name: 'createServiceTicket', status: 'success' }] };
      if (sql.includes('FROM escalation_tasks')) return { rows: [] };
      return { rows: [] };
    });

    const res = await request(app()).get('/calls/c1/outcome');
    expect(res.status).toBe(200);
    expect(res.body.projection).toMatchObject({
      callId: 'c1', language: 'es',
      outcome: { type: 'appointment_request', requestedAction: 'Call back to arrange a time' },
      followUp: { ticketId: 'tk1', status: 'open' },
      operationalValue: { state: 'staff_follow_up_created' },
    });
  });

  it('does not fall back to another tenant and returns 404 for an unknown call', async () => {
    a.queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM call_sessions cs') && sql.includes('transcript_count')) {
        expect(values).toEqual(['missing', 't1']);
        return { rows: [] };
      }
      return { rows: [] };
    });
    expect((await request(app()).get('/calls/missing/outcome')).status).toBe(404);
  });
});

describe('GET /calls/:id/transcript & /events', () => {
  it('transcript 404 when call missing', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT id FROM call_sessions WHERE id = $1') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).get('/calls/c1/transcript')).status).toBe(404);
  });
  it('returns transcript lines', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM call_sessions WHERE id = $1')) return { rows: [{ id: 'c1' }] };
      if (sql.includes('FROM call_transcripts')) return { rows: [{ id: 'l1', role: 'agent', content: 'hi' }] };
      return { rows: [] };
    });
    expect((await request(app()).get('/calls/c1/transcript')).body.transcript).toHaveLength(1);
  });
  it('returns call events', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM call_sessions WHERE id = $1')) return { rows: [{ id: 'c1' }] };
      if (sql.includes('FROM call_events')) return { rows: [{ id: 'e1', event_type: 'x' }] };
      return { rows: [] };
    });
    expect((await request(app()).get('/calls/c1/events')).body.events).toHaveLength(1);
  });
});

describe('saved views — list & pinned', () => {
  it('lists saved views', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM call_saved_views v') ? { rows: [{ id: 'v1', name: 'V' }] } : { rows: [] },
    );
    expect((await request(app()).get('/call-saved-views')).body.views).toHaveLength(1);
  });
  it('lists pinned views with match counts', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM call_saved_view_pins p')) return { rows: [{ id: 'v1', name: 'V', filters: { direction: 'inbound' }, is_shared: false, is_pinned: true, created_by: 'u1' }] };
      if (sql.includes('COUNT(*)::int AS count')) return { rows: [{ count: 7 }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/call-saved-views/pinned');
    expect(res.body.views[0]).toMatchObject({ id: 'v1', count: 7 });
  });
});

describe('POST /call-saved-views', () => {
  it('validates name', async () => {
    expect((await request(app()).post('/call-saved-views').send({})).status).toBe(400);
    expect((await request(app()).post('/call-saved-views').send({ name: 'x'.repeat(256) })).status).toBe(400);
  });
  it('rejects subscribers that are not tenant members', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM users WHERE tenant_id') ? { rows: [] } : { rows: [] },
    );
    const res = await request(app()).post('/call-saved-views').send({ name: 'V', digest_subscribers: ['ext@evil.com'] });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toContain('ext@evil.com');
  });
  it('creates a saved view (with pin)', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO call_saved_views')) return { rows: [{ id: 'v9', name: 'V' }] };
      if (sql.includes('MAX(pin_order)')) return { rows: [{ next_order: 0 }] };
      return { rows: [] };
    });
    const res = await request(app()).post('/call-saved-views').send({ name: 'V', is_pinned: true });
    expect(res.status).toBe(201);
    expect(res.body.view).toMatchObject({ id: 'v9', is_pinned: true });
  });
});

describe('PATCH /call-saved-views/:id', () => {
  it('404 when missing', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT created_by, is_shared') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).patch('/call-saved-views/v1').send({ name: 'New' })).status).toBe(404);
  });
  it('403 for a non-owner editing a non-shared view', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT created_by, is_shared') ? { rows: [{ created_by: 'other', is_shared: false, digest_subscribers: [] }] } : { rows: [] },
    );
    expect((await request(app()).patch('/call-saved-views/v1').send({ name: 'New' })).status).toBe(403);
  });
  it('owner updates the name', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT created_by, is_shared')) return { rows: [{ created_by: 'u1', is_shared: false, digest_subscribers: [] }] };
      if (sql.includes('UPDATE call_saved_views SET')) return { rows: [{ id: 'v1', name: 'New' }] };
      if (sql.includes('FROM call_saved_view_pins WHERE user_id')) return { rows: [] };
      return { rows: [] };
    });
    const res = await request(app()).patch('/call-saved-views/v1').send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.view).toMatchObject({ name: 'New' });
  });
  it('400 when no fields to update', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT created_by, is_shared') ? { rows: [{ created_by: 'u1', is_shared: false, digest_subscribers: [] }] } : { rows: [] },
    );
    expect((await request(app()).patch('/call-saved-views/v1').send({})).status).toBe(400);
  });
});

describe('DELETE /call-saved-views/:id', () => {
  it('404 when missing', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT created_by FROM call_saved_views') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).delete('/call-saved-views/v1')).status).toBe(404);
  });
  it('403 for non-owner', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT created_by FROM call_saved_views') ? { rows: [{ created_by: 'other' }] } : { rows: [] },
    );
    expect((await request(app()).delete('/call-saved-views/v1')).status).toBe(403);
  });
  it('owner deletes the view', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT created_by FROM call_saved_views') ? { rows: [{ created_by: 'u1' }] } : { rows: [] },
    );
    expect((await request(app()).delete('/call-saved-views/v1')).body).toEqual({ success: true });
  });
});

describe('POST /call-saved-views/pinned/reorder', () => {
  it('validates the ids array', async () => {
    expect((await request(app()).post('/call-saved-views/pinned/reorder').send({ ids: [] })).status).toBe(400);
    expect((await request(app()).post('/call-saved-views/pinned/reorder').send({ ids: ['a', 'a'] })).status).toBe(400);
  });
  it('403 when reordering views not all pinned by the user', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT view_id FROM call_saved_view_pins') ? { rows: [{ view_id: 'a' }] } : { rows: [] },
    );
    expect((await request(app()).post('/call-saved-views/pinned/reorder').send({ ids: ['a', 'b'] })).status).toBe(403);
  });
  it('reorders pins', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT view_id FROM call_saved_view_pins') ? { rows: [{ view_id: 'a' }, { view_id: 'b' }] } : { rows: [] },
    );
    expect((await request(app()).post('/call-saved-views/pinned/reorder').send({ ids: ['a', 'b'] })).body).toEqual({ success: true });
  });
});
