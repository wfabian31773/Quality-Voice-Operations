import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: true },
  queryMock: vi.fn(),
  raiseAlertMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.queryMock }) }));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../platform/analytics/demoAnalyticsAlert', () => ({ raiseDemoAnalyticsWriteFailureAlert: a.raiseAlertMock }));

import router, { recordDemoAnalyticsEvent } from './demo';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.raiseAlertMock.mockReset().mockResolvedValue(undefined);
});

describe('GET /demo/activity', () => {
  it('maps raw event types to public buckets', async () => {
    a.queryMock.mockResolvedValue({ rows: [
      { id: 'e1', event_type: 'CALL_RECEIVED', agent_name: 'Bot', duration_seconds: null, occurred_at: 'now' },
      { id: 'e2', event_type: 'call_completed', agent_name: 'Bot', duration_seconds: 42, occurred_at: 'now' },
    ] });
    const res = await request(app()).get('/demo/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0].eventType).toBe('call_started');
    expect(res.body.events[1].eventType).toBe('call_ended');
    expect(res.body.events[1].durationSeconds).toBe(42);
  });
  it('500 on failure', async () => {
    a.queryMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/demo/activity')).status).toBe(500);
  });
});

describe('GET /demo/stats', () => {
  it('returns the max of demo_call_count and session count', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('demo_call_count')) return { rows: [{ demo_call_count: 5 }] };
      if (sql.includes('COUNT(*) AS count')) return { rows: [{ count: '9' }] };
      return { rows: [] };
    });
    expect((await request(app()).get('/demo/stats')).body).toEqual({ totalCalls: 9 });
  });
});

describe('GET /demo/phones', () => {
  it('returns not-configured when the demo tenant is absent', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/demo/phones')).body).toMatchObject({ configured: false });
  });
  it('returns phones and flags placeholders', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants WHERE id = $1 AND is_demo')) return { rows: [{ id: 'demo' }] };
      if (sql.includes('FROM phone_numbers pn')) return { rows: [
        { phone_number: '+15551230000', friendly_name: 'Placeholder', agent_template: 'dental' },
        { phone_number: '+14155550000', friendly_name: 'Real', agent_template: 'legal' },
      ] };
      return { rows: [] };
    });
    const res = await request(app()).get('/demo/phones');
    expect(res.body.phones).toHaveLength(2);
    expect(res.body.phones[0].isPlaceholder).toBe(true);
  });
});

describe('GET /demo/agents', () => {
  it('returns not-configured when demo tenant absent', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/demo/agents')).body.agents).toEqual([]);
  });
  it('returns agents enriched with template metadata', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants WHERE id = $1 AND is_demo')) return { rows: [{ id: 'demo' }] };
      if (sql.includes('FROM demo_agents da')) return { rows: [
        { id: 'd1', name: 'Dental Bot', description: 'd', agent_template: 'dental', voice_id: 'v', is_active: true, phone_number: '+14155550000' },
      ] };
      return { rows: [] };
    });
    const res = await request(app()).get('/demo/agents');
    expect(res.body.agents[0]).toMatchObject({ type: 'dental', category: 'Healthcare', icon: 'calendar' });
  });
});

describe('POST /demo/track-cta', () => {
  it('requires a ctaType', async () => {
    expect((await request(app()).post('/demo/track-cta').send({})).status).toBe(400);
  });
  it('rejects an invalid ctaType', async () => {
    expect((await request(app()).post('/demo/track-cta').send({ ctaType: 'spam' })).status).toBe(400);
  });
  it('records a valid CTA click', async () => {
    const res = await request(app()).post('/demo/track-cta').send({ ctaType: 'book_demo', agentType: 'dental' });
    expect(res.body).toEqual({ ok: true });
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO demo_analytics'))).toBe(true);
  });
});

describe('GET /demo/analytics (platform admin)', () => {
  it('computes today rates and CTA breakdown', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FILTER (WHERE event_type')) return { rows: [{ calls_started: '10', calls_completed: '6', calls_abandoned: '2', cta_clicks: '5' }] };
      if (sql.includes('GROUP BY cta_type')) return { rows: [{ cta_type: 'book_demo', count: '3' }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/demo/analytics');
    expect(res.status).toBe(200);
    expect(res.body.today).toMatchObject({ callsStarted: 10, completionRate: 75, ctaClickRate: 50 });
    expect(res.body.today.ctaBreakdown).toEqual([{ type: 'book_demo', count: 3 }]);
  });
  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/demo/analytics')).status).toBe(403);
  });
});

describe('recordDemoAnalyticsEvent (exported helper)', () => {
  it('inserts an analytics row', async () => {
    await recordDemoAnalyticsEvent('call_started', 'iphash', 'dental');
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO demo_analytics'))).toBe(true);
  });
  it('raises a write-failure alert when the insert fails', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    await recordDemoAnalyticsEvent('cta_clicked', 'iphash', 'dental', undefined, 'book_demo');
    expect(a.raiseAlertMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'cta_clicked' }));
  });
});
