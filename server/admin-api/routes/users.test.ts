import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'me@x.com', role: 'tenant_owner', isPlatformAdmin: false },
  clientQueryMock: vi.fn(),
  poolQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }),
    query: a.poolQueryMock,
  }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn().mockResolvedValue('hashed-pw') } }));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/email/EmailService', () => ({ sendEmail: a.sendEmailMock }));
vi.mock('../../../platform/email/templates', () => ({
  invitationEmail: () => ({ subject: 'Invite', html: '<p>hi</p>', text: 'hi' }),
}));

import usersRouter from './users';

function app() {
  const app = express();
  app.use(express.json());
  app.use(usersRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'tenant_owner';
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.writeAuditLogMock.mockReset();
  a.sendEmailMock.mockReset().mockResolvedValue({ success: true });
});

describe('GET /users', () => {
  it('lists users with role mapped to the simple form', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users u')) return { rows: [{ id: 'u2', email: 'a@x.com', role: 'operations_manager' }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: '1' }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/users');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.users[0].role).toBe('manager'); // operations_manager -> manager
  });

  it('rejects below-viewer (unauthenticated has no role) — viewer allowed', async () => {
    // viewer is the floor; a known role passes. Confirm a bogus low role is blocked.
    a.user.role = 'nonexistent_role';
    expect((await request(app()).get('/users')).status).toBe(403);
  });

  it('returns 500 and rolls back on error', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/users')).status).toBe(500);
  });
});

describe('POST /users/invite', () => {
  it('requires an email', async () => {
    expect((await request(app()).post('/users/invite').send({ role: 'viewer' })).status).toBe(400);
  });

  it('rejects an invalid role', async () => {
    expect((await request(app()).post('/users/invite').send({ email: 'x@y.com', role: 'superadmin' })).status).toBe(400);
  });

  it('creates a new user, sends the invite, and writes an audit log', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users WHERE email')) return { rows: [] }; // no existing user
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'new-user', email: 'x@y.com', first_name: null, last_name: null, created_at: 'now' }] };
      if (sql.includes('FROM user_roles WHERE tenant_id')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants')) return { rows: [{ name: 'Acme' }] };
      if (sql.includes('FROM users WHERE id')) return { rows: [{ first_name: 'In', last_name: 'Viter', email: 'inv@x.com' }] };
      return { rows: [] };
    });
    const res = await request(app()).post('/users/invite').send({ email: 'X@Y.com', role: 'operator' });
    expect(res.status).toBe(201);
    expect(res.body.invitationSent).toBe(true);
    expect(a.sendEmailMock).toHaveBeenCalled();
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.invited' }));
  });

  it('still returns 201 with emailError when delivery fails', async () => {
    a.sendEmailMock.mockResolvedValue({ success: false, error: 'smtp down' });
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users WHERE email')) return { rows: [{ id: 'existing', email: 'x@y.com' }] };
      if (sql.includes('FROM user_roles WHERE tenant_id')) return { rows: [{ id: 'r1' }] };
      return { rows: [], rowCount: 1 };
    });
    const res = await request(app()).post('/users/invite').send({ email: 'x@y.com', role: 'viewer' });
    expect(res.status).toBe(201);
    expect(res.body.invitationSent).toBe(false);
    expect(res.body.emailError).toBeTruthy();
  });
});

describe('/me/preferences', () => {
  it('returns the current preferences', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT preferences') ? { rows: [{ preferences: { theme: 'dark' } }] } : { rows: [] },
    );
    const res = await request(app()).get('/me/preferences');
    expect(res.body.preferences).toEqual({ theme: 'dark' });
  });

  it('rejects a non-object body', async () => {
    expect((await request(app()).patch('/me/preferences').send([1, 2])).status).toBe(400);
  });

  it('rejects an oversized payload with 413', async () => {
    const big = { blob: 'x'.repeat(9000) };
    expect((await request(app()).patch('/me/preferences').send(big)).status).toBe(413);
  });

  it('merges preferences and returns the result', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE users') ? { rows: [{ preferences: { theme: 'light', onboarding_step: 2 } }] } : { rows: [] },
    );
    const res = await request(app()).patch('/me/preferences').send({ onboarding_step: 2 });
    expect(res.status).toBe(200);
    expect(res.body.preferences).toMatchObject({ onboarding_step: 2 });
  });

  it('returns 404 when the user row is gone', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE users') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).patch('/me/preferences').send({ a: 1 })).status).toBe(404);
  });
});

describe('PATCH /users/:id/role', () => {
  it('rejects an invalid role', async () => {
    expect((await request(app()).patch('/users/u2/role').send({ role: 'god' })).status).toBe(400);
  });

  it('prevents changing your own role', async () => {
    const res = await request(app()).patch('/users/u1/role').send({ role: 'viewer' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('your own role');
  });

  it('updates a role and writes an audit log', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE user_roles') ? { rows: [], rowCount: 1 } : { rows: [] },
    );
    const res = await request(app()).patch('/users/u2/role').send({ role: 'manager' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: true, role: 'manager' });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.role_changed' }));
  });

  it('returns 404 when the user is not in the tenant', async () => {
    a.clientQueryMock.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    expect((await request(app()).patch('/users/ghost/role').send({ role: 'viewer' })).status).toBe(404);
  });
});
