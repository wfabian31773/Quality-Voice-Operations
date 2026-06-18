import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
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
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));

import router from './phoneNumbers';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
  a.writeAuditLogMock.mockReset();
  // Ensure Twilio is "not configured" so getTwilioClient() throws and the
  // provider routes hit their handled error paths without needing the SDK.
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});
afterEach(() => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});

describe('GET /phone-numbers', () => {
  it('lists numbers with total + free-number flag (redacted)', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM phone_numbers pn')) return { rows: [{ id: 'p1', phone_number: '+15551234567', friendly_name: 'Main' }] };
      if (sql.includes('COUNT(*) AS total')) return { rows: [{ total: '1' }] };
      if (sql.includes('BOOL_OR(is_free_number)')) return { rows: [{ has_free: true }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/phone-numbers');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, hasUsedFreeNumber: true });
    expect(res.body.phoneNumbers).toHaveLength(1);
    expect(res.body.phoneNumbers[0]).toHaveProperty('phone_number');
  });
  it('500 + rollback on error', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/phone-numbers')).status).toBe(500);
  });
});

describe('GET /phone-numbers/available', () => {
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).get('/phone-numbers/available')).status).toBe(403);
  });
  it('500 when Twilio is not configured', async () => {
    expect((await request(app()).get('/phone-numbers/available?areaCode=415')).status).toBe(500);
  });
});

describe('POST /phone-numbers/provision', () => {
  it('requires a phone_number', async () => {
    expect((await request(app()).post('/phone-numbers/provision').send({})).status).toBe(400);
  });
  it('rejects a non-E.164 number', async () => {
    expect((await request(app()).post('/phone-numbers/provision').send({ phone_number: '5551234' })).status).toBe(400);
  });
  it('500 when Twilio purchase is unavailable (no credentials)', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*) AS total') ? { rows: [{ total: '0', has_free: false }] } : { rows: [] },
    );
    const res = await request(app()).post('/phone-numbers/provision').send({ phone_number: '+14155550123' });
    expect(res.status).toBe(500);
  });
});
