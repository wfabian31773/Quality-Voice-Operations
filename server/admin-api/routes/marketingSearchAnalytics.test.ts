import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.queryMock }) }));

import router, { normalizeQuery } from './marketingSearchAnalytics';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
});

describe('normalizeQuery', () => {
  it('trims, collapses whitespace and lowercases', () => {
    expect(normalizeQuery('  Hello   World  ')).toBe('hello world');
  });
});

describe('POST /marketing/search/empty (public)', () => {
  const valid = { query: 'how to reset', locale: 'en', source: 'help_widget' };

  it('rejects a missing query', async () => {
    expect((await request(app()).post('/marketing/search/empty').send({ locale: 'en', source: 'help_widget' })).status).toBe(400);
  });

  it('rejects an invalid source', async () => {
    expect((await request(app()).post('/marketing/search/empty').send({ ...valid, source: 'bogus' })).status).toBe(400);
  });

  it('no-ops (skipped) on an all-whitespace query that normalizes to empty', async () => {
    const res = await request(app()).post('/marketing/search/empty').send({ ...valid, query: '    ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, skipped: true });
    expect(a.queryMock).not.toHaveBeenCalled();
  });

  it('records a valid empty-query event', async () => {
    const res = await request(app()).post('/marketing/search/empty').send(valid);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(a.queryMock).toHaveBeenCalled();
  });

  it('swallows insert failures and still returns success', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    const res = await request(app()).post('/marketing/search/empty').send(valid);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /marketing/search/empty/summary', () => {
  it('returns aggregated rows + locale totals for a platform admin', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('GROUP BY query_normalized')) return { rows: [{ query_normalized: 'pricing', hit_count: 9 }] };
      if (sql.includes('GROUP BY locale')) return { rows: [{ locale: 'en', total: 9 }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/marketing/search/empty/summary?days=14&locale=en&source=help_widget');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.locale_totals).toEqual([{ locale: 'en', total: 9 }]);
  });

  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/marketing/search/empty/summary')).status).toBe(403);
  });

  it('returns 500 on failure', async () => {
    a.queryMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/marketing/search/empty/summary')).status).toBe(500);
  });
});
