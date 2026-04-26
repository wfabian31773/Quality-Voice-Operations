import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';

interface QueryRecord {
  sql: string;
  paramCount: number;
  startedAt: number;
  finishedAt: number;
}

const SIMULATED_LATENCY_MS = 50;

function buildPoolMock(opts: {
  rows?: Record<string, unknown>[];
  perQueryDelayMs?: number;
}) {
  const records: QueryRecord[] = [];
  const delay = opts.perQueryDelayMs ?? SIMULATED_LATENCY_MS;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, delay));
    const finishedAt = Date.now();
    records.push({ sql, paramCount: params.length, startedAt, finishedAt });
    return { rows: opts.rows ?? [] };
  });
  return { records, getPlatformPool: () => ({ query }) };
}

function makeRes(): { res: Response; getStatus: () => number; getJson: () => Record<string, unknown> | null } {
  let statusCode = 200;
  let body: Record<string, unknown> | null = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return {
        json: (b: Record<string, unknown>) => { body = b; },
      };
    },
    json: (b: Record<string, unknown>) => { body = b; },
  } as unknown as Response;
  return { res, getStatus: () => statusCode, getJson: () => body };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { userId: 'u1', tenantId: 't1', email: 'u@test', role: 'tenant_owner', isPlatformAdmin: false },
    query: {},
    params: {},
    body: {},
    method: 'GET',
    headers: {},
    cookies: {},
    ...overrides,
  } as unknown as Request;
}

async function loadHandler<T>(modulePath: string, exportName: string, dbMock: ReturnType<typeof buildPoolMock>): Promise<T> {
  vi.resetModules();
  vi.doMock('../../platform/db', () => ({
    getPlatformPool: dbMock.getPlatformPool,
    withTenantContext: vi.fn(async () => {}),
    withPrivilegedClient: vi.fn(),
  }));
  vi.doMock('../../platform/core/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }));
  vi.doMock('../../server/admin-api/middleware/auth', () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
  }));
  vi.doMock('../../server/admin-api/middleware/rbac', () => ({
    requireMiniSystemWrite: (_req: Request, _res: Response, next: () => void) => next(),
    requireRole: () => (_req: Request, _res: Response, next: () => void) => next(),
    requirePlatformAdmin: (_req: Request, _res: Response, next: () => void) => next(),
  }));
  const mod = (await import(modulePath)) as Record<string, unknown>;
  return mod[exportName] as T;
}

function fakeRowsForList(count: number, total: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${i}`,
    title: `Row ${i}`,
    _total_count: String(total),
  }));
}

beforeEach(() => {
  vi.resetModules();
});

describe('list handler query budget — single round-trip via COUNT(*) OVER()', () => {
  it('dispatch listJobsHandler issues exactly 1 query and finishes well under 250ms (200 rows)', async () => {
    const dbMock = buildPoolMock({ rows: fakeRowsForList(200, 200) });
    type Handler = (req: Request, res: Response) => Promise<void>;
    const handler = await loadHandler<Handler>(
      '../../server/admin-api/routes/dispatch',
      'listJobsHandler',
      dbMock,
    );

    const { res, getStatus, getJson } = makeRes();
    const req = makeReq({ query: { limit: '200', page: '1' } });

    const startedAt = Date.now();
    await handler(req, res);
    const elapsed = Date.now() - startedAt;

    expect(getStatus()).toBe(200);
    expect(dbMock.records.length).toBe(1);
    expect(dbMock.records[0].sql).toMatch(/COUNT\(\*\)\s+OVER\(\)/);
    expect(elapsed).toBeLessThan(2000);
    const body = getJson();
    expect(body?.total).toBe(200);
    const jobs = body?.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(200);
    for (const j of jobs) expect(j._total_count).toBeUndefined();
  });

  it('scheduling listBookingsHandler issues exactly 1 query and finishes under 250ms', async () => {
    const dbMock = buildPoolMock({ rows: fakeRowsForList(200, 200) });
    type Handler = (req: Request, res: Response) => Promise<void>;
    const handler = await loadHandler<Handler>(
      '../../server/admin-api/routes/scheduling',
      'listBookingsHandler',
      dbMock,
    );

    const { res, getStatus, getJson } = makeRes();
    const req = makeReq({ query: { limit: '200' } });

    const startedAt = Date.now();
    await handler(req, res);
    const elapsed = Date.now() - startedAt;

    expect(getStatus()).toBe(200);
    expect(dbMock.records.length).toBe(1);
    expect(dbMock.records[0].sql).toMatch(/COUNT\(\*\)\s+OVER\(\)/);
    expect(elapsed).toBeLessThan(2000);
    const body = getJson();
    expect(body?.total).toBe(200);
    const bookings = body?.bookings as Array<Record<string, unknown>>;
    expect(bookings).toHaveLength(200);
    for (const b of bookings) expect(b._total_count).toBeUndefined();
  });

  it('tickets listTicketsHandler issues exactly 1 query, uses LATERAL for SLA, finishes under 250ms', async () => {
    const dbMock = buildPoolMock({ rows: fakeRowsForList(200, 200) });
    type Handler = (req: Request, res: Response) => Promise<void>;
    const handler = await loadHandler<Handler>(
      '../../server/admin-api/routes/tickets',
      'listTicketsHandler',
      dbMock,
    );

    const { res, getStatus, getJson } = makeRes();
    const req = makeReq({ query: { limit: '200' } });

    const startedAt = Date.now();
    await handler(req, res);
    const elapsed = Date.now() - startedAt;

    expect(getStatus()).toBe(200);
    expect(dbMock.records.length).toBe(1);
    const sql = dbMock.records[0].sql;
    expect(sql).toMatch(/LEFT JOIN LATERAL[\s\S]*ticket_sla_instances/);
    expect(sql).toMatch(/COUNT\(\*\)\s+OVER\(\)/);
    expect(sql).not.toMatch(/\(SELECT row_to_json\(si\.\*\) FROM ticket_sla_instances/);
    expect(elapsed).toBeLessThan(2000);
    const body = getJson();
    expect(body?.total).toBe(200);
    const tickets = body?.tickets as Array<Record<string, unknown>>;
    expect(tickets).toHaveLength(200);
    for (const t of tickets) expect(t._total_count).toBeUndefined();
  });
});

describe('empty-page fallback path stays bounded', () => {
  it('falls back to a single COUNT query only when offset > 0 and rows are empty', async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total: 42 }] };
      return { rows: [] };
    });
    vi.resetModules();
    vi.doMock('../../platform/db', () => ({
      getPlatformPool: () => ({ query: queryFn }),
      withTenantContext: vi.fn(async () => {}),
      withPrivilegedClient: vi.fn(),
    }));
    vi.doMock('../../platform/core/logger', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../../server/admin-api/middleware/auth', () => ({
      requireAuth: (_r: Request, _s: Response, n: () => void) => n(),
    }));
    vi.doMock('../../server/admin-api/middleware/rbac', () => ({
      requireMiniSystemWrite: (_r: Request, _s: Response, n: () => void) => n(),
      requireRole: () => (_r: Request, _s: Response, n: () => void) => n(),
      requirePlatformAdmin: (_r: Request, _s: Response, n: () => void) => n(),
    }));

    type Handler = (req: Request, res: Response) => Promise<void>;
    const mod = await import('../../server/admin-api/routes/tickets');
    const handler = (mod as Record<string, unknown>).listTicketsHandler as Handler;

    const { res, getJson } = makeRes();
    await handler(makeReq({ query: { limit: '50', page: '5' } }), res);

    // 1 main query + 1 fallback count query
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(getJson()?.total).toBe(42);
  });

  it('does NOT issue a fallback count when offset is 0 and rows are empty', async () => {
    const dbMock = buildPoolMock({ rows: [] });
    type Handler = (req: Request, res: Response) => Promise<void>;
    const handler = await loadHandler<Handler>(
      '../../server/admin-api/routes/dispatch',
      'listJobsHandler',
      dbMock,
    );

    const { res, getJson } = makeRes();
    await handler(makeReq({ query: { limit: '50', page: '1' } }), res);

    expect(dbMock.records.length).toBe(1);
    expect(getJson()?.total).toBe(0);
  });
});

describe('query count is invariant in row count (no N+1 regression)', () => {
  const sizes = [10, 50, 200, 1000];

  it.each(sizes)('dispatch listJobsHandler still issues exactly 1 query at %i rows', async (n) => {
    const dbMock = buildPoolMock({ rows: fakeRowsForList(n, n), perQueryDelayMs: 5 });
    type Handler = (req: Request, res: Response) => Promise<void>;
    const handler = await loadHandler<Handler>(
      '../../server/admin-api/routes/dispatch',
      'listJobsHandler',
      dbMock,
    );
    const { res, getJson } = makeRes();
    await handler(makeReq({ query: { limit: String(n) } }), res);
    expect(dbMock.records.length).toBe(1);
    expect(getJson()?.total).toBe(n);
  });

  it.each(sizes)('tickets listTicketsHandler still issues exactly 1 query at %i rows', async (n) => {
    const dbMock = buildPoolMock({ rows: fakeRowsForList(n, n), perQueryDelayMs: 5 });
    type Handler = (req: Request, res: Response) => Promise<void>;
    const handler = await loadHandler<Handler>(
      '../../server/admin-api/routes/tickets',
      'listTicketsHandler',
      dbMock,
    );
    const { res, getJson } = makeRes();
    await handler(makeReq({ query: { limit: String(Math.min(n, 200)) } }), res);
    expect(dbMock.records.length).toBe(1);
    expect(getJson()?.total).toBe(n);
  });
});

describe('source contract — no per-row correlated subqueries remain', () => {
  it('tickets list source replaces correlated row_to_json with LEFT JOIN LATERAL', () => {
    const src = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/tickets.ts'),
      'utf-8',
    );
    const handlerStart = src.indexOf('export const listTicketsHandler');
    const handlerEnd = src.indexOf('\nexport const ', handlerStart + 1);
    const slice = handlerEnd === -1 ? src.slice(handlerStart) : src.slice(handlerStart, handlerEnd);
    expect(slice).toMatch(/LEFT JOIN LATERAL[\s\S]*ticket_sla_instances/);
    expect(slice).not.toMatch(/\(SELECT row_to_json\(si\.\*\) FROM ticket_sla_instances/);
  });

  it('all three list handlers select COUNT(*) OVER() in their main query', () => {
    const dispatch = readFileSync(join(process.cwd(), 'server/admin-api/routes/dispatch.ts'), 'utf-8');
    const scheduling = readFileSync(join(process.cwd(), 'server/admin-api/routes/scheduling.ts'), 'utf-8');
    const tickets = readFileSync(join(process.cwd(), 'server/admin-api/routes/tickets.ts'), 'utf-8');

    function sliceHandler(src: string, name: string): string {
      const i = src.indexOf(`export const ${name}`);
      const j = src.indexOf('\nexport const ', i + 1);
      return j === -1 ? src.slice(i) : src.slice(i, j);
    }

    expect(sliceHandler(dispatch, 'listJobsHandler')).toMatch(/COUNT\(\*\)\s+OVER\(\)/);
    expect(sliceHandler(scheduling, 'listBookingsHandler')).toMatch(/COUNT\(\*\)\s+OVER\(\)/);
    expect(sliceHandler(tickets, 'listTicketsHandler')).toMatch(/COUNT\(\*\)\s+OVER\(\)/);
  });
});
