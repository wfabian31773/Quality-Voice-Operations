import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'me@x.com', role: 'operations_manager', isPlatformAdmin: false },
  clientQueryMock: vi.fn(),
  poolQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  issueTokenMock: vi.fn(),
  bcryptCompareMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
  issueToken: a.issueTokenMock,
}));
vi.mock('../middleware/security', () => ({ authCookieOptions: () => ({ httpOnly: true }) }));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }), query: a.poolQueryMock }),
}));
vi.mock('bcryptjs', () => ({ default: { compare: a.bcryptCompareMock, hash: vi.fn().mockResolvedValue('hashed') } }));
vi.mock('../../../platform/billing/stripe/client', () => ({ getStripeClient: vi.fn() }));
vi.mock('../../../platform/billing/stripe/plans', () => ({ getPlanPriceId: vi.fn(), TRIAL_LIMITS: {}, }));
vi.mock('../../../platform/billing/supportedCurrencies', () => ({ isSupportedBillingCurrency: () => true }));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));

import router from './auth';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.issueTokenMock.mockReset().mockReturnValue('jwt-tok');
  a.bcryptCompareMock.mockReset().mockResolvedValue(true);
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
});

const activeUserRow = {
  id: 'u1', email: 'me@x.com', password_hash: 'hash', is_active: true,
  is_platform_admin: false, email_verified: true, tenant_id: 't1', role: 'operations_manager',
};

describe('POST /auth/login', () => {
  it('requires email + password', async () => {
    expect((await request(app()).post('/auth/login').send({ email: 'x@y.com' })).status).toBe(400);
  });
  it('401 for unknown user', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).post('/auth/login').send({ email: 'x@y.com', password: 'p' })).status).toBe(401);
  });
  it('403 for a disabled account', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ ...activeUserRow, is_active: false }] });
    expect((await request(app()).post('/auth/login').send({ email: 'me@x.com', password: 'p' })).status).toBe(403);
  });
  it('401 when no password hash is set', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ ...activeUserRow, password_hash: null }] });
    expect((await request(app()).post('/auth/login').send({ email: 'me@x.com', password: 'p' })).status).toBe(401);
  });
  it('401 on a wrong password', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => (sql.includes('FROM users u') ? { rows: [activeUserRow] } : { rows: [] }));
    a.bcryptCompareMock.mockResolvedValue(false);
    expect((await request(app()).post('/auth/login').send({ email: 'me@x.com', password: 'bad' })).status).toBe(401);
  });
  it('issues a token + sets cookie + audit on success', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => (sql.includes('FROM users u') ? { rows: [activeUserRow] } : { rows: [] }));
    const res = await request(app()).post('/auth/login').send({ email: 'me@x.com', password: 'good' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token: 'jwt-tok', tenantId: 't1', emailVerified: true });
    expect(res.headers['set-cookie'][0]).toContain('auth_token=jwt-tok');
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.login' }));
  });
});

describe('POST /auth/verify-email', () => {
  it('requires a token', async () => {
    expect((await request(app()).post('/auth/verify-email').send({})).status).toBe(400);
  });
  it('404 for an unknown token', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => (sql.includes('email_verification_token = $1') ? { rows: [] } : { rows: [] }));
    expect((await request(app()).post('/auth/verify-email').send({ token: 'bad' })).status).toBe(404);
  });
  it('verifies the email + activates the tenant', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('email_verification_token = $1') ? { rows: [{ id: 'u1', tenant_id: 't1' }] } : { rows: [] },
    );
    expect((await request(app()).post('/auth/verify-email').send({ token: 'ok' })).body).toEqual({ verified: true, tenantId: 't1' });
  });
});

describe('GET /auth/verification-status', () => {
  it('returns verification flags', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ email_verified: true, phone_verified: false, phone_number: null }] });
    expect((await request(app()).get('/auth/verification-status')).body).toMatchObject({ emailVerified: true, phoneVerified: false });
  });
  it('404 when the user row is gone', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/auth/verification-status')).status).toBe(404);
  });
});

describe('GET /auth/me + POST /auth/refresh', () => {
  it('returns the authenticated user', async () => {
    expect((await request(app()).get('/auth/me')).body.user).toMatchObject({ userId: 'u1' });
  });
  it('mints a refreshed token', async () => {
    expect((await request(app()).post('/auth/refresh')).body).toEqual({ token: 'jwt-tok' });
  });
});

describe('POST /auth/forgot-password', () => {
  it('requires an email', async () => {
    expect((await request(app()).post('/auth/forgot-password').send({})).status).toBe(400);
  });
  it('returns a generic success regardless of account existence', async () => {
    const res = await request(app()).post('/auth/forgot-password').send({ email: 'who@x.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
