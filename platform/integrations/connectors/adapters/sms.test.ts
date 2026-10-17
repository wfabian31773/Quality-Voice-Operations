import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  recordSmsUsage: vi.fn(async () => undefined),
  fake: null as null | import('../../../actions/sms/__fixtures__/fakeSmsChokepoint').FakeSmsChokepoint,
}));

vi.mock('../../../db', () => ({
  getPlatformPool: () => ({ query: async () => ({ rows: [] }) }),
  withTenantClient: vi.fn(),
  withPrivilegedClient: vi.fn(),
}));
vi.mock('../../../billing/usage/UsageRecorder', () => ({ recordSmsUsage: h.recordSmsUsage }));
// The real `sms.send` action over an in-memory store and a mocked transport.
vi.mock('../../../actions/sms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../actions/sms')>();
  return {
    ...actual,
    sendSystemSms: (req: Parameters<typeof actual.sendSystemSms>[0]) => actual.sendSystemSms(req, h.fake!.options),
  };
});

import { TwilioApiError } from '../../twilio/sender';
import { createFakeSmsChokepoint } from '../../../actions/sms/__fixtures__/fakeSmsChokepoint';
import type { ConnectorConfig } from '../types';
import { TwilioSmsConnectorAdapter } from './sms';

const ON_CALL = '+13125550142';
const config = { credentials: { account_sid: 'AC1', auth_token: 't', from_number: '+13125550100' } } as unknown as ConnectorConfig;

function escalation(timestamp = new Date().toISOString()) {
  return {
    type: 'escalation_notification',
    targetNumber: ON_CALL,
    reason: 'caller upset about a double booking',
    callSessionId: 'cs-1',
    timestamp,
  };
}

const adapter = new TwilioSmsConnectorAdapter();

beforeEach(() => {
  h.recordSmsUsage.mockClear();
  h.fake = createFakeSmsChokepoint();
});

describe('TwilioSmsConnectorAdapter through the sms.send chokepoint', () => {
  it('sends the escalation alert with the same text to the on-call number', async () => {
    const payload = escalation('2026-10-14T15:00:00.000Z');
    // Not "live" any more (an old timestamp), so quiet hours apply normally: allowed here.
    const result = await adapter.execute('tenant-1', config, payload);
    expect(result).toMatchObject({ success: true, externalId: 'SM1', meta: { messageSid: 'SM1' } });
    expect(h.fake!.transport.send.mock.calls[0][0]).toMatchObject({
      to: ON_CALL,
      body: '[ESCALATION ALERT]\nSession: cs-1\nReason: caller upset about a double booking\nTime: 2026-10-14T15:00:00.000Z',
    });
    const [row] = [...h.fake!.rows.values()];
    expect(row.metadata).toMatchObject({ templateKey: 'escalation_alert', actor: { type: 'system', id: 'sms-connector' } });
    expect(h.recordSmsUsage).toHaveBeenCalledWith('tenant-1', 1);
  });

  it('is exempt from quiet hours right after the transfer (live-call window)', async () => {
    h.fake!.state.quietHoursAllowed = false;
    const result = await adapter.execute('tenant-1', config, escalation());
    expect(result.success).toBe(true);
    expect(h.fake!.transport.send).toHaveBeenCalledTimes(1);
  });

  it('does not text an opted-out number', async () => {
    h.fake!.state.optedOut.add(ON_CALL);
    const result = await adapter.execute('tenant-1', config, escalation());
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/^RECIPIENT_OPTED_OUT/);
    expect(h.fake!.transport.send).not.toHaveBeenCalled();
    expect(h.recordSmsUsage).not.toHaveBeenCalled();
  });

  it('does not send while messaging is off', async () => {
    h.fake!.state.tenantEnabled = false;
    const result = await adapter.execute('tenant-1', config, escalation());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^MESSAGING_NOT_ENABLED/);
    expect(h.fake!.transport.send).not.toHaveBeenCalled();
  });

  it('reports a Twilio error as a failed result, as before', async () => {
    h.fake!.state.sendError = new TwilioApiError('Twilio API error: 500 boom', 500, null);
    const result = await adapter.execute('tenant-1', config, escalation());
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('Twilio API error: 500 boom');
  });

  it('refuses free-text connector SMS (template-only) and fails without a destination', async () => {
    const freeText = await adapter.execute('tenant-1', config, { type: 'send_sms', to: ON_CALL, body: 'anything' });
    expect(freeText.success).toBe(false);
    const noTo = await adapter.execute('tenant-1', { credentials: {} } as unknown as ConnectorConfig, {
      type: 'escalation_notification',
    });
    expect(noTo.success).toBe(false);
    expect(h.fake!.transport.send).not.toHaveBeenCalled();
  });
});
