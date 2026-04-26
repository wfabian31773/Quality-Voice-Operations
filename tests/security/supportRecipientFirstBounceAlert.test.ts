import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- Static contract checks -------------------------------------------------
//
// The helper itself is small and well-scoped, but several other call sites
// (the manual /retry endpoint, the background SupportReplyRetryScheduler,
// the BouncedRecipientsPanel) all assume specific contracts about its name,
// dedup table, alert type, and severity. The static checks below pin those
// assumptions down so a rename or accidental severity flip is caught at CI
// time rather than in production.
const helperFile = readFileSync(
  join(process.cwd(), 'platform/help/supportReplyDeliveryAlert.ts'),
  'utf8',
);
const migrationFile = readFileSync(
  join(process.cwd(), 'migrations/074_support_recipient_bounce_alerts.sql'),
  'utf8',
);
const schedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/SupportReplyRetryScheduler.ts'),
  'utf8',
);
const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const adminUiFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);

describe('raiseRecipientFirstBounceAlert — static contract', () => {
  it('exports the helper, input, and result types', () => {
    expect(helperFile).toMatch(/export async function raiseRecipientFirstBounceAlert/);
    expect(helperFile).toMatch(/export interface RecipientFirstBounceInput/);
    expect(helperFile).toMatch(/export interface RecipientFirstBounceResult/);
  });

  it('claims the dedup row atomically via INSERT ... ON CONFLICT DO NOTHING', () => {
    // The atomic claim is the entire deduplication mechanism. If a future
    // refactor drops the ON CONFLICT clause, two concurrent callers (the
    // background scheduler + a manual /retry click on the same address)
    // would both fire the alert. Pin the SQL shape down here.
    expect(helperFile).toMatch(/INSERT INTO support_recipient_bounce_alerts/);
    expect(helperFile).toMatch(/ON CONFLICT \(email_lower\) DO NOTHING/);
    expect(helperFile).toMatch(/RETURNING email_lower/);
  });

  it('writes a critical error_log via the shared logError helper', () => {
    expect(helperFile).toMatch(
      /logError\(\s*tenantId,\s*'critical',\s*message/,
    );
    expect(helperFile).toMatch(/errorCode:\s*'support_recipient_first_bounce'/);
  });

  it('inserts an operations_alerts row of the documented type and severity', () => {
    expect(helperFile).toMatch(/INSERT INTO operations_alerts/);
    expect(helperFile).toMatch(/'support_recipient_first_bounce'/);
    expect(helperFile).toMatch(/'high'/);
  });

  it('skips operations_alerts when the ticket has no tenant (NOT NULL constraint)', () => {
    // operations_alerts.tenant_id is NOT NULL. Anonymous marketing-site
    // tickets must still produce the dedup row + critical error_log; they
    // just can't get the in-product alert feed entry.
    expect(helperFile).toMatch(/if \(!tenantId\)/);
  });

  it('lowercases the recipient address before claiming the dedup row', () => {
    // Mixed-case bounces must not silently re-fire an alert under different
    // casing — same rule as support_email_suppressions.
    expect(helperFile).toMatch(/recipientEmail\.trim\(\)\.toLowerCase\(\)/);
  });

  it('returns { alerted: false } on an empty address (no-op)', () => {
    expect(helperFile).toMatch(/if \(!emailLower\)\s*\{\s*return \{ alerted: false \}/);
  });
});

describe('migration 074 — support_recipient_bounce_alerts schema', () => {
  it('creates the table with email_lower as the primary key', () => {
    expect(migrationFile).toMatch(/CREATE TABLE IF NOT EXISTS support_recipient_bounce_alerts/);
    expect(migrationFile).toMatch(/email_lower\s+TEXT\s+PRIMARY KEY/);
  });

  it('captures the reply, ticket, and tenant attribution for forensics', () => {
    expect(migrationFile).toMatch(/reply_id\s+INTEGER/);
    expect(migrationFile).toMatch(/ticket_id\s+VARCHAR/);
    expect(migrationFile).toMatch(/tenant_id\s+VARCHAR/);
    expect(migrationFile).toMatch(/last_error\s+TEXT/);
  });

  it('stamps first_alerted_at automatically with NOW()', () => {
    expect(migrationFile).toMatch(/first_alerted_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
  });
});

describe('SupportReplyRetryScheduler — wires the recipient alert in', () => {
  it('imports and calls the recipient-first-bounce helper', () => {
    expect(schedulerFile).toMatch(/raiseRecipientFirstBounceAlert/);
  });
});

describe('manual /retry endpoint — wires the recipient alert in', () => {
  it('imports and calls the recipient-first-bounce helper', () => {
    expect(supportFile).toMatch(/raiseRecipientFirstBounceAlert/);
  });

  it('attaches alerted_at to bounced-recipients responses', () => {
    // The admin panel reads `alerted_at` to render the "Alerted" badge.
    expect(supportFile).toMatch(/support_recipient_bounce_alerts/);
    expect(supportFile).toMatch(/first_alerted_at/);
    expect(supportFile).toMatch(/email_lower\s*=\s*ANY\(\$1::text\[\]\)/);
  });
});

describe('BouncedRecipientsPanel — surfaces the alerted badge', () => {
  it('renders an Alerted badge column when first_alerted_at is set', () => {
    expect(adminUiFile).toMatch(/alerted_at/);
    expect(adminUiFile).toMatch(/Alerted/);
  });
});

// ---- Behavior checks --------------------------------------------------------

vi.mock('../../platform/db', () => {
  const queryMock = vi.fn();
  return {
    __queryMock: queryMock,
    getPlatformPool: () => ({ query: queryMock }),
  };
});

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../platform/core/observability', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}));

const { raiseRecipientFirstBounceAlert } = await import(
  '../../platform/help/supportReplyDeliveryAlert'
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryMock = ((await import('../../platform/db')) as any).__queryMock as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logErrorMock = ((await import('../../platform/core/observability')) as any)
  .logError as ReturnType<typeof vi.fn>;

const TENANT_ID = '00000000-0000-0000-0000-000000000099';

const BASE_INPUT = {
  recipientEmail: 'Customer@Example.com',
  replyId: 42,
  ticketId: 'tkt_abc123',
  tenantId: TENANT_ID,
  error: '550 mailbox not found',
};

beforeEach(() => {
  queryMock.mockReset();
  logErrorMock.mockReset();
});

describe('raiseRecipientFirstBounceAlert — behavior', () => {
  it('claims the dedup row, writes critical error_log, and inserts operations_alerts on first call', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ email_lower: 'customer@example.com' }] }) // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });                                       // operations_alerts

    const result = await raiseRecipientFirstBounceAlert(BASE_INPUT);
    expect(result).toEqual({ alerted: true });

    // Claim INSERT used the lowercased address as the dedup key.
    const claimCall = queryMock.mock.calls[0];
    expect(claimCall[0]).toMatch(/INSERT INTO support_recipient_bounce_alerts/);
    expect(claimCall[0]).toMatch(/ON CONFLICT \(email_lower\) DO NOTHING/);
    expect(claimCall[1][0]).toBe('customer@example.com');
    expect(claimCall[1][1]).toBe(42);
    expect(claimCall[1][2]).toBe('tkt_abc123');
    expect(claimCall[1][3]).toBe(TENANT_ID);
    expect(claimCall[1][4]).toBe('550 mailbox not found');

    // Critical error_log via the shared helper.
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [tenantArg, severityArg, messageArg, contextArg] = logErrorMock.mock.calls[0];
    expect(tenantArg).toBe(TENANT_ID);
    expect(severityArg).toBe('critical');
    expect(messageArg).toMatch(/customer@example\.com/);
    expect(messageArg).toMatch(/first permanent SMTP failure/);
    expect(contextArg.errorCode).toBe('support_recipient_first_bounce');
    expect(contextArg.extra).toMatchObject({
      recipient_email: 'customer@example.com',
      reply_id: 42,
      ticket_id: 'tkt_abc123',
      error: '550 mailbox not found',
    });

    // operations_alerts INSERT with the documented type/severity.
    const opsCall = queryMock.mock.calls[1];
    expect(opsCall[0]).toMatch(/INSERT INTO operations_alerts/);
    expect(opsCall[1][0]).toBe(TENANT_ID);
    expect(opsCall[1][1]).toBe('support_recipient_first_bounce');
    expect(opsCall[1][2]).toBe('high');
    expect(opsCall[1][3]).toMatch(/customer@example\.com/);
  });

  it('short-circuits without writing error_log or operations_alerts when the dedup row already exists (rowCount=0)', async () => {
    // Loser of the dedup race: ON CONFLICT DO NOTHING returns rowCount: 0.
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await raiseRecipientFirstBounceAlert(BASE_INPUT);
    expect(result).toEqual({ alerted: false });

    // Only the claim attempt — no error_log, no operations_alerts.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it('writes critical error_log but skips operations_alerts when tenantId is null', async () => {
    // Anonymous marketing-site tickets have no tenant. operations_alerts
    // requires a tenant_id (NOT NULL), so we still write the dedup row +
    // critical error_log but cannot write the in-product alert.
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ email_lower: 'customer@example.com' }],
    });

    const result = await raiseRecipientFirstBounceAlert({ ...BASE_INPUT, tenantId: null });
    expect(result).toEqual({ alerted: true });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock.mock.calls[0][0]).toBeNull();

    // No operations_alerts INSERT was attempted.
    const opsCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO operations_alerts'),
    );
    expect(opsCall).toBeUndefined();
  });

  it('returns { alerted: false } on an empty / whitespace recipient without touching the DB', async () => {
    const result = await raiseRecipientFirstBounceAlert({ ...BASE_INPUT, recipientEmail: '   ' });
    expect(result).toEqual({ alerted: false });
    expect(queryMock).not.toHaveBeenCalled();
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it('does not throw if the claim INSERT errors out — returns { alerted: false }', async () => {
    // A failed INSERT (e.g. transient DB blip) must not crash the calling
    // retry path. Worst case the next bounce on the same address re-attempts
    // the claim and pages ops then.
    queryMock.mockRejectedValueOnce(new Error('connection refused'));

    const result = await raiseRecipientFirstBounceAlert(BASE_INPUT);
    expect(result).toEqual({ alerted: false });
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it('lowercases the address before claim — mixed-case input dedups against existing lower-case row', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await raiseRecipientFirstBounceAlert({
      ...BASE_INPUT,
      recipientEmail: 'CUSTOMER@EXAMPLE.com',
    });

    // The claim parameter must be lowercased — otherwise a mixed-case bounce
    // would silently re-fire the alert under a different PK.
    expect(queryMock.mock.calls[0][1][0]).toBe('customer@example.com');
  });

  it('still writes the critical error_log even if the operations_alerts INSERT throws', async () => {
    // The operations_alerts INSERT is wrapped in try/catch — a failure there
    // must not undo the (already-committed) dedup row or the critical
    // error_log. This protects the dedup invariant: once we've claimed the
    // row, ops has been notified via error_log, even if the in-product alert
    // feed write happened to fail.
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ email_lower: 'customer@example.com' }] })
      .mockRejectedValueOnce(new Error('operations_alerts blew up'));

    const result = await raiseRecipientFirstBounceAlert(BASE_INPUT);
    expect(result).toEqual({ alerted: true });
    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });
});
