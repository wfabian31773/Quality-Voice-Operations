import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- Static contract tests --------------------------------------------------
//
// The resubscribe audit trail is built from three pieces that must agree:
//   1. The migration declaring `support_email_unsubscribe_audit`.
//   2. The helper writing into it from `removeSupportEmailUnsubscribe`.
//   3. The admin endpoint reading the recent rows back out.
//
// If any of these drift, the PlatformAdmin "Recently resubscribed" panel
// will silently lose visibility. Lock the wiring with a few text checks
// so a future refactor that, say, renames the audit table has to update
// every site at once.

const migrationFile = readFileSync(
  join(process.cwd(), 'migrations/075_support_email_resubscribe_audit.sql'),
  'utf8',
);
const suppFile = readFileSync(
  join(process.cwd(), 'platform/email/SupportEmailSuppression.ts'),
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

describe('support_email_unsubscribe_audit — migration', () => {
  it('creates the audit table with the columns the read path expects', () => {
    expect(migrationFile).toMatch(
      /CREATE TABLE IF NOT EXISTS support_email_unsubscribe_audit/,
    );
    // The four "snapshot" columns the read endpoint and UI both depend on.
    // Each one is justified in the helper / endpoint comment trail.
    expect(migrationFile).toMatch(/email_lower\s+TEXT NOT NULL/);
    expect(migrationFile).toMatch(/resubscribed_source\s+TEXT/);
    expect(migrationFile).toMatch(/previous_unsubscribed_at\s+TIMESTAMPTZ/);
    expect(migrationFile).toMatch(/previous_source\s+TEXT/);
    expect(migrationFile).toMatch(
      /resubscribed_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/,
    );
  });

  it('creates a recent-first index used by the 30-day read window', () => {
    expect(migrationFile).toMatch(
      /CREATE INDEX IF NOT EXISTS support_email_unsubscribe_audit_recent_idx[\s\S]*?\(resubscribed_at DESC\)/,
    );
  });
});

describe('removeSupportEmailUnsubscribe — audit insert wiring', () => {
  it('uses DELETE ... RETURNING so the prior row is captured atomically', () => {
    // The audit insert needs the `source` and `unsubscribed_at` from the
    // deleted row. Capturing them with RETURNING avoids a "delete then
    // select" race where a concurrent re-unsubscribe could race in
    // between and leave us auditing the wrong source.
    expect(suppFile).toMatch(
      /DELETE FROM support_email_unsubscribes[\s\S]{0,160}RETURNING source, unsubscribed_at/,
    );
  });

  it('inserts into the audit table inside the same helper, only when a row was removed', () => {
    expect(suppFile).toMatch(
      /INSERT INTO support_email_unsubscribe_audit[\s\S]*?\(email_lower, resubscribed_source, previous_unsubscribed_at, previous_source\)/,
    );
    // The audit insert is gated on `removed` so a no-op resubscribe
    // (address never opted out) doesn't pollute the audit log with
    // null-snapshot rows.
    const idxRemoved = suppFile.indexOf('if (removed)');
    const idxInsert = suppFile.indexOf('INSERT INTO support_email_unsubscribe_audit');
    expect(idxRemoved).toBeGreaterThan(-1);
    expect(idxInsert).toBeGreaterThan(idxRemoved);
  });
});

describe('/support/unsubscribed — recent-resubscribe payload', () => {
  it('queries the audit table with a 30-day window and returns recent_resubscribes', () => {
    const start = supportFile.indexOf("'/support/unsubscribed'");
    expect(start).toBeGreaterThan(-1);
    const slice = supportFile.slice(start, start + 4000);
    expect(slice).toMatch(/FROM support_email_unsubscribe_audit/);
    expect(slice).toMatch(/resubscribed_at >= NOW\(\) - /);
    expect(slice).toMatch(/recent_resubscribes:/);
    expect(slice).toMatch(/resubscribe_window_days:/);
  });
});

describe('PlatformAdmin — recently resubscribed sub-section', () => {
  it('renders a "Recently resubscribed" section sourced from recent_resubscribes', () => {
    expect(adminUiFile).toMatch(/Recently resubscribed/);
    expect(adminUiFile).toMatch(/recent_resubscribes/);
    expect(adminUiFile).toMatch(/previous_unsubscribed_at/);
    expect(adminUiFile).toMatch(/resubscribed_source/);
  });

  it('keeps the panel visible whenever either list has rows', () => {
    // Regression guard: the original panel hid itself when the
    // unsubscribe list was empty, which would have hidden recent
    // resubscribes too. The new gate must consider both lists.
    expect(adminUiFile).toMatch(
      /unsubscribes\.length === 0 && recentResubscribes\.length === 0/,
    );
  });
});

// ---- Runtime behavior of the helper ----------------------------------------
//
// Exercise `removeSupportEmailUnsubscribe` directly with a mocked pool to
// prove the audit row goes in and that an audit failure does NOT roll the
// caller back (the resubscribe is the user-facing promise; losing the
// audit row is recoverable, losing the unsubscribe DELETE is not).

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

const { removeSupportEmailUnsubscribe } = await import(
  '../../platform/email/SupportEmailSuppression'
);
const queryMock = (
  (await import('../../platform/db')) as unknown as {
    __queryMock: ReturnType<typeof vi.fn>;
  }
).__queryMock;

beforeEach(() => {
  queryMock.mockReset();
});

describe('removeSupportEmailUnsubscribe — runtime audit insert', () => {
  it('writes the audit row with the snapshot from the deleted unsubscribe', async () => {
    // First call (DELETE) returns the prior row; second (INSERT) succeeds.
    queryMock.mockImplementation(async (sql: string) => {
      if (/DELETE FROM support_email_unsubscribes/.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              source: 'list_unsubscribe_header',
              unsubscribed_at: '2026-04-01T10:00:00Z',
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });

    const removed = await removeSupportEmailUnsubscribe(
      ' Alice@Example.COM ',
      'landing_page_resubscribe',
    );
    expect(removed).toBe(true);

    // Two calls: the DELETE and the audit INSERT.
    expect(queryMock).toHaveBeenCalledTimes(2);
    const deleteCall = queryMock.mock.calls.find((c) =>
      /DELETE FROM support_email_unsubscribes/.test(c[0]),
    );
    expect(deleteCall?.[1]).toEqual(['alice@example.com']);

    const insertCall = queryMock.mock.calls.find((c) =>
      /INSERT INTO support_email_unsubscribe_audit/.test(c[0]),
    );
    expect(insertCall).toBeTruthy();
    // (email_lower, resubscribed_source, previous_unsubscribed_at, previous_source)
    expect(insertCall?.[1]).toEqual([
      'alice@example.com',
      'landing_page_resubscribe',
      '2026-04-01T10:00:00Z',
      'list_unsubscribe_header',
    ]);
  });

  it('does NOT write an audit row when the address was not on the list', async () => {
    // No-op resubscribe: DELETE returns 0 rows. Auditing this would just
    // pollute the trail with null snapshots that the panel can't explain.
    queryMock.mockImplementation(async (sql: string) => {
      if (/DELETE FROM support_email_unsubscribes/.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const removed = await removeSupportEmailUnsubscribe(
      'nobody@example.com',
      'landing_page_resubscribe',
    );
    expect(removed).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toMatch(/DELETE FROM support_email_unsubscribes/);
  });

  it('still confirms the resubscribe when the audit insert blows up', async () => {
    // The user-facing promise is "we won't send to you anymore" → "we
    // will start sending again". Losing the audit row breaks ops's
    // forensic trail but doesn't change the live send-side gate, so the
    // helper must NOT propagate the audit failure back to the caller.
    queryMock.mockImplementation(async (sql: string) => {
      if (/DELETE FROM support_email_unsubscribes/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ source: 'one_click', unsubscribed_at: '2026-04-10T00:00:00Z' }],
        };
      }
      throw new Error('audit table is on fire');
    });

    const removed = await removeSupportEmailUnsubscribe(
      'bob@example.com',
      'landing_page_resubscribe',
    );
    expect(removed).toBe(true);
  });

  it('still throws when the DELETE itself fails (so the caller can retry)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      removeSupportEmailUnsubscribe('carol@example.com', 'landing_page_resubscribe'),
    ).rejects.toThrow(/db down/);
  });
});
