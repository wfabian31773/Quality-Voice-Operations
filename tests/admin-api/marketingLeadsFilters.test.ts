/**
 * Unit coverage for the per-author and stale-lead filters added to the Sales
 * Inbox. We mount the marketing-leads service against a mocked platform pool
 * and assert that the SQL `listLeads` builds for the new filters:
 *
 *   - `actedOnBy`     -> emits an `EXISTS` subquery against
 *                        `marketing_lead_events` with a case-insensitive LIKE
 *                        on `author`, parameterised (no string interpolation).
 *   - `inactiveForDays` -> emits a `NOT EXISTS` subquery using
 *                        `make_interval(days => $N::int)` so leads with no
 *                        recent activity (or no activity at all) bubble up.
 *
 * We also verify the new `listLeadEventAuthors` helper that powers the
 * frontend dropdown, and the distinct-authors query used by
 * `/platform/marketing-lead-authors`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/messaging/SlackWebhookNotifier', () => ({
  postToOpsSlackWebhook: vi.fn(),
  getOpsSlackWebhookUrl: vi.fn(() => null),
}));

vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('../services/sales-alert-settings', () => ({
  getSalesAlertSettings: vi.fn(),
  getSalesInboxDeepLink: vi.fn(),
}));

import {
  listLeads,
  listLeadEventAuthors,
} from '../../server/admin-api/services/marketing-leads';

beforeEach(() => {
  queryMock.mockReset();
  // First call from ensureTable() in each entrypoint — return ok.
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

function captureSql(): string[] {
  return queryMock.mock.calls.map((c) => String(c[0]));
}
function captureParams(): unknown[][] {
  return queryMock.mock.calls.map((c) => (c[1] as unknown[]) ?? []);
}

describe('marketing-leads listLeads filters', () => {
  it('omits actedOnBy/inactiveForDays clauses when filters are not set', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await listLeads({});
    // The list query itself unconditionally LEFT JOINs marketing_lead_events
    // (via a LATERAL) to populate the per-lead "Owners" column, so we
    // intentionally don't blanket-ban that table name here. Instead, assert
    // that the *filter* clauses (EXISTS over author, NOT EXISTS with
    // make_interval) are absent when no per-author / inactivity filters were
    // supplied.
    const runtimeSql = captureSql().filter(
      (s) => s.includes('FROM marketing_leads') && !s.includes('CREATE TABLE'),
    );
    expect(runtimeSql.length).toBeGreaterThan(0);
    for (const s of runtimeSql) {
      expect(s).not.toMatch(/LOWER\(e\.author\)/);
      expect(s).not.toMatch(/make_interval/);
      expect(s).not.toMatch(/NOT\s+EXISTS/i);
    }
  });

  it('emits an EXISTS subquery with a parameterised LIKE for actedOnBy', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await listLeads({ actedOnBy: 'alice@acme.io' });

    const params = captureParams();
    const listSql = captureSql().find((s) => s.includes('FROM marketing_leads')) ?? '';
    const listParams = params.find((p) => p.some((v) => typeof v === 'string' && (v as string).includes('alice'))) ?? [];

    // The filter joins to the events table via a correlated EXISTS.
    expect(listSql).toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+marketing_lead_events\s+e/i);
    expect(listSql).toMatch(/LOWER\(e\.author\)\s+LIKE\s+LOWER\(\$\d+\)/i);

    // The actual term must be wrapped with %…% wildcards and never inlined.
    expect(listParams).toContain('%alice@acme.io%');
  });

  it('emits a NOT EXISTS subquery with make_interval for inactiveForDays', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await listLeads({ inactiveForDays: 7 });

    const params = captureParams();
    const listSql = captureSql().find((s) => s.includes('FROM marketing_leads')) ?? '';
    const listParams = params.find((p) => p.some((v) => v === 7)) ?? [];

    expect(listSql).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+marketing_lead_events\s+e/i);
    expect(listSql).toMatch(/make_interval\(days\s*=>\s*\$\d+::int\)/i);
    expect(listParams).toContain(7);
  });

  it('ignores actedOnBy when blank and inactiveForDays when non-positive', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await listLeads({ actedOnBy: '   ', inactiveForDays: 0 });
    const sql = captureSql().join('\n');
    // The list query still references marketing_lead_events for the LATERAL
    // aggregate, so we instead assert the *filter* fragments are absent.
    expect(sql).not.toMatch(/LOWER\(e\.author\)/);
    expect(sql).not.toMatch(/make_interval/);
  });

  it('combines new filters with the existing source / status WHERE clause', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await listLeads({
      source: 'book_demo',
      status: 'new',
      actedOnBy: 'bob',
      inactiveForDays: 14,
    });
    const listSql = captureSql().find((s) => s.includes('FROM marketing_leads')) ?? '';
    expect(listSql).toMatch(/source = \$\d+/);
    expect(listSql).toMatch(/status = \$\d+/);
    expect(listSql).toMatch(/EXISTS/);
    expect(listSql).toMatch(/NOT EXISTS/);
  });

  it('aggregates per-lead authors and last-activity in a single LEFT JOIN LATERAL', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await listLeads({});
    const listSql =
      captureSql().find((s) => s.includes('FROM marketing_leads') && s.includes('LATERAL')) ?? '';
    // Single LEFT JOIN LATERAL covers authors + last activity — no N+1.
    expect(listSql).toMatch(/LEFT\s+JOIN\s+LATERAL/i);
    expect(listSql).toMatch(/event_authors/);
    expect(listSql).toMatch(/last_event_at/);
    expect(listSql).toMatch(/last_event_author/);
    // The list query should only contain a single FROM marketing_leads in the
    // outer query (the LATERAL's nested subqueries SELECT FROM
    // marketing_lead_events, not marketing_leads, so they don't count).
    const outerFromCount = (listSql.match(/FROM\s+marketing_leads\b/gi) ?? []).length;
    expect(outerFromCount).toBe(1);
  });

  it('maps event_authors / last_event_at / last_event_author from the row', async () => {
    queryMock.mockReset();
    // The first listLeads() call in this suite already ran ensureTable() and
    // flipped its module-level `tableEnsured` flag, so subsequent invocations
    // skip the DDL query. We dispatch mocks based on the SQL each call sees
    // rather than positionally to avoid coupling to that side-effect.
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('CREATE TABLE')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes('FROM marketing_leads') && sql.includes('LATERAL')) {
        return Promise.resolve({
          rows: [
            {
              id: 1,
              source: 'book_demo',
              name: 'Acme',
              email: 'lead@acme.io',
              company: 'Acme',
              phone: null,
              payload: {},
              notified: false,
              status: 'new',
              status_notes: null,
              status_updated_at: null,
              status_updated_by: null,
              created_at: '2024-01-01T00:00:00.000Z',
              event_authors: ['alice@acme.io', 'bob@acme.io'],
              last_event_at: '2024-02-03T04:05:06.000Z',
              last_event_author: 'bob@acme.io',
            },
          ],
          rowCount: 1,
        });
      }
      if (sql.includes('COUNT(*)::int AS total') && !sql.includes('FILTER')) {
        return Promise.resolve({ rows: [{ total: 1 }], rowCount: 1 });
      }
      // Summary aggregate.
      return Promise.resolve({ rows: [{}], rowCount: 1 });
    });

    const out = await listLeads({});
    expect(out.leads[0].event_authors).toEqual(['alice@acme.io', 'bob@acme.io']);
    expect(out.leads[0].last_event_at).toBe('2024-02-03T04:05:06.000Z');
    expect(out.leads[0].last_event_author).toBe('bob@acme.io');
  });

  it('defaults to ORDER BY created_at DESC and switches to last_activity when requested', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await listLeads({});
    const defaultSql = captureSql().find((s) => s.includes('ORDER BY')) ?? '';
    expect(defaultSql).toMatch(/ORDER BY marketing_leads\.created_at DESC/i);

    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await listLeads({ sort: 'last_activity', order: 'asc' });
    const lastActivitySql = captureSql().find((s) => s.includes('ORDER BY')) ?? '';
    expect(lastActivitySql).toMatch(
      /ORDER BY COALESCE\(agg\.last_event_at, marketing_leads\.created_at\) ASC/i,
    );
  });
});

describe('listLeadEventAuthors', () => {
  it('queries distinct, non-empty authors and excludes auto-generated created events', async () => {
    queryMock.mockResolvedValue({
      rows: [{ author: 'alice@acme.io' }, { author: 'bob@acme.io' }],
      rowCount: 2,
    });
    const authors = await listLeadEventAuthors();
    expect(authors).toEqual(['alice@acme.io', 'bob@acme.io']);

    const distinctSql = captureSql().find((s) => s.includes('DISTINCT author')) ?? '';
    expect(distinctSql).toMatch(/FROM marketing_lead_events/);
    expect(distinctSql).toMatch(/author IS NOT NULL/);
    expect(distinctSql).toMatch(/event_type <> 'created'/);
    expect(distinctSql).toMatch(/ORDER BY author ASC/);
  });
});

/**
 * Route-level coverage for the query-param coercion done by `parseLeadFilters`.
 * The Sales Inbox UI is a thin pass-through over the URL, so this helper is
 * the only place we sanitise/clamp the new params before they reach SQL.
 * We exercise the helper directly (it's exported from the route module) to
 * lock in the contract without spinning up the full Express app + mocking
 * every transitive platform import.
 */
import { parseLeadFilters } from '../../server/admin-api/routes/platformAdmin';

describe('parseLeadFilters', () => {
  it('returns safe defaults when the query string is empty', () => {
    const out = parseLeadFilters({});
    expect(out).toEqual({
      source: 'all',
      booking: 'all',
      status: 'all',
      q: undefined,
      actedOnBy: undefined,
      inactiveForDays: undefined,
      sort: 'created_at',
      order: 'desc',
    });
  });

  it('accepts the supported sort fields and order directions', () => {
    expect(parseLeadFilters({ sort: 'last_activity' }).sort).toBe('last_activity');
    expect(parseLeadFilters({ sort: 'created_at' }).sort).toBe('created_at');
    expect(parseLeadFilters({ order: 'asc' }).order).toBe('asc');
    expect(parseLeadFilters({ order: 'DESC' }).order).toBe('desc');
  });

  it('falls back to the default sort/order for unknown values', () => {
    expect(parseLeadFilters({ sort: 'haxxor' }).sort).toBe('created_at');
    expect(parseLeadFilters({ order: 'sideways' }).order).toBe('desc');
    expect(parseLeadFilters({ sort: '', order: '' }).sort).toBe('created_at');
  });

  it('trims actedOnBy and treats whitespace-only as missing', () => {
    expect(parseLeadFilters({ actedOnBy: '  alice@acme.io  ' }).actedOnBy).toBe('alice@acme.io');
    expect(parseLeadFilters({ actedOnBy: '   ' }).actedOnBy).toBeUndefined();
    expect(parseLeadFilters({ actedOnBy: '' }).actedOnBy).toBeUndefined();
    // Non-string values (e.g. arrays from repeated query params) are ignored.
    expect(parseLeadFilters({ actedOnBy: ['alice', 'bob'] as unknown as string }).actedOnBy).toBeUndefined();
  });

  it('coerces inactiveDays to a positive integer and rejects garbage', () => {
    expect(parseLeadFilters({ inactiveDays: '7' }).inactiveForDays).toBe(7);
    expect(parseLeadFilters({ inactiveDays: 14 }).inactiveForDays).toBe(14);
    expect(parseLeadFilters({ inactiveDays: '0' }).inactiveForDays).toBeUndefined();
    expect(parseLeadFilters({ inactiveDays: '-3' }).inactiveForDays).toBeUndefined();
    expect(parseLeadFilters({ inactiveDays: 'abc' }).inactiveForDays).toBeUndefined();
    expect(parseLeadFilters({ inactiveDays: '' }).inactiveForDays).toBeUndefined();
    expect(parseLeadFilters({ inactiveDays: null }).inactiveForDays).toBeUndefined();
    expect(parseLeadFilters({ inactiveDays: undefined }).inactiveForDays).toBeUndefined();
  });

  it('clamps inactiveDays at the ~10y cap to keep make_interval bounded', () => {
    expect(parseLeadFilters({ inactiveDays: '99999' }).inactiveForDays).toBe(3650);
    expect(parseLeadFilters({ inactiveDays: '3650' }).inactiveForDays).toBe(3650);
    expect(parseLeadFilters({ inactiveDays: '3649' }).inactiveForDays).toBe(3649);
  });

  it('drops unknown source / booking / status values back to "all"', () => {
    const out = parseLeadFilters({
      source: 'haxxor',
      booking: 'pwn',
      status: '; DROP TABLE leads;--',
    });
    expect(out.source).toBe('all');
    expect(out.booking).toBe('all');
    expect(out.status).toBe('all');
  });

  it('preserves valid source / booking / status values verbatim', () => {
    const out = parseLeadFilters({
      source: 'book_demo',
      booking: 'booked',
      status: 'new',
      q: '  acme  ',
    });
    expect(out.source).toBe('book_demo');
    expect(out.booking).toBe('booked');
    expect(out.status).toBe('new');
    expect(out.q).toBe('acme');
  });
});
