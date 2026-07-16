import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  release: vi.fn(),
  verifyFlow: vi.fn(),
  issueToken: vi.fn(),
  generateSecret: vi.fn(),
  encryptSecret: vi.fn(),
  decryptSecret: vi.fn(),
  matchStep: vi.fn(),
  recoveryCodes: vi.fn(),
  hashRecovery: vi.fn(),
  verifyRecovery: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQuery, release: a.release }) }),
}));
vi.mock('../middleware/auth', () => ({
  verifyMfaFlowToken: a.verifyFlow,
  issueToken: a.issueToken,
}));
vi.mock('../middleware/security', () => ({ authCookieOptions: () => ({ httpOnly: true }) }));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('../../../platform/security/TotpMfa', () => ({
  generateTotpSecret: a.generateSecret,
  encryptTotpSecret: a.encryptSecret,
  decryptTotpSecret: a.decryptSecret,
  matchTotpStep: a.matchStep,
  generateRecoveryCodes: a.recoveryCodes,
  hashRecoveryCode: a.hashRecovery,
  verifyRecoveryCode: a.verifyRecovery,
}));
vi.mock('../../../platform/audit/AuditService', () => ({
  writeAuditLog: a.writeAudit,
  extractIp: () => '127.0.0.1',
}));

import router from './mfa';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(router);
  return instance;
}

const identity = {
  userId: 'admin-2',
  tenantId: 'admin-org',
  email: 'reviewer@example.com',
  role: 'support_reviewer',
};

const enabledRow = {
  id: identity.userId,
  email: identity.email,
  is_platform_admin: true,
  mfa_enabled_at: '2026-07-13T00:00:00.000Z',
  mfa_totp_secret_encrypted: 'encrypted-seed',
  mfa_recovery_code_hashes: ['hash-1', 'hash-2'],
  mfa_last_totp_step: '100',
  mfa_failed_attempts: 0,
  mfa_locked_until: null,
};

beforeEach(() => {
  a.clientQuery.mockReset().mockResolvedValue({ rows: [] });
  a.release.mockReset();
  a.verifyFlow.mockReset().mockReturnValue(identity);
  a.issueToken.mockReset().mockReturnValue('session-token');
  a.generateSecret.mockReset().mockReturnValue('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  a.encryptSecret.mockReset().mockReturnValue('encrypted-seed');
  a.decryptSecret.mockReset().mockReturnValue('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  a.matchStep.mockReset().mockReturnValue(101n);
  a.recoveryCodes.mockReset().mockReturnValue(['ABCDE-FGHIJ', 'KLMNO-PQRST']);
  a.hashRecovery.mockReset().mockImplementation((code: string) => `hash:${code}`);
  a.verifyRecovery.mockReset().mockReturnValue(false);
  a.writeAudit.mockReset().mockResolvedValue(undefined);
});

describe('POST /auth/mfa/setup/start', () => {
  it('rejects an invalid setup token without touching the database', async () => {
    a.verifyFlow.mockImplementation(() => { throw new Error('bad token'); });
    const res = await request(app()).post('/auth/mfa/setup/start').send({ mfaSetupToken: 'bad' });
    expect(res.status).toBe(401);
    expect(a.clientQuery).not.toHaveBeenCalled();
  });

  it('stores only an encrypted pending seed and returns an authenticator URI', async () => {
    a.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT is_platform_admin')) return { rows: [{ is_platform_admin: true, mfa_enabled_at: null }] };
      return { rows: [] };
    });

    const res = await request(app()).post('/auth/mfa/setup/start').send({ mfaSetupToken: 'setup-token-with-safe-length' });

    expect(res.status).toBe(200);
    expect(res.body.secret).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(res.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Quality%20Voice%20Operations:/);
    expect(a.clientQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SET mfa_pending_totp_secret_encrypted = \$1/),
      expect.arrayContaining(['encrypted-seed', identity.userId, identity.email]),
    );
    expect(a.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.mfa_setup_started' }));
  });
});

describe('POST /auth/mfa/setup/confirm', () => {
  it('enables MFA, returns recovery codes once, and issues an MFA-verified session', async () => {
    a.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rows: [{
        ...enabledRow,
        mfa_enabled_at: null,
        mfa_pending_totp_secret_encrypted: 'encrypted-seed',
        mfa_pending_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }] };
      return { rows: [] };
    });

    const res = await request(app()).post('/auth/mfa/setup/confirm').send({
      mfaSetupToken: 'setup-token-with-safe-length',
      code: '123456',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token: 'session-token', recoveryCodes: ['ABCDE-FGHIJ', 'KLMNO-PQRST'] });
    expect(a.issueToken).toHaveBeenCalledWith(expect.objectContaining({ isPlatformAdmin: true, mfaVerified: true }));
    expect(a.clientQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SET mfa_totp_secret_encrypted = mfa_pending_totp_secret_encrypted/),
      expect.arrayContaining([['hash:ABCDE-FGHIJ', 'hash:KLMNO-PQRST'], '101', identity.userId]),
    );
    expect(a.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.mfa_enabled' }));
  });
});

describe('POST /auth/mfa/challenge', () => {
  it('rejects a replayed TOTP step and never issues a session', async () => {
    a.matchStep.mockReturnValue(100n);
    a.clientQuery.mockImplementation(async (sql: string) => sql.includes('FOR UPDATE') ? { rows: [enabledRow] } : { rows: [] });

    const res = await request(app()).post('/auth/mfa/challenge').send({
      mfaChallengeToken: 'challenge-token-with-safe-length',
      code: '123456',
    });

    expect(res.status).toBe(401);
    expect(a.issueToken).not.toHaveBeenCalled();
  });

  it('records a new TOTP step and issues an MFA-verified session', async () => {
    a.clientQuery.mockImplementation(async (sql: string) => sql.includes('FOR UPDATE') ? { rows: [enabledRow] } : { rows: [] });

    const res = await request(app()).post('/auth/mfa/challenge').send({
      mfaChallengeToken: 'challenge-token-with-safe-length',
      code: '123456',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('session-token');
    expect(a.clientQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SET mfa_last_totp_step = \$1/),
      ['101', identity.userId],
    );
    expect(a.issueToken).toHaveBeenCalledWith(expect.objectContaining({ isPlatformAdmin: true, mfaVerified: true }));
  });

  it('atomically consumes a recovery code instead of retaining it', async () => {
    a.verifyRecovery.mockImplementation((code: string, hash: string) => code === 'ABCDE-FGHIJ' && hash === 'hash-1');
    a.clientQuery.mockImplementation(async (sql: string) => sql.includes('FOR UPDATE') ? { rows: [enabledRow] } : { rows: [] });

    const res = await request(app()).post('/auth/mfa/challenge').send({
      mfaChallengeToken: 'challenge-token-with-safe-length',
      recoveryCode: 'ABCDE-FGHIJ',
    });

    expect(res.status).toBe(200);
    expect(a.clientQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SET mfa_recovery_code_hashes = \$1/),
      [['hash-2'], identity.userId],
    );
  });

  it('blocks an already locked account', async () => {
    a.clientQuery.mockImplementation(async (sql: string) => sql.includes('FOR UPDATE') ? { rows: [{
      ...enabledRow,
      mfa_locked_until: new Date(Date.now() + 60_000).toISOString(),
    }] } : { rows: [] });

    const res = await request(app()).post('/auth/mfa/challenge').send({
      mfaChallengeToken: 'challenge-token-with-safe-length',
      code: '123456',
    });
    expect(res.status).toBe(423);
    expect(a.issueToken).not.toHaveBeenCalled();
  });
});
