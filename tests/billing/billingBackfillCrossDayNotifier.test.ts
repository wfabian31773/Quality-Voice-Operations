import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ----- DB mock --------------------------------------------------------------
//
// Shared mutable state for the synthetic platform pool. Each test seeds
// `alertRow` to drive the SELECT branch of the mocked `pool.query`. The
// notify path issues an UPDATE with a conditional WHERE — we honor that
// shape inside the mock so the acknowledgement-aware short-circuit can
// be observed end-to-end.

interface FakeAlertRow {
  id: string;
  tenant_id: string;
  type: string;
  severity: string;
  message: string;
  metadata: Record<string, unknown> | null;
  call_session_id: string | null;
  acknowledged: boolean;
  notified_at: Date | null;
  notification_kind: string | null;
  created_at: Date;
}

interface UpdateCall {
  kind: 'claim' | 'finalize' | 'release' | 'unknown';
  id: string;
  channels?: string;
}

let alertRow: FakeAlertRow | null = null;
let tenantNameRow: { name: string } | null = null;
let adminEmails: string[] = [];
let updateCalls: UpdateCall[] = [];
let claimShouldSucceed = true;

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      const trimmed = sql.trimStart();
      if (trimmed.startsWith('SELECT id, tenant_id, type')) {
        if (!alertRow) return { rows: [], rowCount: 0 };
        if ((values?.[0] as string) !== alertRow.id) return { rows: [], rowCount: 0 };
        return { rows: [alertRow], rowCount: 1 };
      }
      if (trimmed.startsWith('SELECT name FROM tenants')) {
        if (!tenantNameRow) return { rows: [], rowCount: 0 };
        return { rows: [tenantNameRow], rowCount: 1 };
      }
      if (trimmed.startsWith('SELECT email FROM users')) {
        return {
          rows: adminEmails.map((email) => ({ email })),
          rowCount: adminEmails.length,
        };
      }
      if (trimmed.startsWith('UPDATE operations_alerts')) {
        const id = String(values?.[0]);
        // Distinguish the three UPDATE shapes by their literal SQL fragments.
        if (sql.includes("notification_kind = 'pending'") && sql.includes('RETURNING id')) {
          updateCalls.push({ kind: 'claim', id });
          if (
            claimShouldSucceed &&
            alertRow &&
            alertRow.id === id &&
            !alertRow.acknowledged &&
            !alertRow.notified_at
          ) {
            alertRow.notified_at = new Date();
            alertRow.notification_kind = 'pending';
            return { rows: [{ id }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('notified_at = NULL')) {
          updateCalls.push({ kind: 'release', id });
          if (alertRow && alertRow.id === id && alertRow.notification_kind === 'pending') {
            alertRow.notified_at = null;
            alertRow.notification_kind = null;
            return { rows: [{ id }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SET notification_kind = $2')) {
          const channels = String(values?.[1]);
          updateCalls.push({ kind: 'finalize', id, channels });
          if (alertRow && alertRow.id === id) {
            alertRow.notification_kind = channels;
          }
          return { rows: [], rowCount: 1 };
        }
        updateCalls.push({ kind: 'unknown', id });
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  }),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ----- Email + Slack mocks --------------------------------------------------

const sendEmail = vi.fn(async () => ({ success: true, messageId: 'm-1' }));
vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...(args as [unknown])),
}));

const postToOpsSlackWebhook = vi.fn(async () => ({ success: false, skipped: true }));
vi.mock('../../platform/messaging/SlackWebhookNotifier', () => ({
  postToOpsSlackWebhook: (...args: unknown[]) =>
    postToOpsSlackWebhook(...(args as [unknown])),
}));

// ----- SUT import (after mocks) --------------------------------------------

import {
  notifyFinanceOfBackfillCrossDayAlert,
  resolveFinanceRecipients,
} from '../../platform/billing/billingBackfillCrossDayNotifier';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  alertRow = null;
  tenantNameRow = null;
  adminEmails = [];
  updateCalls = [];
  claimShouldSucceed = true;
  sendEmail.mockClear();
  sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' });
  postToOpsSlackWebhook.mockClear();
  postToOpsSlackWebhook.mockResolvedValue({ success: false, skipped: true });
  delete process.env.FINANCE_ALERT_EMAILS;
  delete process.env.BILLING_ALERT_EMAILS;
  delete process.env.OPS_SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK;
  delete process.env.APP_URL;
  delete process.env.REPLIT_DEV_DOMAIN;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

function seedAlert(overrides: Partial<FakeAlertRow> = {}): FakeAlertRow {
  const row: FakeAlertRow = {
    id: 'alert-1',
    tenant_id: 'tenant-A',
    type: 'billing_backfill_cross_day',
    severity: 'info',
    message: 'Backfill correction moved call ext-1 from 2026-04-19 to 2026-04-20.',
    metadata: {
      tenant_id: 'tenant-A',
      external_id: 'ext-1',
      old_date: '2026-04-19',
      new_date: '2026-04-20',
      source: 'remix-backfill',
      auto_rebalanced: true,
      runbook_url: 'docs/runbooks/billing-backfill-cross-day-rebalance.md',
    },
    call_session_id: 'call-ext-1',
    acknowledged: false,
    notified_at: null,
    notification_kind: null,
    created_at: new Date('2026-04-20T00:05:00Z'),
    ...overrides,
  };
  alertRow = row;
  return row;
}

// ---------------------------------------------------------------------------

describe('resolveFinanceRecipients', () => {
  it('parses FINANCE_ALERT_EMAILS as the primary distribution list', async () => {
    process.env.FINANCE_ALERT_EMAILS = 'finance@acme.test, ar@acme.test ; not-an-email';
    const r = await resolveFinanceRecipients();
    expect(r.source).toBe('finance');
    expect(r.emails).toEqual(['finance@acme.test', 'ar@acme.test']);
  });

  it('falls back to BILLING_ALERT_EMAILS when finance list is empty', async () => {
    process.env.BILLING_ALERT_EMAILS = 'billing@acme.test';
    const r = await resolveFinanceRecipients();
    expect(r.source).toBe('billing');
    expect(r.emails).toEqual(['billing@acme.test']);
  });

  it('falls back to platform admins when both env vars are unset', async () => {
    adminEmails = ['admin@acme.test'];
    const r = await resolveFinanceRecipients();
    expect(r.source).toBe('platform_admin');
    expect(r.emails).toEqual(['admin@acme.test']);
  });

  it('returns an empty list when nothing is configured', async () => {
    const r = await resolveFinanceRecipients();
    expect(r.source).toBe('none');
    expect(r.emails).toEqual([]);
  });
});

describe('notifyFinanceOfBackfillCrossDayAlert — happy path', () => {
  it('sends email with tenant, external_id, dates, runbook link, and ops link', async () => {
    process.env.FINANCE_ALERT_EMAILS = 'finance@acme.test';
    process.env.APP_URL = 'https://app.example.test';
    seedAlert();
    tenantNameRow = { name: 'Acme Co' };

    const result = await notifyFinanceOfBackfillCrossDayAlert('alert-1');

    expect(result.delivered).toBe(true);
    expect(result.claimed).toBe(true);
    expect(result.emailDelivered).toBe(true);
    expect(result.recipients).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(msg.to).toBe('finance@acme.test');
    expect(msg.subject).toContain('ext-1');
    expect(msg.subject).toContain('2026-04-19');
    expect(msg.subject).toContain('2026-04-20');
    // tenant in body
    expect(msg.html).toContain('Acme Co');
    expect(msg.html).toContain('tenant-A');
    expect(msg.text).toContain('tenant-A');
    expect(msg.text).toContain('ext-1');
    // dates
    expect(msg.html).toContain('2026-04-19');
    expect(msg.html).toContain('2026-04-20');
    // runbook
    expect(msg.html).toContain('docs/runbooks/billing-backfill-cross-day-rebalance.md');
    expect(msg.text).toContain('docs/runbooks/billing-backfill-cross-day-rebalance.md');
    // ops link
    expect(msg.html).toContain(
      'https://app.example.test/ops/monitor?alertType=billing_backfill_cross_day',
    );
    // The slot is claimed BEFORE the email send, then finalized with the
    // succeeded channel list afterwards. Two UPDATEs in that order.
    expect(updateCalls).toEqual([
      { kind: 'claim', id: 'alert-1' },
      { kind: 'finalize', id: 'alert-1', channels: 'email' },
    ]);
    expect(alertRow?.notification_kind).toBe('email');
    expect(alertRow?.notified_at).not.toBeNull();
  });

  it('renders an absolute runbook_url as a clickable anchor in the HTML body', async () => {
    process.env.FINANCE_ALERT_EMAILS = 'finance@acme.test';
    seedAlert({
      metadata: {
        external_id: 'EXT-9',
        old_date: '2026-04-15',
        new_date: '2026-04-16',
        runbook_url: 'https://wiki.example.test/runbooks/billing-backfill-cross-day',
      },
    });

    await notifyFinanceOfBackfillCrossDayAlert('alert-1');
    const msg = sendEmail.mock.calls[0][0] as { html: string; text: string };
    expect(msg.html).toContain(
      '<a href="https://wiki.example.test/runbooks/billing-backfill-cross-day"',
    );
    // Plain text body still carries the bare URL — anchors don't translate.
    expect(msg.text).toContain('https://wiki.example.test/runbooks/billing-backfill-cross-day');
  });

  it('claims the slot strictly BEFORE dispatching email or Slack (ordering check)', async () => {
    // Regression guard for the original review-rejected ordering, which
    // sent first and claimed second. We assert the claim UPDATE is the
    // first DB write recorded after the SELECTs, and crucially before
    // sendEmail is invoked.
    process.env.FINANCE_ALERT_EMAILS = 'finance@acme.test';
    seedAlert();

    let claimSeenBeforeSend = false;
    sendEmail.mockImplementation(async () => {
      claimSeenBeforeSend = updateCalls.some((u) => u.kind === 'claim');
      return { success: true, messageId: 'ok' };
    });

    await notifyFinanceOfBackfillCrossDayAlert('alert-1');
    expect(claimSeenBeforeSend).toBe(true);
  });

  it('uses the SKIPPED-flavor subject and rotating-light Slack header for warning alerts', async () => {
    process.env.FINANCE_ALERT_EMAILS = 'finance@acme.test';
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/services/AAA/BBB';
    postToOpsSlackWebhook.mockResolvedValue({ success: true });
    seedAlert({
      type: 'billing_backfill_cross_day_skipped',
      severity: 'warning',
      metadata: {
        tenant_id: 'tenant-A',
        external_id: 'ext-skip-1',
        old_date: '2026-04-19',
        new_date: '2026-04-20',
        source: 'remix-backfill',
        auto_rebalanced: false,
        runbook_url: 'docs/runbooks/billing-backfill-cross-day-rebalance.md',
        manual_rebalance_required: true,
      },
    });

    const result = await notifyFinanceOfBackfillCrossDayAlert('alert-1');

    expect(result.delivered).toBe(true);
    expect(result.emailDelivered).toBe(true);
    expect(result.slackDelivered).toBe(true);
    const msg = sendEmail.mock.calls[0][0] as { subject: string; html: string };
    expect(msg.subject).toMatch(/Manual rebalance required/i);
    expect(msg.html).toMatch(/Manual rebalance required/i);
    const slack = postToOpsSlackWebhook.mock.calls[0][0] as {
      text: string;
      blocks: Array<Record<string, unknown>>;
    };
    expect(slack.text).toMatch(/Manual rebalance required/i);
    expect(JSON.stringify(slack.blocks)).toContain('rotating_light');
    // claim happens before either send; finalize records both channels.
    expect(updateCalls).toEqual([
      { kind: 'claim', id: 'alert-1' },
      { kind: 'finalize', id: 'alert-1', channels: 'email,slack' },
    ]);
  });
});

describe('notifyFinanceOfBackfillCrossDayAlert — acknowledgement awareness', () => {
  it('skips delivery when the alert is already acknowledged (no claim, no send)', async () => {
    process.env.FINANCE_ALERT_EMAILS = 'finance@acme.test';
    seedAlert({ acknowledged: true });

    const result = await notifyFinanceOfBackfillCrossDayAlert('alert-1');

    expect(result.delivered).toBe(false);
    expect(result.skipReason).toBe('already_acknowledged');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(postToOpsSlackWebhook).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([]);
  });

  it('skips delivery when notified_at is already set (dedup across crash-restart)', async () => {
    process.env.FINANCE_ALERT_EMAILS = 'finance@acme.test';
    seedAlert({ notified_at: new Date('2026-04-20T01:00:00Z') });

    const result = await notifyFinanceOfBackfillCrossDayAlert('alert-1');

    expect(result.delivered).toBe(false);
    expect(result.skipReason).toBe('already_notified');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(postToOpsSlackWebhook).not.toHaveBeenCalled();
  });

  it('does NOT send email or Slack when the conditional claim UPDATE matches zero rows (race lost)', async () => {
    // Simulates the case where another worker (or an ack landing between
    // loadAlert and claim) wins the conditional UPDATE. The acknowledgement-
    // aware contract requires that we never dispatch in this state.
    process.env.FINANCE_ALERT_EMAILS = 'finance@acme.test';
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
    postToOpsSlackWebhook.mockResolvedValue({ success: true });
    seedAlert();
    claimShouldSucceed = false;

    const result = await notifyFinanceOfBackfillCrossDayAlert('alert-1');

    expect(sendEmail).not.toHaveBeenCalled();
    expect(postToOpsSlackWebhook).not.toHaveBeenCalled();
    expect(result.claimed).toBe(false);
    expect(result.delivered).toBe(false);
    expect(result.emailDelivered).toBe(false);
    expect(result.slackDelivered).toBe(false);
    expect(result.skipReason).toBe('claim_lost');
    // The claim UPDATE was attempted but matched zero rows; no finalize/release.
    expect(updateCalls).toEqual([{ kind: 'claim', id: 'alert-1' }]);
  });
});

describe('notifyFinanceOfBackfillCrossDayAlert — degraded paths', () => {
  it('returns alert_not_found when the row is missing', async () => {
    const result = await notifyFinanceOfBackfillCrossDayAlert('missing');
    expect(result.skipReason).toBe('alert_not_found');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns no_recipients_or_channels when neither email nor slack are configured', async () => {
    seedAlert();
    const result = await notifyFinanceOfBackfillCrossDayAlert('alert-1');
    expect(result.skipReason).toBe('no_recipients_or_channels');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([]);
  });

  it('still delivers via Slack alone when no email recipients are configured', async () => {
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
    postToOpsSlackWebhook.mockResolvedValue({ success: true });
    seedAlert();

    const result = await notifyFinanceOfBackfillCrossDayAlert('alert-1');
    expect(result.delivered).toBe(true);
    expect(result.emailDelivered).toBe(false);
    expect(result.slackDelivered).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([
      { kind: 'claim', id: 'alert-1' },
      { kind: 'finalize', id: 'alert-1', channels: 'slack' },
    ]);
  });

  it('releases the slot and returns channels_failed when every channel errors', async () => {
    // We optimistically claimed the slot before dispatch (to keep the dedup
    // contract atomic). When every channel then fails, we must clear the
    // claim so a future retry can re-attempt — otherwise a one-shot SMTP
    // outage would permanently mute the alert.
    process.env.FINANCE_ALERT_EMAILS = 'finance@acme.test';
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
    sendEmail.mockResolvedValue({ success: false, error: 'smtp down' });
    postToOpsSlackWebhook.mockResolvedValue({ success: false, error: 'slack down' });
    seedAlert();

    const result = await notifyFinanceOfBackfillCrossDayAlert('alert-1');
    expect(result.skipReason).toBe('channels_failed');
    expect(result.delivered).toBe(false);
    expect(result.claimed).toBe(false);
    expect(updateCalls).toEqual([
      { kind: 'claim', id: 'alert-1' },
      { kind: 'release', id: 'alert-1' },
    ]);
    // Released slot returns the alert row to its pre-claim state so the
    // next invocation can re-attempt.
    expect(alertRow?.notified_at).toBeNull();
    expect(alertRow?.notification_kind).toBeNull();
  });
});

// ---- Static contract checks for the wiring side ---------------------------

describe('recordBackfillCrossDayAlert wiring — static checks', () => {
  const ingestSrc = readFileSync(
    join(process.cwd(), 'server/admin-api/routes/ingest.ts'),
    'utf8',
  );

  it('imports the finance notifier helper', () => {
    expect(ingestSrc).toMatch(
      /import\s+\{\s*notifyFinanceOfBackfillCrossDayAlert\s*\}\s+from\s+['"][^'"]*billingBackfillCrossDayNotifier['"]/,
    );
  });

  it('captures the inserted alert id via RETURNING and feeds it into the notifier', () => {
    expect(ingestSrc).toMatch(/RETURNING id/);
    expect(ingestSrc).toMatch(/notifyFinanceOfBackfillCrossDayAlert\(insertedAlertId\)/);
  });

  it('wraps the notifier call in a try/catch so it cannot bubble up into ingest', () => {
    // Locate the notifier-call block and verify it has both a try and a
    // matching catch — the exact text is not pinned because it lives in a
    // larger function body.
    const notifyIdx = ingestSrc.indexOf('notifyFinanceOfBackfillCrossDayAlert(insertedAlertId)');
    expect(notifyIdx).toBeGreaterThan(-1);
    const slice = ingestSrc.slice(Math.max(0, notifyIdx - 200), notifyIdx + 400);
    expect(slice).toMatch(/try\s*\{/);
    expect(slice).toMatch(/\}\s*catch\s*\(/);
  });
});
