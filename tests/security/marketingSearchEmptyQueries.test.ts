/**
 * Behavioral tests for the marketing-page zero-hit search analytics route.
 *
 * Coverage:
 *   - POST /marketing/search/empty validates `query`, `locale`, and
 *     `source` and rejects unknown sources (defense against misuse from a
 *     forged client).
 *   - Inserts use the *normalized* query (lowercased, whitespace folded)
 *     for grouping, while preserving the raw query for admin inspection.
 *   - DB failures are swallowed so telemetry can't break the search UX.
 *   - GET /marketing/search/empty/summary requires platform-admin auth:
 *       * unauthenticated requests get 401
 *       * authenticated non-admin requests get 403
 *       * platform admins receive aggregated rows + locale_totals
 *   - The summary endpoint applies the source/locale filters to BOTH
 *     the per-query rows and the per-locale header totals so the two
 *     can never disagree.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbState = vi.hoisted(() => ({
  inserts: [] as Array<{
    queryNormalized: string;
    queryRaw: string;
    locale: string;
    source: string;
    pagePath: string | null;
  }>,
  failNextInsert: false,
  rowsResponse: [] as unknown[],
  localeTotalsResponse: [] as unknown[],
  // Captured per-query parameters from the most recent summary call.
  lastRowsParams: null as unknown[] | null,
  lastLocaleTotalsParams: null as unknown[] | null,
  lastRowsSql: '' as string,
  lastLocaleTotalsSql: '' as string,
}));

vi.mock('../../platform/db', () => {
  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('INSERT INTO marketing_search_empty_queries')) {
      if (dbState.failNextInsert) {
        dbState.failNextInsert = false;
        throw new Error('simulated db failure');
      }
      const [queryNormalized, queryRaw, locale, source, pagePath] =
        params as [string, string, string, string, string | null];
      dbState.inserts.push({ queryNormalized, queryRaw, locale, source, pagePath });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT query_normalized,')) {
      dbState.lastRowsSql = text;
      dbState.lastRowsParams = params;
      return { rows: dbState.rowsResponse, rowCount: dbState.rowsResponse.length };
    }
    if (text.startsWith('SELECT locale, COUNT(*)::int AS total')) {
      dbState.lastLocaleTotalsSql = text;
      dbState.lastLocaleTotalsParams = params;
      return {
        rows: dbState.localeTotalsResponse,
        rowCount: dbState.localeTotalsResponse.length,
      };
    }
    throw new Error(`Unexpected query in test mock: ${text}`);
  };
  return { getPlatformPool: () => ({ query }) };
});

// `requireAuth` and `requirePlatformAdmin` are mocked with thin shims that
// honor an x-test-user header so each test can simulate a different
// caller (anonymous / regular user / platform admin) without dragging in
// real JWT verification.
vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (
    req: { headers: Record<string, string | undefined>; user?: unknown },
    res: { status: (s: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    const header = req.headers['x-test-user'];
    if (!header) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (header === 'admin') {
      req.user = { isPlatformAdmin: true };
    } else {
      req.user = { isPlatformAdmin: false };
    }
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requirePlatformAdmin: (
    req: { user?: { isPlatformAdmin?: boolean } },
    res: { status: (s: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!req.user.isPlatformAdmin) {
      res.status(403).json({ error: 'Platform admin access required' });
      return;
    }
    next();
  },
}));

async function buildApp() {
  const router = (
    await import('../../server/admin-api/routes/marketingSearchAnalytics')
  ).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('POST /marketing/search/empty', () => {
  beforeEach(() => {
    dbState.inserts.length = 0;
    dbState.failNextInsert = false;
  });

  it('inserts a normalized + raw row when the body is valid', async () => {
    const app = await buildApp();
    const r = await request(app)
      .post('/marketing/search/empty')
      .send({
        query: '  Precios  Mensuales  ',
        locale: 'es',
        source: 'help_widget',
        page_path: '/pricing',
      });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]).toMatchObject({
      // Trim + collapse whitespace + lowercase for grouping.
      queryNormalized: 'precios mensuales',
      // Raw is preserved as the user typed it (only outer trim is logical
      // — the route stores up to MAX_QUERY_RAW_LEN of the original bytes).
      queryRaw: '  Precios  Mensuales  ',
      locale: 'es',
      source: 'help_widget',
      pagePath: '/pricing',
    });
  });

  it('rejects unknown sources to prevent forged-client misuse', async () => {
    const app = await buildApp();
    const r = await request(app)
      .post('/marketing/search/empty')
      .send({ query: 'precios', locale: 'es', source: 'attacker-source' });

    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid source' });
    expect(dbState.inserts).toHaveLength(0);
  });

  it('rejects missing locale', async () => {
    const app = await buildApp();
    const r = await request(app)
      .post('/marketing/search/empty')
      .send({ query: 'precios', source: 'help_widget' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'locale is required' });
  });

  it('rejects empty / oversized query', async () => {
    const app = await buildApp();
    const r1 = await request(app)
      .post('/marketing/search/empty')
      .send({ query: '', locale: 'es', source: 'help_widget' });
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .post('/marketing/search/empty')
      .send({ query: 'x'.repeat(513), locale: 'es', source: 'help_widget' });
    expect(r2.status).toBe(400);
  });

  it('returns success even when the DB insert fails (telemetry must not break search)', async () => {
    dbState.failNextInsert = true;
    const app = await buildApp();
    const r = await request(app)
      .post('/marketing/search/empty')
      .send({ query: 'precios', locale: 'es', source: 'help_widget' });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect(dbState.inserts).toHaveLength(0);
  });
});

describe('GET /marketing/search/empty/summary', () => {
  beforeEach(() => {
    dbState.rowsResponse = [];
    dbState.localeTotalsResponse = [];
    dbState.lastRowsParams = null;
    dbState.lastLocaleTotalsParams = null;
    dbState.lastRowsSql = '';
    dbState.lastLocaleTotalsSql = '';
  });

  it('rejects unauthenticated callers with 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/marketing/search/empty/summary');
    expect(r.status).toBe(401);
    expect(dbState.lastRowsParams).toBeNull();
  });

  it('rejects authenticated non-admin callers with 403', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get('/marketing/search/empty/summary')
      .set('x-test-user', 'regular');
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Platform admin access required' });
    expect(dbState.lastRowsParams).toBeNull();
  });

  it('returns aggregated rows + locale_totals for platform admins', async () => {
    dbState.rowsResponse = [
      {
        query_normalized: 'precios mensuales',
        query_raw_sample: 'Precios Mensuales',
        locale: 'es',
        source: 'help_widget',
        hit_count: 7,
        last_seen_at: '2026-04-30T12:00:00Z',
        first_seen_at: '2026-04-25T08:00:00Z',
        distinct_page_paths: 2,
      },
    ];
    dbState.localeTotalsResponse = [
      { locale: 'es', total: 12 },
      { locale: 'pt-BR', total: 4 },
    ];

    const app = await buildApp();
    const r = await request(app)
      .get('/marketing/search/empty/summary')
      .set('x-test-user', 'admin');

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      days: 30,
      rows: dbState.rowsResponse,
      locale_totals: dbState.localeTotalsResponse,
    });
  });

  it('threads source/locale filters through BOTH the rows query and locale_totals', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get('/marketing/search/empty/summary')
      .query({ days: '7', source: 'help_widget', locale: 'es', limit: '50' })
      .set('x-test-user', 'admin');
    expect(r.status).toBe(200);

    // The rows query receives [days, locale, source, limit].
    expect(dbState.lastRowsParams).toEqual([7, 'es', 'help_widget', 50]);
    // The locale_totals query gets the SAME filters but without LIMIT —
    // this is what keeps the header totals consistent with the filtered
    // table the admin is looking at.
    expect(dbState.lastLocaleTotalsParams).toEqual([7, 'es', 'help_widget']);
    // And the WHERE clause in the totals query must include the locale +
    // source filters, not just the time window.
    expect(dbState.lastLocaleTotalsSql).toMatch(/AND locale = \$2/);
    expect(dbState.lastLocaleTotalsSql).toMatch(/AND source = \$3/);
  });

  it('silently drops unknown source filters instead of injecting them', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get('/marketing/search/empty/summary')
      .query({ source: 'attacker-source' })
      .set('x-test-user', 'admin');
    expect(r.status).toBe(200);

    // Only [days, limit] should be present — the bogus source must NOT
    // become a parameter or appear in the WHERE clause.
    expect(dbState.lastRowsParams).toEqual([30, 100]);
    expect(dbState.lastRowsSql).not.toMatch(/source =/);
  });
});
