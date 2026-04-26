import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getTenantAlertEmailRecipientsMock,
  getTenantAlertPhoneRecipientsMock,
  sendRecommendationEmailMock,
  sendUrgentSmsAlertMock,
  createInAppNotificationMock,
} = vi.hoisted(() => ({
  getTenantAlertEmailRecipientsMock: vi.fn(),
  getTenantAlertPhoneRecipientsMock: vi.fn(),
  sendRecommendationEmailMock: vi.fn(async () => undefined),
  sendUrgentSmsAlertMock: vi.fn(async () => undefined),
  createInAppNotificationMock: vi.fn(async () => undefined),
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    // notifyHighRiskRecommendation now delegates the recipient lookup to the
    // shared connector helpers, so it should never reach the pool itself.
    // We still expose `connect` so an unrelated import path doesn't blow up
    // if anything in NotificationService needs a client during the test.
    query: vi.fn(),
    connect: async () => ({ query: vi.fn(), release: vi.fn() }),
  }),
  withTenantContext: async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../platform/integrations/connectors/ConnectorAlertRecipients', () => ({
  getTenantAlertEmailRecipients: getTenantAlertEmailRecipientsMock,
  getTenantAlertPhoneRecipients: getTenantAlertPhoneRecipientsMock,
}));

vi.mock('../../platform/autopilot/NotificationService', () => ({
  sendRecommendationEmail: sendRecommendationEmailMock,
  sendUrgentSmsAlert: sendUrgentSmsAlertMock,
  createInAppNotification: createInAppNotificationMock,
}));

const baseRec = {
  id: 'rec-1',
  tenantId: 'tenant-autopilot',
  insightId: null,
  runId: null,
  title: 'Disable broken workflow',
  situationSummary: 'A high-risk workflow is firing repeatedly.',
  recommendedAction: 'Disable the workflow until it is repaired.',
  expectedOutcome: 'Stops the broken workflow from misfiring.',
  reasoning: 'Repeated failures detected.',
  confidenceScore: 0.9,
  riskTier: 'high' as const,
  actionType: 'disable_workflow',
  actionPayload: {},
  estimatedRevenueImpactCents: null,
  estimatedCostSavingsCents: null,
  status: 'pending' as const,
  approvedBy: null,
  approvedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  dismissedBy: null,
  dismissedAt: null,
  expiresAt: null,
  industryPack: null,
  metadata: {},
  createdAt: new Date('2026-04-25T12:00:00Z').toISOString(),
  updatedAt: new Date('2026-04-25T12:00:00Z').toISOString(),
};

beforeEach(() => {
  getTenantAlertEmailRecipientsMock.mockReset();
  getTenantAlertPhoneRecipientsMock.mockReset();
  sendRecommendationEmailMock.mockReset();
  sendUrgentSmsAlertMock.mockReset();
  sendRecommendationEmailMock.mockResolvedValue(undefined);
  sendUrgentSmsAlertMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetModules();
});

describe('notifyHighRiskRecommendation', () => {
  it('delegates recipient lookup to the shared connector helpers and emails / SMS each one', async () => {
    // The shared helpers handle the LEFT JOIN against `user_roles` for us, so
    // here we just assert that the autopilot path uses them and dispatches to
    // every recipient they return — including a tenant_owner who only holds
    // the role through the canonical `user_roles` table.
    getTenantAlertEmailRecipientsMock.mockResolvedValue({
      // 'rbac-owner@acme.test' is the user_roles-only tenant owner. The
      // shared helper is what surfaces them; if the autopilot path stopped
      // using the helper and went back to `users.role IN ('admin', 'owner')`
      // they would silently disappear from this list.
      emails: ['legacy-admin@acme.test', 'rbac-owner@acme.test'],
      userIds: ['user-legacy', 'user-rbac'],
    });
    getTenantAlertPhoneRecipientsMock.mockResolvedValue([
      { id: 'user-rbac', phone_number: '+15551112222' },
    ]);

    const { notifyHighRiskRecommendation } = await import(
      '../../platform/autopilot/AutopilotEngine'
    );

    await notifyHighRiskRecommendation('tenant-autopilot', baseRec);

    // Both helpers were called with a sane per-tenant cap. Any non-trivial
    // limit is fine — what matters is that the autopilot path does not
    // re-implement its own admin lookup with the legacy role gating.
    expect(getTenantAlertEmailRecipientsMock).toHaveBeenCalledWith(
      'tenant-autopilot',
      expect.any(Number),
    );
    expect(getTenantAlertPhoneRecipientsMock).toHaveBeenCalledWith(
      'tenant-autopilot',
      expect.any(Number),
    );

    // Email path reaches both legacy admins AND the user_roles-only owner.
    expect(sendRecommendationEmailMock).toHaveBeenCalledTimes(2);
    const emailedTo = sendRecommendationEmailMock.mock.calls
      .map((c) => c[2])
      .sort();
    expect(emailedTo).toEqual(['legacy-admin@acme.test', 'rbac-owner@acme.test']);

    // SMS path uses the canonical phone_number column — the previous inline
    // query referenced a non-existent `phone` column and silently failed.
    expect(sendUrgentSmsAlertMock).toHaveBeenCalledTimes(1);
    expect(sendUrgentSmsAlertMock.mock.calls[0][2]).toBe('+15551112222');
  });

  it('still emails the remaining recipients when one delivery throws', async () => {
    getTenantAlertEmailRecipientsMock.mockResolvedValue({
      emails: ['ok@acme.test', 'broken@acme.test', 'also-ok@acme.test'],
      userIds: ['u1', 'u2', 'u3'],
    });
    getTenantAlertPhoneRecipientsMock.mockResolvedValue([]);

    sendRecommendationEmailMock.mockImplementation(
      async (_tenantId: string, _rec: unknown, to: string) => {
        if (to === 'broken@acme.test') {
          throw new Error('SMTP down');
        }
      },
    );

    const { notifyHighRiskRecommendation } = await import(
      '../../platform/autopilot/AutopilotEngine'
    );

    await notifyHighRiskRecommendation('tenant-autopilot', baseRec);

    expect(sendRecommendationEmailMock).toHaveBeenCalledTimes(3);
  });

  it('does nothing dramatic when there are no recipients', async () => {
    getTenantAlertEmailRecipientsMock.mockResolvedValue({ emails: [], userIds: [] });
    getTenantAlertPhoneRecipientsMock.mockResolvedValue([]);

    const { notifyHighRiskRecommendation } = await import(
      '../../platform/autopilot/AutopilotEngine'
    );

    await notifyHighRiskRecommendation('tenant-autopilot', baseRec);

    expect(sendRecommendationEmailMock).not.toHaveBeenCalled();
    expect(sendUrgentSmsAlertMock).not.toHaveBeenCalled();
  });
});
