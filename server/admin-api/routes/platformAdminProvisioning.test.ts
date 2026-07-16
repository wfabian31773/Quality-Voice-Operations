import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'wayne', tenantId: 'admin-org', email: 'owner@example.com', role: 'tenant_owner', isPlatformAdmin: true, mfaVerified: true },
  query: vi.fn(),
  release: vi.fn(),
  sendEmail: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.query, release: a.release }) }),
}));
vi.mock('../../../platform/email/EmailService', () => ({ sendEmail: a.sendEmail }));
vi.mock('../../../platform/email/templates', () => ({
  invitationEmail: () => ({ subject: 'QVO invitation', html: '<p>invite</p>', text: 'invite' }),
}));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAudit, extractIp: () => '127.0.0.1' }));

import router from './platformAdminProvisioning';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(router);
  return instance;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id, is_platform_admin')) return { rows: [] };
    if (sql.includes('RETURNING id, email')) return { rows: [{ id: 'yaritza', email: 'yferrera05@hotmail.com' }] };
    return { rows: [] };
  });
  a.release.mockReset();
  a.sendEmail.mockReset().mockResolvedValue({ success: true });
  a.writeAudit.mockReset().mockResolvedValue(undefined);
  process.env.APP_URL = 'https://qvo.example.com';
});

describe('POST /platform/compliance/platform-admins/invite', () => {
  it('requires an MFA-verified platform-admin session', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).post('/platform/compliance/platform-admins/invite').send({ email: 'yferrera05@hotmail.com' })).status).toBe(403);
  });

  it('validates the confirmed sign-in email', async () => {
    expect((await request(app()).post('/platform/compliance/platform-admins/invite').send({ email: 'not-an-email' })).status).toBe(400);
    expect(a.query).not.toHaveBeenCalled();
  });

  it('creates an inactive least-privilege identity, global admin flag, expiring invitation, and audit record', async () => {
    const res = await request(app()).post('/platform/compliance/platform-admins/invite').send({
      email: 'yferrera05@hotmail.com',
      firstName: 'Yaritza',
      lastName: 'Ferreras Fernandez',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'yferrera05@hotmail.com', invitationSent: true, mfaRequired: true });
    expect(a.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO users[\s\S]*is_platform_admin[\s\S]*FALSE[\s\S]*TRUE/i),
      expect.arrayContaining(['yferrera05@hotmail.com', 'Yaritza', 'Ferreras Fernandez']),
    );
    expect(a.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO user_roles[\s\S]*support_reviewer/i),
      expect.arrayContaining(['admin-org']),
    );
    expect(a.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO user_invitations/i),
      expect.arrayContaining(['admin-org', 'yferrera05@hotmail.com']),
    );
    expect(a.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'platform_admin.invited',
      resourceId: 'yaritza',
    }));
  });

  it('does not duplicate an already enrolled platform administrator', async () => {
    a.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, is_platform_admin')) return { rows: [{ id: 'existing', is_platform_admin: true, mfa_enabled_at: '2026-07-13T00:00:00Z' }] };
      return { rows: [] };
    });
    expect((await request(app()).post('/platform/compliance/platform-admins/invite').send({ email: 'yferrera05@hotmail.com' })).status).toBe(409);
  });

  it('fails before mutation when no absolute application URL is configured', async () => {
    delete process.env.APP_URL;
    delete process.env.REPLIT_DEV_DOMAIN;
    expect((await request(app()).post('/platform/compliance/platform-admins/invite').send({ email: 'yferrera05@hotmail.com' })).status).toBe(503);
    expect(a.query).not.toHaveBeenCalled();
  });
});
