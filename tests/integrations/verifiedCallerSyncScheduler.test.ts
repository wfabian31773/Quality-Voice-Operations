import { describe, it, expect, beforeEach, vi } from 'vitest';

const fanoutInAppNotificationMock = vi.fn(async () => 1);
vi.mock('../../platform/notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: (...args: unknown[]) =>
    fanoutInAppNotificationMock(...(args as [])),
}));

const getTenantAlertEmailRecipientsMock = vi.fn(async () => ({
  emails: ['admin@example.com'],
  userIds: ['admin-user-1'],
}));
vi.mock('../../platform/integrations/connectors/ConnectorAlertRecipients', () => ({
  getTenantAlertEmailRecipients: (...args: unknown[]) =>
    getTenantAlertEmailRecipientsMock(...(args as [])),
}));

const writeAuditLogMock = vi.fn(async () => undefined);
vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...(args as [])),
}));

const listPendingCallersToSyncMock = vi.fn();
const syncCallerIdStatusMock = vi.fn();
const claimVerifiedNotificationSlotMock = vi.fn(async () => true);

vi.mock('../../platform/telephony/TrustedCallerService', () => ({
  VERIFICATION_TTL_MS: 10 * 60 * 1000,
  listPendingCallersToSync: (...args: unknown[]) =>
    listPendingCallersToSyncMock(...(args as [])),
  syncCallerIdStatus: (...args: unknown[]) =>
    syncCallerIdStatusMock(...(args as [string, string])),
  claimVerifiedNotificationSlot: (...args: unknown[]) =>
    claimVerifiedNotificationSlotMock(...(args as [string, string])),
}));

import { runVerifiedCallerSyncCycle } from '../../platform/telephony/VerifiedCallerSyncScheduler';

interface MockCaller {
  id: string;
  tenantId: string;
  phoneNumber: string;
  friendlyName: string | null;
  status: 'pending' | 'verified' | 'failed' | 'rotated';
  registeredByUserId: string | null;
}

function makePending(overrides: Partial<MockCaller> = {}): MockCaller {
  return {
    id: 'caller-1',
    tenantId: 'tenant-1',
    phoneNumber: '+12125550123',
    friendlyName: 'Sales Line',
    status: 'pending',
    registeredByUserId: 'user-42',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fanoutInAppNotificationMock.mockResolvedValue(1);
  claimVerifiedNotificationSlotMock.mockResolvedValue(true);
  writeAuditLogMock.mockResolvedValue(undefined);
  getTenantAlertEmailRecipientsMock.mockResolvedValue({
    emails: ['admin@example.com'],
    userIds: ['admin-user-1'],
  });
});

describe('runVerifiedCallerSyncCycle', () => {
  it('returns empty stats when there are no pending callers', async () => {
    listPendingCallersToSyncMock.mockResolvedValueOnce([]);

    const result = await runVerifiedCallerSyncCycle();

    expect(result).toEqual({
      inspected: 0,
      verified: 0,
      failed: 0,
      stillPending: 0,
      errors: 0,
      notificationsSent: 0,
      notificationsThrottled: 0,
      deferred: 0,
      byTenant: {},
    });
    expect(syncCallerIdStatusMock).not.toHaveBeenCalled();
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('promotes pending → verified, writes an audit log, and dispatches a success notification to the registrar', async () => {
    const pending = makePending();
    listPendingCallersToSyncMock.mockResolvedValueOnce([pending]);
    syncCallerIdStatusMock.mockResolvedValueOnce({
      ...pending,
      status: 'verified',
    });

    const result = await runVerifiedCallerSyncCycle();

    expect(result.inspected).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.stillPending).toBe(0);
    expect(result.notificationsSent).toBe(1);
    expect(result.byTenant).toEqual({
      'tenant-1': {
        inspected: 1,
        verified: 1,
        failed: 0,
        stillPending: 0,
        errors: 0,
        deferred: 0,
      },
    });

    expect(syncCallerIdStatusMock).toHaveBeenCalledWith('tenant-1', 'caller-1');
    expect(fanoutInAppNotificationMock).toHaveBeenCalledTimes(1);
    const fanoutArgs = fanoutInAppNotificationMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fanoutArgs.tenantId).toBe('tenant-1');
    expect(fanoutArgs.type).toBe('trusted_caller_verified');
    expect(fanoutArgs.category).toBe('integration');
    expect(fanoutArgs.userIds).toEqual(['user-42']);
    expect(String(fanoutArgs.title)).toContain('+12125550123');
    expect(String(fanoutArgs.message)).toContain('Sales Line');
    // Should NOT fall back to admin recipients when registrar is known.
    expect(getTenantAlertEmailRecipientsMock).not.toHaveBeenCalled();

    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const auditArgs = writeAuditLogMock.mock.calls[0][0] as Record<string, unknown>;
    expect(auditArgs.tenantId).toBe('tenant-1');
    expect(auditArgs.actorUserId).toBe('system');
    expect(auditArgs.actorRole).toBe('system');
    expect(auditArgs.action).toBe('trusted_caller.auto_verified');
    expect(auditArgs.resourceType).toBe('trusted_caller');
    expect(auditArgs.resourceId).toBe('caller-1');
    expect(auditArgs.severity).toBe('info');
    expect((auditArgs.changes as Record<string, unknown>).reason).toBe(
      'twilio_confirmed_outgoing_caller_id',
    );
  });

  it('falls back to tenant admins when the registering user is unknown', async () => {
    const pending = makePending({ registeredByUserId: null });
    listPendingCallersToSyncMock.mockResolvedValueOnce([pending]);
    syncCallerIdStatusMock.mockResolvedValueOnce({
      ...pending,
      status: 'verified',
    });

    const result = await runVerifiedCallerSyncCycle();

    expect(result.verified).toBe(1);
    expect(result.notificationsSent).toBe(1);
    expect(getTenantAlertEmailRecipientsMock).toHaveBeenCalledWith('tenant-1', 5);
    const fanoutArgs = fanoutInAppNotificationMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fanoutArgs.userIds).toEqual(['admin-user-1']);
  });

  it('counts pending → failed transitions, writes a warning-level audit log, and skips the success notification', async () => {
    const pending = makePending();
    listPendingCallersToSyncMock.mockResolvedValueOnce([pending]);
    syncCallerIdStatusMock.mockResolvedValueOnce({
      ...pending,
      status: 'failed',
    });

    const result = await runVerifiedCallerSyncCycle();

    expect(result.inspected).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.notificationsSent).toBe(0);
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
    expect(result.byTenant['tenant-1'].failed).toBe(1);

    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const auditArgs = writeAuditLogMock.mock.calls[0][0] as Record<string, unknown>;
    expect(auditArgs.action).toBe('trusted_caller.auto_failed');
    expect(auditArgs.severity).toBe('warning');
    expect(auditArgs.actorUserId).toBe('system');
    expect((auditArgs.changes as Record<string, unknown>).reason).toBe(
      'verification_window_expired',
    );
  });

  it('counts still-pending rows separately and does not write an audit log', async () => {
    const pending = makePending();
    listPendingCallersToSyncMock.mockResolvedValueOnce([pending]);
    syncCallerIdStatusMock.mockResolvedValueOnce({
      ...pending,
      status: 'pending',
    });

    const result = await runVerifiedCallerSyncCycle();

    expect(result.inspected).toBe(1);
    expect(result.stillPending).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.failed).toBe(0);
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
    expect(result.byTenant['tenant-1'].stillPending).toBe(1);
  });

  it('handles multiple callers across tenants and tracks per-tenant totals', async () => {
    const callers = [
      makePending({ id: 'c1', tenantId: 't1', phoneNumber: '+15550001111' }),
      makePending({ id: 'c2', tenantId: 't2', phoneNumber: '+15550002222', registeredByUserId: null }),
      makePending({ id: 'c3', tenantId: 't1', phoneNumber: '+15550003333' }),
    ];
    listPendingCallersToSyncMock.mockResolvedValueOnce(callers);
    syncCallerIdStatusMock
      .mockResolvedValueOnce({ ...callers[0], status: 'verified' })
      .mockResolvedValueOnce({ ...callers[1], status: 'failed' })
      .mockResolvedValueOnce({ ...callers[2], status: 'pending' });

    const result = await runVerifiedCallerSyncCycle();

    expect(result.inspected).toBe(3);
    expect(result.verified).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.stillPending).toBe(1);
    expect(result.notificationsSent).toBe(1);
    expect(syncCallerIdStatusMock).toHaveBeenCalledTimes(3);
    expect(syncCallerIdStatusMock).toHaveBeenNthCalledWith(1, 't1', 'c1');
    expect(syncCallerIdStatusMock).toHaveBeenNthCalledWith(2, 't2', 'c2');
    expect(syncCallerIdStatusMock).toHaveBeenNthCalledWith(3, 't1', 'c3');

    expect(result.byTenant).toEqual({
      t1: {
        inspected: 2,
        verified: 1,
        failed: 0,
        stillPending: 1,
        errors: 0,
        deferred: 0,
      },
      t2: {
        inspected: 1,
        verified: 0,
        failed: 1,
        stillPending: 0,
        errors: 0,
        deferred: 0,
      },
    });
  });

  it('caps per-tenant work at MAX_PER_TENANT_PER_CYCLE and defers the rest', async () => {
    // 30 pending callers for tenant-1 (above the cap of 25) plus one for
    // tenant-2 which must still be processed (the cap is per-tenant, not
    // global).
    const tenant1Callers = Array.from({ length: 30 }, (_, i) =>
      makePending({
        id: `c-${i}`,
        tenantId: 'tenant-1',
        phoneNumber: `+1500000${String(i).padStart(4, '0')}`,
      }),
    );
    const tenant2Caller = makePending({
      id: 'c-other',
      tenantId: 'tenant-2',
      phoneNumber: '+15559990000',
    });
    listPendingCallersToSyncMock.mockResolvedValueOnce([
      ...tenant1Callers,
      tenant2Caller,
    ]);
    syncCallerIdStatusMock.mockImplementation(async (_t: string, id: string) => {
      const source = [...tenant1Callers, tenant2Caller].find((c) => c.id === id)!;
      return { ...source, status: 'pending' };
    });

    const result = await runVerifiedCallerSyncCycle();

    // Only 25 of the tenant-1 rows should have been touched; the
    // remaining 5 are deferred to the next cycle.
    expect(result.inspected).toBe(26); // 25 from tenant-1 + 1 from tenant-2
    expect(result.deferred).toBe(5);
    expect(result.byTenant['tenant-1']).toMatchObject({
      inspected: 25,
      stillPending: 25,
      deferred: 5,
    });
    expect(result.byTenant['tenant-2']).toMatchObject({
      inspected: 1,
      stillPending: 1,
      deferred: 0,
    });
    expect(syncCallerIdStatusMock).toHaveBeenCalledTimes(26);
  });

  it('continues processing the rest of the batch when one sync throws', async () => {
    const callers = [
      makePending({ id: 'c1' }),
      makePending({ id: 'c2', phoneNumber: '+15550009999' }),
    ];
    listPendingCallersToSyncMock.mockResolvedValueOnce(callers);
    syncCallerIdStatusMock
      .mockRejectedValueOnce(new Error('Twilio 503'))
      .mockResolvedValueOnce({ ...callers[1], status: 'verified' });

    const result = await runVerifiedCallerSyncCycle();

    expect(result.inspected).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.notificationsSent).toBe(1);
    expect(result.byTenant['tenant-1'].errors).toBe(1);
  });

  it('does NOT send a notification or audit log when the row was already verified before this cycle', async () => {
    const alreadyVerified = makePending({ status: 'verified' });
    listPendingCallersToSyncMock.mockResolvedValueOnce([alreadyVerified]);
    syncCallerIdStatusMock.mockResolvedValueOnce({
      ...alreadyVerified,
      status: 'verified',
    });

    const result = await runVerifiedCallerSyncCycle();

    // Listed row was somehow already verified (race / stale read). Since
    // the prior status wasn't `pending`, we must NOT re-fire the success
    // toast — that would spam users every cycle.
    expect(result.verified).toBe(0);
    expect(result.notificationsSent).toBe(0);
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('records an error and returns when the listing query fails', async () => {
    listPendingCallersToSyncMock.mockRejectedValueOnce(new Error('DB down'));

    const result = await runVerifiedCallerSyncCycle();

    expect(result.errors).toBe(1);
    expect(result.inspected).toBe(0);
    expect(syncCallerIdStatusMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('still counts the verification when the success notification fails to dispatch', async () => {
    const pending = makePending();
    listPendingCallersToSyncMock.mockResolvedValueOnce([pending]);
    syncCallerIdStatusMock.mockResolvedValueOnce({ ...pending, status: 'verified' });
    fanoutInAppNotificationMock.mockRejectedValueOnce(new Error('notifications down'));

    const result = await runVerifiedCallerSyncCycle();

    expect(result.verified).toBe(1);
    expect(result.notificationsSent).toBe(0);
    // Audit log must still be written even if the notification fan-out
    // fails, since the DB row WAS promoted to verified.
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses the notification (counted as throttled) when another instance already claimed the slot', async () => {
    const pending = makePending();
    listPendingCallersToSyncMock.mockResolvedValueOnce([pending]);
    syncCallerIdStatusMock.mockResolvedValueOnce({ ...pending, status: 'verified' });
    // Simulate the concurrent-scheduler race: the slot UPDATE matches 0 rows
    // because the other instance already wrote `verified_notification_sent_at`.
    claimVerifiedNotificationSlotMock.mockResolvedValueOnce(false);

    const result = await runVerifiedCallerSyncCycle();

    expect(result.verified).toBe(1);
    expect(result.notificationsSent).toBe(0);
    expect(result.notificationsThrottled).toBe(1);
    // No fanout when the slot wasn't won — this is the whole point of the gate.
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
  });

  it('still counts the verification when the slot-claim query itself errors', async () => {
    const pending = makePending();
    listPendingCallersToSyncMock.mockResolvedValueOnce([pending]);
    syncCallerIdStatusMock.mockResolvedValueOnce({ ...pending, status: 'verified' });
    claimVerifiedNotificationSlotMock.mockRejectedValueOnce(new Error('slot UPDATE timeout'));

    const result = await runVerifiedCallerSyncCycle();

    // Verification was still recorded by syncCallerIdStatus; only the toast
    // is best-effort. We must not stall the cycle on a slot-claim failure.
    expect(result.verified).toBe(1);
    expect(result.notificationsSent).toBe(0);
    expect(result.notificationsThrottled).toBe(0);
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
  });

  it('does not stall the cycle when the audit-log write itself fails', async () => {
    const pending = makePending();
    listPendingCallersToSyncMock.mockResolvedValueOnce([pending]);
    syncCallerIdStatusMock.mockResolvedValueOnce({ ...pending, status: 'failed' });
    writeAuditLogMock.mockRejectedValueOnce(new Error('audit_logs INSERT failed'));

    const result = await runVerifiedCallerSyncCycle();

    // Audit log is best-effort; the DB row was already flipped to failed
    // by syncCallerIdStatus, so the cycle stats must still reflect that.
    expect(result.failed).toBe(1);
    expect(result.errors).toBe(0);
  });
});
