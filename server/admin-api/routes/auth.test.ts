import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'me@x.com', role: 'operations_manager', isPlatformAdmin: false },
  clientQueryMock: vi.fn(),
  poolQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  issueTokenMock: vi.fn(),
  issueMfaFlowTokenMock: vi.fn(),
  bcryptCompareMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
  issueToken: a.issueTokenMock,
  issueMfaFlowToken: a.issueMfaFlowTokenMock,
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

import { authAttemptRateLimitMax } from '../../../platform/security/authAttemptRateLimit';
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
  a.issueMfaFlowTokenMock.mockReset().mockReturnValue('mfa-flow-token');
  a.bcryptCompareMock.mockReset().mockResolvedValue(true);
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
});

const activeUserRow = {
  id: 'u1', email: 'me@x.com', password_hash: 'hash', is_active: true,
  is_platform_admin: false, email_verified: true, tenant_id: 't1', role: 'operations_manager',
};

describe('authAttemptRateLimitMax', () => {
  it('stays at 10 in production and staging, and opens up otherwise', () => {
    const previous = process.env.APP_ENV;
    try {
      process.env.APP_ENV = 'production';
      expect(authAttemptRateLimitMax()).toBe(10);
      process.env.APP_ENV = 'staging';
      expect(authAttemptRateLimitMax()).toBe(10);
      process.env.APP_ENV = 'development';
      expect(authAttemptRateLimitMax()).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previous;
    }
  });
});

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

  it('requires TOTP enrollment before issuing a platform-admin session', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => (
      sql.includes('FROM users u')
        ? { rows: [{ ...activeUserRow, is_platform_admin: true, mfa_enabled_at: null }] }
        : { rows: [] }
    ));

    const res = await request(app()).post('/auth/login').send({ email: 'admin@x.com', password: 'good' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ mfaSetupRequired: true, mfaSetupToken: 'mfa-flow-token' });
    expect(a.issueMfaFlowTokenMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), 'mfa_setup');
    expect(a.issueTokenMock).not.toHaveBeenCalled();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('requires an MFA challenge for an enrolled platform admin', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => (
      sql.includes('FROM users u')
        ? { rows: [{ ...activeUserRow, is_platform_admin: true, mfa_enabled_at: '2026-07-13T00:00:00.000Z' }] }
        : { rows: [] }
    ));

    const res = await request(app()).post('/auth/login').send({ email: 'admin@x.com', password: 'good' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ mfaRequired: true, mfaChallengeToken: 'mfa-flow-token' });
    expect(a.issueMfaFlowTokenMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), 'mfa_challenge');
    expect(a.issueTokenMock).not.toHaveBeenCalled();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rate-limits repeated password attempts for the same email and client', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [] });
    const limit = authAttemptRateLimitMax();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < limit + 1; attempt += 1) {
      statuses.push((await request(app()).post('/auth/login').send({
        email: 'blocked@example.com',
        password: 'wrong-password',
      })).status);
    }
    expect(statuses.slice(0, limit).every((status) => status === 401)).toBe(true);
    expect(statuses[limit]).toBe(429);
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

describe('POST /auth/accept-invite', () => {
  it('requires MFA setup instead of issuing privileged access to a new platform admin', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM user_invitations ui') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          id: 'invite-1', email: 'admin2@x.com', role: 'support_reviewer', tenant_id: 'admin-org',
          expires_at: new Date(Date.now() + 60_000).toISOString(), accepted_at: null,
        }] };
      }
      return { rows: [] };
    });
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT u.id, u.email, u.is_platform_admin')) {
        return { rows: [{
          id: 'admin-2', email: 'admin2@x.com', is_platform_admin: true,
          role: 'support_reviewer', tenant_id: 'admin-org', mfa_enabled_at: null,
        }] };
      }
      return { rows: [] };
    });

    const res = await request(app()).post('/auth/accept-invite').send({ token: 'invite-token', password: 'strong-password' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ mfaSetupRequired: true, mfaSetupToken: 'mfa-flow-token' });
    expect(a.issueMfaFlowTokenMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-2' }), 'mfa_setup');
    expect(a.issueTokenMock).not.toHaveBeenCalled();
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
