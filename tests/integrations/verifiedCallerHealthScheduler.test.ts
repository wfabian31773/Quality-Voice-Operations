import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn(async () => ({ rows: [] }));
vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

const sendEmailMock = vi.fn(async () => ({ success: true }));
vi.mock('../../platform/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...(args as [])),
  verifiedCallerExpiringEmail: () => ({
    subject: 'expiring',
    html: '<p>expiring</p>',
    text: 'expiring',
  }),
  verifiedCallerRevokedEmail: () => ({
    subject: 'revoked',
    html: '<p>revoked</p>',
    text: 'revoked',
  }),
}));

const fanoutInAppNotificationMock = vi.fn(async () => 1);
const filterEmailRecipientsByPreferenceMock = vi.fn(
  async (_tenantId: string, recipients: string[]) => recipients,
);
vi.mock('../../platform/notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: (...args: unknown[]) =>
    fanoutInAppNotificationMock(...(args as [])),
  filterEmailRecipientsByPreference: (...args: unknown[]) =>
    filterEmailRecipientsByPreferenceMock(...(args as [string, string[]])),
}));

const getTenantAlertEmailRecipientsMock = vi.fn(async () => ({
  emails: ['admin@example.com'],
  userIds: ['user-1'],
}));
vi.mock('../../platform/integrations/connectors/ConnectorAlertRecipients', () => ({
  getTenantAlertEmailRecipients: (...args: unknown[]) =>
    getTenantAlertEmailRecipientsMock(...(args as [])),
}));

interface MockCaller {
  id: string;
  tenantId: string;
  phoneNumber: string;
  friendlyName: string | null;
  trustProductSid: string | null;
  brandSid: string | null;
}

const checkCallerHealthMock = vi.fn();
const listCallersDueForHealthCheckMock = vi.fn();
const recordCallerHealthMock = vi.fn(async () => undefined);
const claimExpiryAlertSlotMock = vi.fn(async () => true);

vi.mock('../../platform/telephony/TrustedCallerService', () => ({
  EXPIRING_SOON_THRESHOLD_DAYS: 14,
  checkCallerHealth: (...args: unknown[]) =>
    checkCallerHealthMock(...(args as [])),
  claimExpiryAlertSlot: (...args: unknown[]) =>
    claimExpiryAlertSlotMock(...(args as [string, string, number])),
  listCallersDueForHealthCheck: (...args: unknown[]) =>
    listCallersDueForHealthCheckMock(...(args as [number, number])),
  recordCallerHealth: (...args: unknown[]) =>
    recordCallerHealthMock(...(args as [string, string, unknown])),
}));

import {
  runVerifiedCallerHealthCycle,
  dispatchVerifiedCallerAlert,
} from '../../platform/telephony/VerifiedCallerHealthScheduler';

function makeCaller(overrides: Partial<MockCaller> = {}): MockCaller {
  return {
    id: 'caller-1',
    tenantId: 'tenant-1',
    phoneNumber: '+12125550123',
    friendlyName: 'Sales Line',
    trustProductSid: 'BUaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    brandSid: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM tenants')) {
      return { rows: [{ name: 'Acme Corp' }] };
    }
    return { rows: [] };
  });
  sendEmailMock.mockImplementation(async () => ({ success: true }));
  fanoutInAppNotificationMock.mockImplementation(async () => 1);
  filterEmailRecipientsByPreferenceMock.mockImplementation(
    async (_tenantId: string, recipients: string[]) => recipients,
  );
  getTenantAlertEmailRecipientsMock.mockImplementation(async () => ({
    emails: ['admin@example.com'],
    userIds: ['user-1'],
  }));
  claimExpiryAlertSlotMock.mockImplementation(async () => true);
  recordCallerHealthMock.mockImplementation(async () => undefined);
});

describe('runVerifiedCallerHealthCycle', () => {
  it('records healthy result without dispatching an alert', async () => {
    listCallersDueForHealthCheckMock.mockResolvedValueOnce([makeCaller()]);
    checkCallerHealthMock.mockResolvedValueOnce({
      status: 'healthy',
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      message: null,
      demoteAttestation: false,
    });

    const result = await runVerifiedCallerHealthCycle();

    expect(result.inspected).toBe(1);
    expect(result.recorded).toBe(1);
    expect(result.alertsSent).toBe(0);
    expect(recordCallerHealthMock).toHaveBeenCalledTimes(1);
    expect(claimExpiryAlertSlotMock).not.toHaveBeenCalled();
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips alert dispatch for unknown status (transient Twilio outage)', async () => {
    listCallersDueForHealthCheckMock.mockResolvedValueOnce([makeCaller()]);
    checkCallerHealthMock.mockResolvedValueOnce({
      status: 'unknown',
      expiresAt: null,
      message: 'Twilio creds missing',
      demoteAttestation: false,
    });

    const result = await runVerifiedCallerHealthCycle();

    expect(result.inspected).toBe(1);
    expect(result.recorded).toBe(1);
    expect(result.unknown).toBe(1);
    expect(result.alertsSent).toBe(0);
    expect(claimExpiryAlertSlotMock).not.toHaveBeenCalled();
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
  });

  it('dispatches in-app + email alert on expiring_soon', async () => {
    const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    listCallersDueForHealthCheckMock.mockResolvedValueOnce([makeCaller()]);
    checkCallerHealthMock.mockResolvedValueOnce({
      status: 'expiring_soon',
      expiresAt,
      message: 'Trust Hub product expires in 5 days',
      demoteAttestation: false,
    });

    const result = await runVerifiedCallerHealthCycle();

    expect(result.alertsSent).toBe(1);
    expect(result.emailedRecipients).toBe(1);
    expect(claimExpiryAlertSlotMock).toHaveBeenCalledWith(
      'caller-1',
      'tenant-1',
      expect.any(Number),
    );
    expect(fanoutInAppNotificationMock).toHaveBeenCalledTimes(1);
    expect(fanoutInAppNotificationMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      type: 'trusted_caller_expiry',
      category: 'integration',
      userIds: ['user-1'],
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      to: 'admin@example.com',
      subject: 'expiring',
    });
  });

  it('dispatches alert with revoked-specific notification type', async () => {
    listCallersDueForHealthCheckMock.mockResolvedValueOnce([makeCaller()]);
    checkCallerHealthMock.mockResolvedValueOnce({
      status: 'revoked',
      expiresAt: null,
      message: 'Trust Hub product was rejected',
      demoteAttestation: true,
    });

    const result = await runVerifiedCallerHealthCycle();

    expect(result.alertsSent).toBe(1);
    expect(fanoutInAppNotificationMock.mock.calls[0][0]).toMatchObject({
      type: 'trusted_caller_revoked',
      category: 'integration',
    });
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      subject: 'revoked',
    });
  });

  it('honors throttle when slot claim loses the race', async () => {
    listCallersDueForHealthCheckMock.mockResolvedValueOnce([makeCaller()]);
    checkCallerHealthMock.mockResolvedValueOnce({
      status: 'expired',
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      message: 'Already expired',
      demoteAttestation: false,
    });
    claimExpiryAlertSlotMock.mockResolvedValueOnce(false);

    const result = await runVerifiedCallerHealthCycle();

    expect(result.throttled).toBe(1);
    expect(result.alertsSent).toBe(0);
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('still records health when health check throws unexpectedly', async () => {
    listCallersDueForHealthCheckMock.mockResolvedValueOnce([makeCaller()]);
    checkCallerHealthMock.mockRejectedValueOnce(new Error('boom'));

    const result = await runVerifiedCallerHealthCycle();

    expect(result.inspected).toBe(1);
    expect(result.recorded).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.unknown).toBe(1);
    expect(recordCallerHealthMock).toHaveBeenCalledWith(
      'caller-1',
      'tenant-1',
      expect.objectContaining({ status: 'unknown' }),
    );
  });

  it('continues processing after one caller fails', async () => {
    listCallersDueForHealthCheckMock.mockResolvedValueOnce([
      makeCaller({ id: 'caller-1' }),
      makeCaller({ id: 'caller-2', tenantId: 'tenant-2' }),
    ]);
    checkCallerHealthMock
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce({
        status: 'expiring_soon',
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        message: null,
        demoteAttestation: false,
      });

    const result = await runVerifiedCallerHealthCycle();

    expect(result.inspected).toBe(2);
    expect(result.recorded).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.alertsSent).toBe(1);
  });

  it('skips email when no admin recipients are configured', async () => {
    getTenantAlertEmailRecipientsMock.mockResolvedValueOnce({
      emails: [],
      userIds: [],
    });
    listCallersDueForHealthCheckMock.mockResolvedValueOnce([makeCaller()]);
    checkCallerHealthMock.mockResolvedValueOnce({
      status: 'expired',
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      message: null,
      demoteAttestation: false,
    });

    const result = await runVerifiedCallerHealthCycle();

    // The slot was still claimed so we don't re-fire next cycle, in-app
    // still fanned out, but no email went out.
    expect(claimExpiryAlertSlotMock).toHaveBeenCalledTimes(1);
    expect(fanoutInAppNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.alertsSent).toBe(0);
  });

  it('skips email when all recipients have integration emails disabled', async () => {
    filterEmailRecipientsByPreferenceMock.mockResolvedValueOnce([]);
    listCallersDueForHealthCheckMock.mockResolvedValueOnce([makeCaller()]);
    checkCallerHealthMock.mockResolvedValueOnce({
      status: 'expiring_soon',
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      message: null,
      demoteAttestation: false,
    });

    const result = await runVerifiedCallerHealthCycle();

    expect(fanoutInAppNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.alertsSent).toBe(0);
    expect(filterEmailRecipientsByPreferenceMock).toHaveBeenCalledWith(
      'tenant-1',
      ['admin@example.com'],
      'integration',
    );
  });
});

describe('dispatchVerifiedCallerAlert (direct)', () => {
  it('returns throttled when claim is lost without sending anything', async () => {
    claimExpiryAlertSlotMock.mockResolvedValueOnce(false);

    const result = await dispatchVerifiedCallerAlert({
      caller: {
        id: 'c',
        tenantId: 't',
        phoneNumber: '+15555550123',
        friendlyName: null,
        status: 'verified',
        attestationLevel: 'A',
        twilioValidationSid: null,
        twilioCallerSid: null,
        trustHubProfileSid: null,
        trustProductSid: null,
        brandSid: null,
        verificationCode: null,
        verificationExpiresAt: null,
        verifiedAt: null,
        rotatedAt: null,
        rotatedToId: null,
        registeredByUserId: null,
        notes: null,
        metadata: {},
        expiresAt: null,
        lastHealthCheckAt: null,
        lastHealthStatus: null,
        lastHealthMessage: null,
        expiryAlertSentAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      result: {
        status: 'expired',
        expiresAt: new Date(Date.now() - 1000),
        message: null,
        demoteAttestation: false,
      },
    });

    expect(result.status).toBe('throttled');
    expect(fanoutInAppNotificationMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('runVerifiedCallerHealthCycle batching', () => {
  it('drains all due callers across multiple batches in a single cycle', async () => {
    // Simulate 1,250 callers due — well over the 500-row BATCH_SIZE — so
    // we get three full batches (500, 500, 250) and prove every row was
    // processed within ONE cycle. This is the behaviour the weekly SLA
    // depends on: a tenant with >500 verified callers must still see
    // each one re-checked at least weekly, not every 2-3 weeks.
    const TOTAL = 1_250;
    const allCallers = Array.from({ length: TOTAL }, (_, i) =>
      makeCaller({ id: `caller-${i}` }),
    );

    // The scheduler queries the DB once per batch. After each batch, the
    // already-processed rows naturally drop out (production: their
    // `last_health_check_at` is advanced; here: we just slice the
    // remaining slice).
    let cursor = 0;
    listCallersDueForHealthCheckMock.mockImplementation(
      async (_staleMs: number, batchSize: number) => {
        const slice = allCallers.slice(cursor, cursor + batchSize);
        cursor += slice.length;
        return slice;
      },
    );

    checkCallerHealthMock.mockImplementation(async () => ({
      status: 'healthy' as const,
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      message: null,
      demoteAttestation: false,
    }));

    const result = await runVerifiedCallerHealthCycle();

    expect(result.inspected).toBe(TOTAL);
    expect(result.recorded).toBe(TOTAL);
    expect(checkCallerHealthMock).toHaveBeenCalledTimes(TOTAL);
    expect(recordCallerHealthMock).toHaveBeenCalledTimes(TOTAL);
    // 500 + 500 + 250 = 1250 → 3 batch fetches
    expect(listCallersDueForHealthCheckMock).toHaveBeenCalledTimes(3);
  });

  it('bails safely if a full batch of rows keeps reappearing (recordCallerHealth fails for all)', async () => {
    // The cycle naturally short-circuits when a batch comes back smaller
    // than BATCH_SIZE — there can't be more rows behind a partial batch.
    // The dangerous case is a *full* batch where every record write
    // fails, so the same rows would re-appear in the next batch query
    // forever. Verify the already-seen guard catches that and bails on
    // the second iteration without re-processing the same rows.
    const BATCH_SIZE = 500;
    const stuckBatch = Array.from({ length: BATCH_SIZE }, (_, i) =>
      makeCaller({ id: `stuck-${i}` }),
    );
    listCallersDueForHealthCheckMock.mockImplementation(async () => stuckBatch);
    checkCallerHealthMock.mockResolvedValue({
      status: 'healthy',
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      message: null,
      demoteAttestation: false,
    });
    recordCallerHealthMock.mockRejectedValue(new Error('DB write failed'));

    const result = await runVerifiedCallerHealthCycle();

    expect(result.inspected).toBe(BATCH_SIZE);
    expect(result.errors).toBe(BATCH_SIZE);
    // Two queries: first returned the batch, second returned the same
    // batch, the already-seen guard tripped and bailed instead of
    // spinning to MAX_BATCHES_PER_CYCLE.
    expect(listCallersDueForHealthCheckMock).toHaveBeenCalledTimes(2);
    expect(checkCallerHealthMock).toHaveBeenCalledTimes(BATCH_SIZE);
  });
});
