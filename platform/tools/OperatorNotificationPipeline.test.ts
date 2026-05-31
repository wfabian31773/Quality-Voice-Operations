import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createInAppNotificationMock } = vi.hoisted(() => ({ createInAppNotificationMock: vi.fn() }));

vi.mock('../autopilot/NotificationService', () => ({ createInAppNotification: createInAppNotificationMock }));

import {
  setOperatorSmsRecipients,
  getOperatorSmsRecipients,
  initOperatorNotificationPipeline,
} from './OperatorNotificationPipeline';
import { executeWithRetry } from './RetryOrchestrator';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 25));
};

const failOnce = (tenantId: string) =>
  executeWithRetry(async () => { throw new Error('kaboom error detail'); }, {
    tenantId,
    toolName: 'createServiceTicket',
    callSessionId: 'cs-abcdef12',
    retryConfig: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000, backoffMultiplier: 2 },
  });

beforeEach(() => {
  createInAppNotificationMock.mockReset();
  createInAppNotificationMock.mockResolvedValue(undefined);
});

describe('operator SMS recipients', () => {
  it('stores and retrieves recipients per tenant', () => {
    expect(getOperatorSmsRecipients('tenant-empty')).toEqual([]);
    setOperatorSmsRecipients('tenant-1', ['+15550001111', '+15550002222']);
    expect(getOperatorSmsRecipients('tenant-1')).toEqual(['+15550001111', '+15550002222']);
  });
});

describe('initOperatorNotificationPipeline', () => {
  it('is idempotent', () => {
    expect(() => {
      initOperatorNotificationPipeline();
      initOperatorNotificationPipeline();
    }).not.toThrow();
  });

  it('creates an in-app notification on a final tool failure', async () => {
    initOperatorNotificationPipeline();
    await failOnce('tenant-noti');
    await flush();
    expect(createInAppNotificationMock).toHaveBeenCalledWith(
      'tenant-noti',
      expect.objectContaining({ severity: 'critical', title: expect.stringContaining('createServiceTicket') }),
    );
  });

  describe('with SMS configured', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'tok';
      process.env.TWILIO_SMS_FROM = '+15559990000';
      fetchMock.mockReset();
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_SMS_FROM;
      vi.unstubAllGlobals();
    });

    it('sends an SMS alert to each configured recipient', async () => {
      initOperatorNotificationPipeline();
      setOperatorSmsRecipients('tenant-sms', ['+15551112222']);
      await failOnce('tenant-sms');
      await flush();
      expect(fetchMock).toHaveBeenCalled();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(String(url)).toContain('api.twilio.com');
      expect(opts.method).toBe('POST');
    });
  });
});
