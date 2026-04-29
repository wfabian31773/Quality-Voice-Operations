/**
 * Coverage for `platform/security/EncryptionReminderScheduler.ts`.
 *
 * The scheduler reuses the existing manual-reminder email template and
 * the same `platform.encryption.reminder_sent` audit action, so the
 * "Last reminder" column on the Platform Compliance → Encryption tab
 * picks up automated sends with no schema changes. These tests lock
 * down the shape of that contract:
 *
 *   1. With nothing due, the cycle is a no-op (no email, no audit).
 *   2. A due tenant gets an email + a single audit row tagged with
 *      `actorRole: 'system'` and `actorUserId: null` (system-initiated
 *      → does not point at a synthetic "system" user).
 *   3. A failed email send does NOT write the audit row, so the next
 *      tick can retry on the same cooldown clock.
 *   4. The cycle bails out cleanly when no absolute APP_URL is
 *      configured (otherwise the email would render an unclickable
 *      relative path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// One shared query mock so every `getPlatformPool().query(...)` call
// inside the scheduler resolves against the same vi.fn() — vitest
// re-invokes the factory's `getPlatformPool` getter on every call, so
// without a closured singleton each call would get a fresh mock and
// the tests below would never see their own mockResolvedValueOnce.
const queryMock = vi.fn();
const fakePool = { query: queryMock };

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => fakePool,
}));

vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { runEncryptionReminderCycle } from '../../platform/security/EncryptionReminderScheduler';
import { sendEmail } from '../../platform/email/EmailService';
import { writeAuditLog } from '../../platform/audit/AuditService';

const sendEmailMock = vi.mocked(sendEmail);
const writeAuditLogMock = vi.mocked(writeAuditLog);

const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_REPLIT_DEV_DOMAIN = process.env.REPLIT_DEV_DOMAIN;

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  writeAuditLogMock.mockReset();
  // Default to a clean APP_URL so email links resolve to a real path.
  process.env.APP_URL = 'https://app.test.qvo.ai';
  // Defensively unset REPLIT_DEV_DOMAIN so the no-base-url test below
  // can null both signals and exercise the early bail-out.
  delete process.env.REPLIT_DEV_DOMAIN;
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = ORIGINAL_APP_URL;
  }
  if (ORIGINAL_REPLIT_DEV_DOMAIN === undefined) {
    delete process.env.REPLIT_DEV_DOMAIN;
  } else {
    process.env.REPLIT_DEV_DOMAIN = ORIGINAL_REPLIT_DEV_DOMAIN;
  }
});

describe('runEncryptionReminderCycle', () => {
  it('does nothing when no tenants are due for a reminder', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await runEncryptionReminderCycle();

    expect(result.scanned).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('emails the owner and writes a system-initiated audit row for each due tenant', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 'tenant-1',
          tenant_name: 'Acme Plumbing',
          owner_user_id: 'user-1',
          owner_email: 'owner@acme.test',
          owner_first_name: 'Ada',
          owner_last_name: 'Owner',
          last_reminded_at: null,
        },
      ],
    });
    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_1' });
    writeAuditLogMock.mockResolvedValueOnce(undefined);

    const result = await runEncryptionReminderCycle();

    expect(result.scanned).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sendArg = sendEmailMock.mock.calls[0][0];
    expect(sendArg.to).toBe('owner@acme.test');
    expect(typeof sendArg.subject).toBe('string');
    expect(String(sendArg.html)).toContain('https://app.test.qvo.ai/compliance');

    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const auditArg = writeAuditLogMock.mock.calls[0][0];
    expect(auditArg).toMatchObject({
      tenantId: 'tenant-1',
      // System-initiated send must clear the FK to users(id), not point
      // at a synthetic "system" string. The platformCompliance route's
      // LEFT JOIN already handles a null actor by rendering "by
      // automated scheduler" in the UI.
      actorUserId: null,
      actorRole: 'system',
      action: 'platform.encryption.reminder_sent',
      resourceType: 'tenant',
      resourceId: 'tenant-1',
      severity: 'info',
    });
    const changes = auditArg.changes as Record<string, unknown>;
    expect(changes.source).toBe('scheduled');
    expect(changes.sentBy).toBe('EncryptionReminderScheduler');
    expect(changes.ownerEmail).toBe('owner@acme.test');
    expect(changes.messageId).toBe('msg_1');
  });

  it('does NOT write an audit row when the email send fails (so the next tick retries)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 'tenant-2',
          tenant_name: 'Beta Co',
          owner_user_id: 'user-2',
          owner_email: 'owner@beta.test',
          owner_first_name: null,
          owner_last_name: null,
          last_reminded_at: new Date('2026-04-01T00:00:00Z'),
        },
      ],
    });
    sendEmailMock.mockResolvedValueOnce({
      success: false,
      error: 'smtp greylisted',
    });

    const result = await runEncryptionReminderCycle();

    expect(result.scanned).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('bails out cleanly when neither APP_URL nor REPLIT_DEV_DOMAIN is configured', async () => {
    delete process.env.APP_URL;
    delete process.env.REPLIT_DEV_DOMAIN;

    const result = await runEncryptionReminderCycle();

    expect(result.scanned).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.skippedNoBaseUrl).toBe(1);
    // The query is gated behind the URL check so we never spend the
    // round-trip when we know we'd send a broken link anyway.
    expect(queryMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('excludes paused tenants from the due-tenant selection query', async () => {
    // The scheduler MUST honor the per-tenant pause flag — the manual
    // "Send reminder" button on the Platform Compliance tab still
    // works regardless, but the automated cadence should skip paused
    // tenants. We assert this at the SQL level so a future query
    // refactor that drops the predicate is caught immediately.
    queryMock.mockResolvedValueOnce({ rows: [] });

    await runEncryptionReminderCycle();

    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/encryption_reminder_paused/i);
    expect(sql).toMatch(/=\s*FALSE/i);
    // Cooldown is also part of the same predicate — guard against a
    // refactor that removes the audit-history join (which would let
    // every paused-but-keyless tenant get re-emailed on every tick).
    // The action name is bound as a parameter, not interpolated, so
    // we assert the bind value rather than searching the SQL text.
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params).toContain('platform.encryption.reminder_sent');
  });

  it('keeps sending to the remaining tenants after one fails', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 'tenant-fail',
          tenant_name: 'FailCo',
          owner_user_id: 'user-fail',
          owner_email: 'owner@fail.test',
          owner_first_name: null,
          owner_last_name: null,
          last_reminded_at: null,
        },
        {
          tenant_id: 'tenant-ok',
          tenant_name: 'OkCo',
          owner_user_id: 'user-ok',
          owner_email: 'owner@ok.test',
          owner_first_name: null,
          owner_last_name: null,
          last_reminded_at: null,
        },
      ],
    });
    sendEmailMock
      .mockResolvedValueOnce({ success: false, error: 'first send failed' })
      .mockResolvedValueOnce({ success: true, messageId: 'msg_ok' });
    writeAuditLogMock.mockResolvedValueOnce(undefined);

    const result = await runEncryptionReminderCycle();

    expect(result.scanned).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);

    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const auditArg = writeAuditLogMock.mock.calls[0][0];
    expect(auditArg.tenantId).toBe('tenant-ok');
  });
});
