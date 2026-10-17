import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  clientQuery: vi.fn(async () => ({ rows: [], rowCount: 1 })),
  fake: null as null | import('../actions/sms/__fixtures__/fakeSmsChokepoint').FakeSmsChokepoint,
}));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: h.clientQuery, release: vi.fn() }) }),
  withTenantContext: async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../email/EmailService', () => ({ sendEmail: vi.fn() }));
// The real `sms.send` action over an in-memory store and a mocked transport.
vi.mock('../actions/sms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../actions/sms')>();
  return {
    ...actual,
    sendSystemSms: (req: Parameters<typeof actual.sendSystemSms>[0]) => actual.sendSystemSms(req, h.fake!.options),
  };
});

import { createFakeSmsChokepoint } from '../actions/sms/__fixtures__/fakeSmsChokepoint';
import { sendUrgentSmsAlert } from './NotificationService';
import type { AutopilotRecommendation } from './types';

const TO = '+13125550142';
const rec = {
  id: 'rec-1',
  title: 'Disable broken workflow',
  situationSummary: 'A high-risk workflow is firing repeatedly.',
  riskTier: 'high',
} as AutopilotRecommendation;

function notificationInserts() {
  return h.clientQuery.mock.calls.filter(([sql]) => /INSERT INTO autopilot_notifications/.test(String(sql)));
}

beforeEach(() => {
  h.clientQuery.mockClear();
  h.fake = createFakeSmsChokepoint();
});

describe('sendUrgentSmsAlert through the sms.send chokepoint', () => {
  it('sends the same alert text as a system template and records the notification', async () => {
    await sendUrgentSmsAlert('tenant-1', rec, TO);
    expect(h.fake!.transport.send).toHaveBeenCalledTimes(1);
    expect(h.fake!.transport.send.mock.calls[0][0]).toMatchObject({
      to: TO,
      body: '[QVO Autopilot] HIGH RISK: Disable broken workflow. A high-risk workflow is firing repeatedly.. Log in to review.',
    });
    const [row] = [...h.fake!.rows.values()];
    expect(row.metadata).toMatchObject({
      templateKey: 'autopilot_alert',
      actor: { type: 'system', id: 'autopilot-notifier' },
      relatedEntity: { type: 'autopilot_recommendation', id: 'rec-1' },
    });
    expect(notificationInserts()).toHaveLength(1);
  });

  it('does not text an opted-out recipient, but still records the notification as before', async () => {
    h.fake!.state.optedOut.add(TO);
    await sendUrgentSmsAlert('tenant-1', rec, TO);
    expect(h.fake!.transport.send).not.toHaveBeenCalled();
    expect(notificationInserts()).toHaveLength(1);
  });

  it('does not send while messaging is off', async () => {
    h.fake!.state.smsEnabled = false;
    await sendUrgentSmsAlert('tenant-1', rec, TO);
    expect(h.fake!.transport.send).not.toHaveBeenCalled();
    expect(notificationInserts()).toHaveLength(1);
  });

  it('logs a Twilio failure without throwing, as before', async () => {
    h.fake!.state.sendError = new Error('network down');
    await expect(sendUrgentSmsAlert('tenant-1', rec, TO)).resolves.toBeUndefined();
    expect(h.fake!.transport.send).toHaveBeenCalledTimes(1);
    expect(notificationInserts()).toHaveLength(1);
  });
});
