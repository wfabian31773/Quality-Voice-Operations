/**
 * Losing leadership must abort an in-flight campaign tick so it cannot
 * place further outbound dials after the advisory lock is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  getRunningCampaigns,
  getNextPendingContact,
  updateContactStatus,
  revertContactToPending,
  checkCampaignCompletion,
  registerCallSid,
  getActiveDialingCount,
  getTenantActiveDialingCount,
  getTenantMaxConcurrent,
  incrementQuietHoursSkips,
  dialContact,
  isContactOnDnc,
} = vi.hoisted(() => ({
  getRunningCampaigns: vi.fn(),
  getNextPendingContact: vi.fn(),
  updateContactStatus: vi.fn(),
  revertContactToPending: vi.fn(),
  checkCampaignCompletion: vi.fn(),
  registerCallSid: vi.fn(),
  getActiveDialingCount: vi.fn(),
  getTenantActiveDialingCount: vi.fn(),
  getTenantMaxConcurrent: vi.fn(),
  incrementQuietHoursSkips: vi.fn(),
  dialContact: vi.fn(),
  isContactOnDnc: vi.fn(),
}));

vi.mock('../core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('./CampaignService', () => ({
  getRunningCampaigns,
  getNextPendingContact,
  updateContactStatus,
  revertContactToPending,
  checkCampaignCompletion,
  registerCallSid,
  getActiveDialingCount,
  getTenantActiveDialingCount,
  getTenantMaxConcurrent,
  incrementQuietHoursSkips,
}));

vi.mock('./OutboundDialer', () => ({ dialContact }));
vi.mock('./ComplianceService', () => ({
  isContactOnDnc,
  writeFederalDncBlockAuditLog: vi.fn(),
}));
vi.mock('./QuietHours', () => ({
  evaluateQuietHours: () => ({ allowed: true, timezone: 'America/Chicago' }),
}));
vi.mock('../telephony/TrustedCallerService', () => ({
  resolveCampaignCallerId: vi.fn(async () => null),
}));

import { CampaignScheduler } from './CampaignScheduler';

const campaign = {
  id: 'camp-1',
  tenantId: 't1',
  agentId: 'agent-1',
  config: { maxConcurrent: 5, maxAttempts: 3, retryDelayMinutes: 30, respectContactTimezone: true },
};

function contact(id: string) {
  return {
    id,
    tenantId: 't1',
    campaignId: 'camp-1',
    phoneNumber: '+13125550100',
    name: null,
    status: 'pending' as const,
    outcome: null,
    attemptCount: 0,
    lastAttemptedAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  getRunningCampaigns.mockReset().mockResolvedValue([campaign]);
  getTenantActiveDialingCount.mockReset().mockResolvedValue(0);
  getTenantMaxConcurrent.mockReset().mockResolvedValue(10);
  getActiveDialingCount.mockReset().mockResolvedValue(0);
  getNextPendingContact.mockReset();
  updateContactStatus.mockReset().mockResolvedValue(undefined);
  revertContactToPending.mockReset().mockResolvedValue(undefined);
  checkCampaignCompletion.mockReset().mockResolvedValue(undefined);
  registerCallSid.mockReset().mockResolvedValue(undefined);
  incrementQuietHoursSkips.mockReset().mockResolvedValue(undefined);
  isContactOnDnc.mockReset().mockResolvedValue({ onDnc: false });
  dialContact.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CampaignScheduler leadership fence', () => {
  it('does not dial after stop() while a tick is awaiting campaigns', async () => {
    let releaseCampaigns!: (value: typeof campaign[]) => void;
    getRunningCampaigns.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCampaigns = resolve;
        }),
    );
    getNextPendingContact.mockResolvedValueOnce(contact('c1')).mockResolvedValue(null);
    dialContact.mockResolvedValue({ success: true, callSid: 'CA1' });

    const scheduler = new CampaignScheduler({
      pollIntervalMs: 15_000,
      outboundCallbackBaseUrl: 'https://voice.example.com',
      statusCallbackUrl: 'https://voice.example.com/twilio/status',
    });
    scheduler.start();
    scheduler.stop();
    releaseCampaigns([campaign]);
    await vi.advanceTimersByTimeAsync(0);

    expect(dialContact).not.toHaveBeenCalled();
    expect(getNextPendingContact).not.toHaveBeenCalled();
  });

  it('does not place a further dial after stop() while awaiting Twilio', async () => {
    let releaseDial!: (value: { success: boolean; callSid: string }) => void;
    let notifyFirstDial: () => void = () => {};
    const firstDialSeen = new Promise<void>((resolve) => {
      notifyFirstDial = resolve;
    });
    dialContact.mockImplementationOnce(
      () =>
        new Promise((res) => {
          notifyFirstDial();
          releaseDial = res;
        }),
    );
    getNextPendingContact
      .mockResolvedValueOnce(contact('c1'))
      .mockResolvedValueOnce(contact('c2'))
      .mockResolvedValue(null);

    const scheduler = new CampaignScheduler({
      pollIntervalMs: 15_000,
      outboundCallbackBaseUrl: 'https://voice.example.com',
      statusCallbackUrl: 'https://voice.example.com/twilio/status',
    });
    scheduler.start();
    await firstDialSeen;

    scheduler.stop();
    releaseDial({ success: true, callSid: 'CA1' });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(dialContact).toHaveBeenCalledTimes(1);
    expect(revertContactToPending).not.toHaveBeenCalled();
  });

  it('reverts a claimed, undialed contact when leadership is lost after pickup', async () => {
    let releaseContact!: (value: ReturnType<typeof contact> | null) => void;
    let notifyPickup: () => void = () => {};
    const pickupSeen = new Promise<void>((resolve) => {
      notifyPickup = resolve;
    });
    getNextPendingContact.mockImplementationOnce(
      () =>
        new Promise((res) => {
          notifyPickup();
          releaseContact = res;
        }),
    );
    dialContact.mockResolvedValue({ success: true, callSid: 'CA1' });

    const scheduler = new CampaignScheduler({
      pollIntervalMs: 15_000,
      outboundCallbackBaseUrl: 'https://voice.example.com',
      statusCallbackUrl: 'https://voice.example.com/twilio/status',
    });
    scheduler.start();
    await pickupSeen;

    scheduler.stop();
    releaseContact(contact('c1'));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(dialContact).not.toHaveBeenCalled();
    expect(revertContactToPending).toHaveBeenCalledWith('t1', 'c1');
  });
});
