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
    // Only inspect the runtime list / count queries (skip the DDL-only
    // ensureTable() statement, which legitimately mentions the events table).
    const runtimeSql = captureSql().filter(
      (s) => s.includes('FROM marketing_leads') && !s.includes('CREATE TABLE'),
    );
    expect(runtimeSql.length).toBeGreaterThan(0);
    for (const s of runtimeSql) {
      expect(s).not.toMatch(/marketing_lead_events/);
      expect(s).not.toMatch(/make_interval/);
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
    expect(sql).not.toMatch(/marketing_lead_events/);
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
    });
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
