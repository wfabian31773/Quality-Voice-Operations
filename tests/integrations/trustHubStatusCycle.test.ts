import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  TrustHubResourceSnapshot,
  TrustHubSnapshot,
} from '../../platform/telephony/TrustHubService';
import type { VerifiedCallerId } from '../../platform/telephony/TrustedCallerService';

// ---- platform/db ------------------------------------------------------------
const queryMock = vi.fn(async () => ({ rows: [] as Array<{ name: string }> }));
vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

// ---- platform/email ---------------------------------------------------------
const sendEmailMock = vi.fn(async () => ({ success: true }));
const verifiedCallerTrustHubRejectedEmailMock = vi.fn(
  (_args: {
    tenantName?: string;
    phoneNumber: string;
    friendlyName?: string | null;
    resourceLabel:
      | 'Customer Profile'
      | 'SHAKEN/STIR Trust Product'
      | 'A2P Brand Registration';
    failureReason: string;
    trustedCallersUrl: string;
  }) => ({
    subject: 'Trust Hub rejected',
    html: '<p>rejected</p>',
    text: 'rejected',
  }),
);
vi.mock('../../platform/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...(args as [])),
  verifiedCallerExpiringEmail: () => ({ subject: 'expiring', html: '', text: '' }),
  verifiedCallerRevokedEmail: () => ({ subject: 'revoked', html: '', text: '' }),
  verifiedCallerTrustHubRejectedEmail: (args: Parameters<typeof verifiedCallerTrustHubRejectedEmailMock>[0]) =>
    verifiedCallerTrustHubRejectedEmailMock(args),
}));

// ---- notifications ----------------------------------------------------------
interface FanoutPayload {
  tenantId: string;
  type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  category: string;
  userIds?: string[];
}

const fanoutInAppNotificationMock = vi.fn(async (_payload: FanoutPayload) => 1);
const filterEmailRecipientsByPreferenceMock = vi.fn(
  async (_tenantId: string, recipients: string[], _category: string) => recipients,
);
vi.mock('../../platform/notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: (payload: FanoutPayload) =>
    fanoutInAppNotificationMock(payload),
  filterEmailRecipientsByPreference: (
    tenantId: string,
    recipients: string[],
    category: string,
  ) => filterEmailRecipientsByPreferenceMock(tenantId, recipients, category),
}));

// ---- alert recipients -------------------------------------------------------
const getTenantAlertEmailRecipientsMock = vi.fn(async () => ({
  emails: ['admin@example.com'],
  userIds: ['user-1'],
}));
vi.mock('../../platform/integrations/connectors/ConnectorAlertRecipients', () => ({
  getTenantAlertEmailRecipients: (...args: unknown[]) =>
    getTenantAlertEmailRecipientsMock(...(args as [])),
}));

// ---- TrustedCallerService ---------------------------------------------------
const listCallersWithPendingTrustHubMock = vi.fn(
  async (_limit?: number): Promise<VerifiedCallerId[]> => [],
);
const attachTrustHubRegistrationMock = vi.fn(
  async (
    _tenantId: string,
    _callerId: string,
    _snapshot: TrustHubSnapshot,
    _opts: { source?: 'submit' | 'sync' },
  ): Promise<void> => undefined,
);
const promoteCallerAttestationMock = vi.fn(
  async (_tenantId: string, _callerId: string, _level: 'A' | 'B' | 'C') => true,
);
const readTrustHubSnapshotMock = vi.fn(
  (caller: VerifiedCallerId): TrustHubSnapshot | null => {
    const meta = (caller.metadata as { trustHub?: TrustHubSnapshot } | undefined)
      ?.trustHub;
    return meta ?? null;
  },
);

vi.mock('../../platform/telephony/TrustedCallerService', () => ({
  EXPIRING_SOON_THRESHOLD_DAYS: 14,
  checkCallerHealth: vi.fn(),
  claimExpiryAlertSlot: vi.fn(async () => true),
  listCallersDueForHealthCheck: vi.fn(async () => []),
  recordCallerHealth: vi.fn(async () => undefined),
  attachTrustHubRegistration: (
    tenantId: string,
    callerId: string,
    snapshot: TrustHubSnapshot,
    opts: { source?: 'submit' | 'sync' },
  ) => attachTrustHubRegistrationMock(tenantId, callerId, snapshot, opts),
  listCallersWithPendingTrustHub: (limit?: number) =>
    listCallersWithPendingTrustHubMock(limit),
  promoteCallerAttestation: (tenantId: string, callerId: string, level: 'A' | 'B' | 'C') =>
    promoteCallerAttestationMock(tenantId, callerId, level),
  readTrustHubSnapshot: (caller: VerifiedCallerId) => readTrustHubSnapshotMock(caller),
}));

// ---- TrustHubService --------------------------------------------------------
const fetchTrustHubStatusMock = vi.fn(async (): Promise<TrustHubSnapshot | null> => null);
vi.mock('../../platform/telephony/TrustHubService', () => ({
  fetchTrustHubStatus: () => fetchTrustHubStatusMock(),
  simplifyStatus: (s: string | null | undefined) =>
    s ? String(s).toLowerCase() : null,
}));

import {
  runTrustHubStatusCycle,
  dispatchTrustHubRejectionAlert,
} from '../../platform/telephony/VerifiedCallerHealthScheduler';

// ---- fixtures ---------------------------------------------------------------
function makeResource(
  sid: string,
  status: string | null,
  failureReason: string | null = null,
): TrustHubResourceSnapshot {
  return { sid, status, failureReason, validUntil: null };
}

function makeSnapshot(overrides: Partial<TrustHubSnapshot> = {}): TrustHubSnapshot {
  return {
    customerProfile: makeResource('BUccc', 'twilio-approved'),
    trustProduct: makeResource('BUaaa', 'pending-review'),
    brand: makeResource('BNbbb', 'PENDING'),
    businessInfoEndUserSid: null,
    addressEndUserSid: null,
    representativeEndUserSid: null,
    ...overrides,
  };
}

function makeCaller(overrides: Partial<VerifiedCallerId> = {}): VerifiedCallerId {
  const base = {
    id: 'caller-1',
    tenantId: 'tenant-1',
    phoneNumber: '+12125550123',
    friendlyName: 'Sales Line',
    attestationLevel: 'B' as 'A' | 'B' | 'C',
    trustHubProfileSid: 'BUccc',
    trustProductSid: 'BUaaa',
    brandSid: 'BNbbb',
    metadata: { trustHub: makeSnapshot() } as Record<string, unknown>,
    // Other VerifiedCallerId fields are not consulted by the scheduler;
    // cast at the boundary to keep the helper concise.
  } as unknown as VerifiedCallerId;
  return { ...base, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  fanoutInAppNotificationMock.mockResolvedValue(1);
  filterEmailRecipientsByPreferenceMock.mockImplementation(
    async (_tenantId, recipients) => recipients,
  );
  sendEmailMock.mockResolvedValue({ success: true });
  getTenantAlertEmailRecipientsMock.mockResolvedValue({
    emails: ['admin@example.com'],
    userIds: ['user-1'],
  });
  promoteCallerAttestationMock.mockResolvedValue(true);
  attachTrustHubRegistrationMock.mockResolvedValue(undefined);
  // tenant-name lookup uses the mocked pool
  queryMock.mockResolvedValue({ rows: [{ name: 'Acme Co' }] });
  // Default: empty queue (each test that wants pending callers must
  // override via mockResolvedValueOnce).
  listCallersWithPendingTrustHubMock.mockResolvedValue([]);
});

describe('runTrustHubStatusCycle', () => {
  it('returns empty stats when no pending bundles exist', async () => {
    listCallersWithPendingTrustHubMock.mockResolvedValueOnce([]);
    const stats = await runTrustHubStatusCycle();
    expect(stats.inspected).toBe(0);
    expect(stats.refreshed).toBe(0);
    expect(fetchTrustHubStatusMock).not.toHaveBeenCalled();
  });

  it('persists snapshot and stays quiet when nothing changed', async () => {
    const caller = makeCaller();
    listCallersWithPendingTrustHubMock.mockResolvedValueOnce([caller]);
    fetchTrustHubStatusMock.mockResolvedValueOnce(makeSnapshot());

    const stats = await runTrustHubStatusCycle();

    expect(stats.inspected).toBe(1);
    expect(stats.refreshed).toBe(1);
    expect(stats.unchanged).toBe(1);
    expect(stats.rejectionsAlerted).toBe(0);
    expect(stats.approvalsPromoted).toBe(0);
    expect(attachTrustHubRegistrationMock).toHaveBeenCalledWith(
      caller.tenantId,
      caller.id,
      expect.any(Object),
      { source: 'sync' },
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(promoteCallerAttestationMock).not.toHaveBeenCalled();
  });

  it('alerts and emails when trust product flips to twilio-rejected', async () => {
    const caller = makeCaller();
    listCallersWithPendingTrustHubMock.mockResolvedValueOnce([caller]);
    fetchTrustHubStatusMock.mockResolvedValueOnce(
      makeSnapshot({
        trustProduct: makeResource(
          'BUaaa',
          'twilio-rejected',
          'Business name does not match Secretary of State filing',
        ),
      }),
    );

    const stats = await runTrustHubStatusCycle();

    expect(stats.rejectionsAlerted).toBe(1);
    expect(stats.emailedRecipients).toBe(1);
    expect(verifiedCallerTrustHubRejectedEmailMock).toHaveBeenCalledTimes(1);
    const tplArgs = verifiedCallerTrustHubRejectedEmailMock.mock.calls[0][0];
    expect(tplArgs.failureReason).toContain('Secretary of State');
    expect(tplArgs.resourceLabel).toBe('SHAKEN/STIR Trust Product');
    expect(fanoutInAppNotificationMock).toHaveBeenCalledTimes(1);
    const fanoutArgs = fanoutInAppNotificationMock.mock.calls[0][0];
    expect(fanoutArgs.type).toBe('trusted_caller_trust_hub_rejected');
    expect(fanoutArgs.metadata.failureReason).toContain('Secretary of State');
    expect(promoteCallerAttestationMock).not.toHaveBeenCalled();
  });

  it('does not re-alert when prior snapshot was already rejected', async () => {
    const rejectedSnapshot = makeSnapshot({
      trustProduct: makeResource('BUaaa', 'twilio-rejected', 'old reason'),
    });
    const caller = makeCaller({
      metadata: { trustHub: rejectedSnapshot } as Record<string, unknown>,
    });
    listCallersWithPendingTrustHubMock.mockResolvedValueOnce([caller]);
    fetchTrustHubStatusMock.mockResolvedValueOnce(rejectedSnapshot);

    const stats = await runTrustHubStatusCycle();

    expect(stats.rejectionsAlerted).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(verifiedCallerTrustHubRejectedEmailMock).not.toHaveBeenCalled();
  });

  it('promotes attestation level to A when trust product flips to twilio-approved', async () => {
    const caller = makeCaller({ attestationLevel: 'B' });
    listCallersWithPendingTrustHubMock.mockResolvedValueOnce([caller]);
    fetchTrustHubStatusMock.mockResolvedValueOnce(
      makeSnapshot({
        trustProduct: makeResource('BUaaa', 'twilio-approved'),
        brand: makeResource('BNbbb', 'APPROVED'),
      }),
    );

    const stats = await runTrustHubStatusCycle();

    expect(stats.approvalsPromoted).toBe(1);
    expect(promoteCallerAttestationMock).toHaveBeenCalledWith(
      caller.tenantId,
      caller.id,
      'A',
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(fanoutInAppNotificationMock).toHaveBeenCalledTimes(1);
    expect(fanoutInAppNotificationMock.mock.calls[0][0].type).toBe(
      'trusted_caller_trust_hub_approved',
    );
  });

  it('does not promote when trust product was already approved before the cycle', async () => {
    const approvedSnapshot = makeSnapshot({
      trustProduct: makeResource('BUaaa', 'twilio-approved'),
    });
    const caller = makeCaller({
      metadata: { trustHub: approvedSnapshot } as Record<string, unknown>,
    });
    listCallersWithPendingTrustHubMock.mockResolvedValueOnce([caller]);
    fetchTrustHubStatusMock.mockResolvedValueOnce(approvedSnapshot);

    const stats = await runTrustHubStatusCycle();

    expect(stats.approvalsPromoted).toBe(0);
    expect(promoteCallerAttestationMock).not.toHaveBeenCalled();
  });

  it('preserves prior state when Twilio returns an empty snapshot for a caller with all SIDs set', async () => {
    const caller = makeCaller();
    listCallersWithPendingTrustHubMock.mockResolvedValueOnce([caller]);
    fetchTrustHubStatusMock.mockResolvedValueOnce(
      makeSnapshot({
        customerProfile: makeResource('BUccc', null),
        trustProduct: makeResource('BUaaa', null),
        brand: makeResource('BNbbb', null),
      }),
    );

    const stats = await runTrustHubStatusCycle();

    expect(stats.fetchFailures).toBe(1);
    expect(stats.refreshed).toBe(0);
    expect(attachTrustHubRegistrationMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('continues processing remaining callers when one fetch throws', async () => {
    const callerA = makeCaller({ id: 'caller-a' });
    const callerB = makeCaller({ id: 'caller-b', phoneNumber: '+12125550999' });
    listCallersWithPendingTrustHubMock.mockResolvedValueOnce([callerA, callerB]);
    fetchTrustHubStatusMock
      .mockRejectedValueOnce(new Error('twilio 503'))
      .mockResolvedValueOnce(
        makeSnapshot({
          trustProduct: makeResource('BUaaa', 'twilio-rejected', 'EIN mismatch'),
        }),
      );

    const stats = await runTrustHubStatusCycle();

    expect(stats.inspected).toBe(2);
    expect(stats.fetchFailures).toBe(1);
    expect(stats.refreshed).toBe(1);
    expect(stats.rejectionsAlerted).toBe(1);
  });

  it('respects email preference filter — skips email but still fans out in-app on rejection', async () => {
    filterEmailRecipientsByPreferenceMock.mockResolvedValueOnce([]);
    const caller = makeCaller();
    listCallersWithPendingTrustHubMock.mockResolvedValueOnce([caller]);
    fetchTrustHubStatusMock.mockResolvedValueOnce(
      makeSnapshot({
        trustProduct: makeResource('BUaaa', 'twilio-rejected', 'EIN mismatch'),
      }),
    );

    const stats = await runTrustHubStatusCycle();

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(fanoutInAppNotificationMock).toHaveBeenCalledTimes(1);
    expect(stats.rejectionsAlerted).toBe(0);
    expect(stats.emailedRecipients).toBe(0);
  });

  it('drains queues larger than a single batch — processes 450 pending callers across multiple pages', async () => {
    // Three full pages: page 1 = 200 fresh, page 2 = 200 fresh, page 3 = 50 fresh.
    // After processing all 450 the next list call returns rows we've already
    // seen (the SQL predicate hasn't excluded them yet because lastSyncedAt is
    // mocked through), so the cycle exits cleanly via the `seenIds` guard.
    const page1 = Array.from({ length: 200 }, (_, i) =>
      makeCaller({ id: `caller-p1-${i}`, phoneNumber: `+1212555${String(i).padStart(4, '0')}` }),
    );
    const page2 = Array.from({ length: 200 }, (_, i) =>
      makeCaller({ id: `caller-p2-${i}`, phoneNumber: `+1213555${String(i).padStart(4, '0')}` }),
    );
    const page3 = Array.from({ length: 50 }, (_, i) =>
      makeCaller({ id: `caller-p3-${i}`, phoneNumber: `+1214555${String(i).padStart(4, '0')}` }),
    );

    listCallersWithPendingTrustHubMock
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce(page3)
      // Subsequent calls would return rows we've already seen — simulate
      // that by replaying page3 (all already in seenIds → loop breaks).
      .mockResolvedValue(page3);

    fetchTrustHubStatusMock.mockResolvedValue(makeSnapshot());

    const stats = await runTrustHubStatusCycle();

    expect(stats.inspected).toBe(450);
    expect(stats.refreshed).toBe(450);
    expect(fetchTrustHubStatusMock).toHaveBeenCalledTimes(450);
    // Three "fresh" pages drained, then the 4th returns only seen IDs and the
    // loop exits — so listCallersWithPendingTrustHub is called exactly four times.
    expect(listCallersWithPendingTrustHubMock).toHaveBeenCalledTimes(4);
  });
});

describe('dispatchTrustHubRejectionAlert', () => {
  it('returns no_recipients when alert recipients lookup is empty', async () => {
    getTenantAlertEmailRecipientsMock.mockResolvedValueOnce({ emails: [], userIds: [] });
    const result = await dispatchTrustHubRejectionAlert({
      caller: makeCaller(),
      transition: {
        resource: 'brand',
        prior: makeResource('BNbbb', 'PENDING'),
        next: makeResource('BNbbb', 'FAILED', 'TCR rejected EIN'),
      },
    });
    expect(result.status).toBe('no_recipients');
    expect(result.emailedRecipients).toBe(0);
    // in-app fanout still attempted (best-effort)
    expect(fanoutInAppNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic failure reason string when Twilio omits one', async () => {
    await dispatchTrustHubRejectionAlert({
      caller: makeCaller(),
      transition: {
        resource: 'customerProfile',
        prior: makeResource('BUccc', 'pending-review'),
        next: makeResource('BUccc', 'twilio-rejected', ''),
      },
    });
    const tplArgs = verifiedCallerTrustHubRejectedEmailMock.mock.calls[0][0];
    expect(tplArgs.failureReason).toMatch(/did not return a specific failure reason/i);
  });
});
