/**
 * Route-level coverage for the tenant-facing CSAT settings + recent-responses
 * endpoints (`GET /csat/settings`, `PATCH /csat/settings`,
 * `GET /csat/responses/recent`).
 *
 * The admin-api mounts the real router with a stub auth middleware so we can
 * verify the role gates (manager for reads, owner for writes) and the
 * validation contract on the PATCH body without the JWT machinery.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const getSettingsMock = vi.fn();
const updateSettingsMock = vi.fn();
const listResponsesMock = vi.fn();

vi.mock('../../platform/analytics', async (orig) => {
  const actual = await orig<typeof import('../../platform/analytics')>();
  return {
    ...actual,
    getTenantCsatSettings: (...a: unknown[]) => getSettingsMock(...a),
    updateTenantCsatSettings: (...a: unknown[]) => updateSettingsMock(...a),
    listRecentCsatResponses: (...a: unknown[]) => listResponsesMock(...a),
  };
});

// Configurable per-test caller. Defaults to an owner so the happy paths work
// out of the box; tests that need to hit a 403 swap this in `beforeEach`.
let currentUser: {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
  isPlatformAdmin: boolean;
} = {
  userId: 'user-1',
  tenantId: 'tenant-A',
  email: 'owner@acme.test',
  role: 'tenant_owner',
  isPlatformAdmin: false,
};

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = currentUser;
    next();
  },
}));

beforeEach(() => {
  getSettingsMock.mockReset();
  updateSettingsMock.mockReset();
  listResponsesMock.mockReset();
  currentUser = {
    userId: 'user-1',
    tenantId: 'tenant-A',
    email: 'owner@acme.test',
    role: 'tenant_owner',
    isPlatformAdmin: false,
  };
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/csat')).default;
  app.use(router);
  return app;
}

describe('GET /csat/settings', () => {
  it('returns the tenant settings shape', async () => {
    getSettingsMock.mockResolvedValueOnce({
      enabled: true,
      channel: 'sms',
      scale: 5,
      minDurationSeconds: 30,
      smsTemplate: null,
    });
    const app = await buildApp();
    const res = await request(app).get('/csat/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      enabled: true,
      channel: 'sms',
      scale: 5,
      minDurationSeconds: 30,
      smsTemplate: null,
    });
    expect(getSettingsMock).toHaveBeenCalledWith('tenant-A');
  });

  it('blocks viewers (under manager threshold) with 403', async () => {
    currentUser = { ...currentUser, role: 'support_reviewer' };
    const app = await buildApp();
    const res = await request(app).get('/csat/settings');
    expect(res.status).toBe(403);
    expect(getSettingsMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /csat/settings', () => {
  it('persists owner edits and echoes the resulting settings', async () => {
    updateSettingsMock.mockResolvedValueOnce({
      enabled: true,
      channel: 'sms',
      scale: 10,
      minDurationSeconds: 60,
      smsTemplate: 'How was your call?',
    });
    const app = await buildApp();
    const res = await request(app)
      .patch('/csat/settings')
      .send({ enabled: true, channel: 'sms', scale: 10, minDurationSeconds: 60, smsTemplate: 'How was your call?' });
    expect(res.status).toBe(200);
    expect(res.body.settings.scale).toBe(10);
    expect(updateSettingsMock).toHaveBeenCalledWith('tenant-A', {
      enabled: true,
      channel: 'sms',
      scale: 10,
      minDurationSeconds: 60,
      smsTemplate: 'How was your call?',
    });
  });

  it('rejects out-of-range scale before touching the DB', async () => {
    const app = await buildApp();
    const res = await request(app).patch('/csat/settings').send({ scale: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scale/i);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('rejects an SMS template longer than 320 chars', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/csat/settings')
      .send({ smsTemplate: 'x'.repeat(321) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/320/);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown channel value', async () => {
    const app = await buildApp();
    const res = await request(app).patch('/csat/settings').send({ channel: 'pigeon' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channel/i);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('rejects a managers-but-not-owner caller with 403', async () => {
    currentUser = { ...currentUser, role: 'operations_manager' };
    const app = await buildApp();
    const res = await request(app).patch('/csat/settings').send({ enabled: true });
    expect(res.status).toBe(403);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});

describe('GET /csat/responses/recent', () => {
  it('returns mapped response rows with limit applied', async () => {
    listResponsesMock.mockResolvedValueOnce([
      {
        id: 'csat-1',
        tenantId: 'tenant-A',
        callSessionId: 'call-1',
        requestChannel: 'sms',
        responseChannel: 'sms',
        status: 'responded',
        scoreScale: 5,
        scoreRaw: 4,
        scoreNormalized: 0.75,
        comment: 'Great call',
        rawResponse: '4 great call',  // expected to be DROPPED in the API shape
        dispatchTo: '+15551234567',  // also dropped — sensitive
        dispatchToken: null,
        requestedAt: new Date('2026-04-29T00:00:00Z'),
        respondedAt: new Date('2026-04-29T00:01:00Z'),
        expiresAt: new Date('2026-05-06T00:00:00Z'),
      },
    ]);
    const app = await buildApp();
    const res = await request(app).get('/csat/responses/recent?limit=5');
    expect(res.status).toBe(200);
    expect(listResponsesMock).toHaveBeenCalledWith('tenant-A', 5);
    expect(res.body.responses).toHaveLength(1);
    const row = res.body.responses[0];
    expect(row.id).toBe('csat-1');
    expect(row.callSessionId).toBe('call-1');
    expect(row.scoreRaw).toBe(4);
    expect(row.scoreNormalized).toBe(0.75);
    expect(row.comment).toBe('Great call');
    // Sensitive fields must NOT leak to the UI.
    expect(row.rawResponse).toBeUndefined();
    expect(row.dispatchTo).toBeUndefined();
    expect(row.dispatchToken).toBeUndefined();
  });

  it('uses the default limit of 20 when no limit param is supplied', async () => {
    listResponsesMock.mockResolvedValueOnce([]);
    const app = await buildApp();
    const res = await request(app).get('/csat/responses/recent');
    expect(res.status).toBe(200);
    expect(listResponsesMock).toHaveBeenCalledWith('tenant-A', 20);
    expect(res.body.responses).toEqual([]);
  });

  it('rejects non-numeric / out-of-range limits with 400', async () => {
    const app = await buildApp();
    const res = await request(app).get('/csat/responses/recent?limit=999');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/);
    expect(listResponsesMock).not.toHaveBeenCalled();
  });
});
