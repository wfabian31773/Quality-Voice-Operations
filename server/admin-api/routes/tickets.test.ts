import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  poolQueryMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
// requireMiniSystemWrite from ../middleware/rbac stays real.
vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.poolQueryMock, connect: async () => ({ query: a.poolQueryMock, release: vi.fn() }) }) }));
vi.mock('../../../platform/email', () => ({ sendEmail: a.sendEmailMock }));

import router from './tickets';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.sendEmailMock.mockReset().mockResolvedValue({ success: true });
});

describe('list endpoints (simple reads)', () => {
  const listRoutes: Array<[string, string]> = [
    ['/tickets', 'tickets'],
    ['/ticket-categories', 'categories'],
    ['/ticket-sla-policies', 'policies'],
    ['/ticket-macros', 'macros'],
    ['/ticket-templates', 'templates'],
    ['/ticket-saved-views', 'savedViews'],
    ['/ticket-workflow-rules', 'rules'],
    ['/ticket-custom-fields', 'fields'],
    ['/ticket-queue-configs', 'configs'],
    ['/ticket-retention-policies', 'policies'],
    ['/ticket-notifications', 'notifications'],
  ];
  for (const [path] of listRoutes) {
    it(`GET ${path} returns 200`, async () => {
      expect((await request(app()).get(path)).status).toBe(200);
    });
  }
  it('GET /tickets surfaces query failures as 500', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/tickets')).status).toBe(500);
  });
});

describe('GET /tickets/:id', () => {
  it('404 when the ticket is missing', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/tickets/tk1')).status).toBe(404);
  });
  it('returns a ticket with related data', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM tickets t') && sql.includes('WHERE t.id') ? { rows: [{ id: 'tk1', subject: 'Help' }] } : { rows: [] },
    );
    const res = await request(app()).get('/tickets/tk1');
    expect(res.status).toBe(200);
    expect(res.body.ticket ?? res.body).toBeTruthy();
  });
  it('includes the tenant-scoped receptionist outcome for a call-linked ticket', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM tickets t') && sql.includes('WHERE t.id')) return { rows: [{ id: 'tk1', subject: 'Appointment request', call_id: 'call-1' }] };
      if (sql.includes('FROM call_sessions cs') && sql.includes('transcript_count')) {
        expect(values).toEqual(['call-1', 't1']);
        return { rows: [{ id: 'call-1', language: 'en', lifecycle_state: 'CALL_COMPLETED', context: {}, transcript_count: 3 }] };
      }
      if (sql.includes('FROM outbox_messages')) return { rows: [{ id: 'out-1', status: 'sent', payload: {
        type: 'answering_service_ticket', outcomeType: 'appointment_request', reasonForCall: 'Needs an exam',
        requestedAction: 'Call to arrange a time', summary: 'Appointment request; staff confirmation required.',
      } }] };
      if (sql.includes('FROM tickets t') && sql.includes('t.call_id')) return { rows: [{ id: 'tk1', status: 'open', priority: 'medium' }] };
      if (sql.includes('FROM tool_invocations') || sql.includes('FROM escalation_tasks')) return { rows: [] };
      return { rows: [] };
    });
    const res = await request(app()).get('/tickets/tk1');
    expect(res.status).toBe(200);
    expect(res.body.receptionistOutcome).toMatchObject({
      callId: 'call-1', outcome: { type: 'appointment_request' },
      followUp: { ticketId: 'tk1', nextAction: 'Call to arrange a time' },
    });
  });
});

describe('POST /tickets', () => {
  it('rejects a missing subject', async () => {
    expect((await request(app()).post('/tickets').send({})).status).toBe(400);
  });
  it('rejects a non-member assignee', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM user_roles') ? { rows: [] } : { rows: [{ id: 'tk1' }] },
    );
    const res = await request(app()).post('/tickets').send({ subject: 'X', assignee_user_id: 'nobody' });
    expect(res.status).toBe(400);
  });
  it('creates a ticket', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO tickets')) return { rows: [{ id: 'tk1', subject: 'X' }] };
      if (sql.includes('ticket_sla_policies')) return { rows: [] };
      return { rows: [] };
    });
    const res = await request(app()).post('/tickets').send({ subject: 'X' });
    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({ id: 'tk1' });
  });
  it('rejects a viewer via the mini-system-write gate', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/tickets').send({ subject: 'X' })).status).toBe(403);
  });
});

describe('mini-system-write gate', () => {
  it('blocks a viewer from creating a category', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/ticket-categories').send({ name: 'C' })).status).toBe(403);
  });
  it('blocks a read-only tenant role from advancing a follow-up ticket', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).put('/tickets/tk1').send({ status: 'in_progress' })).status).toBe(403);
  });
});
