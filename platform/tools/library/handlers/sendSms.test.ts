import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendSystemSms = vi.hoisted(() => vi.fn());

vi.mock('../../../actions/sms', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../actions/sms')>()),
  sendSystemSms,
}));

import { agentSmsIdempotencyKey } from '../../../actions/sms';
import { executeSendSms } from './sendSms';

const ctx = { tenantId: 't1', callSid: 'CA1', callerNumber: '+13125550142', agentSlug: 'barber' };

beforeEach(() => {
  sendSystemSms.mockReset();
});

describe('send_sms tool (thin wrapper over sms.send)', () => {
  it('refuses free-text bodies without calling the chokepoint', async () => {
    const result = await executeSendSms({ toNumber: '+13125550142', body: 'anything the model wants' }, ctx);
    expect(result).toMatchObject({ success: false, code: 'TEMPLATE_REQUIRED' });
    expect(sendSystemSms).not.toHaveBeenCalled();
  });

  it('refuses system-only templates', async () => {
    const result = await executeSendSms({ templateKey: 'ops_alert', vars: { message: 'x' } }, ctx);
    expect(result).toMatchObject({ success: false, code: 'TEMPLATE_REQUIRED' });
    expect(sendSystemSms).not.toHaveBeenCalled();
  });

  it('sends an agent template as a live-call transactional send keyed to the call', async () => {
    sendSystemSms.mockResolvedValue({ ok: true, data: { messageId: 'm1', status: 'queued', twilioSid: 'SM1' } });
    const result = await executeSendSms(
      { templateKey: 'directions', vars: { businessName: 'Fade Lab', address: '12 Main St' } },
      ctx,
    );
    expect(result).toEqual({ success: true, status: 'queued', sid: 'SM1', message: 'SMS queued.' });
    expect(sendSystemSms).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        to: '+13125550142',
        templateKey: 'directions',
        purpose: 'transactional',
        callId: 'CA1',
        liveCall: { callId: 'CA1' },
        idempotencyKey: agentSmsIdempotencyKey({
          callId: 'CA1',
          templateKey: 'directions',
          vars: { businessName: 'Fade Lab', address: '12 Main St' },
          to: '+13125550142',
        }),
      }),
    );
  });

  it('claims the live-call exemption only for the caller on the active call', async () => {
    sendSystemSms.mockResolvedValue({ ok: true, data: { messageId: 'm1', status: 'queued', twilioSid: 'SM1' } });
    const vars = { businessName: 'Fade Lab', address: '12 Main St' };
    // Same number, different formatting: still the caller.
    await executeSendSms({ toNumber: '+1 (312) 555-0142', templateKey: 'directions', vars }, ctx);
    expect(sendSystemSms.mock.calls[0][0]).toMatchObject({ to: '+13125550142', liveCall: { callId: 'CA1' } });

    await executeSendSms({ toNumber: '+13125550199', templateKey: 'directions', vars }, ctx);
    const other = sendSystemSms.mock.calls[1][0];
    expect(other).toMatchObject({ to: '+13125550199', callId: 'CA1' });
    expect(other).not.toHaveProperty('liveCall');

    await executeSendSms({ toNumber: '+13125550142', templateKey: 'directions', vars }, { ...ctx, callerNumber: undefined });
    expect(sendSystemSms.mock.calls[2][0]).not.toHaveProperty('liveCall');
  });

  it('returns the caller-safe message on a chokepoint error and the morning line when deferred', async () => {
    sendSystemSms.mockResolvedValueOnce({
      ok: false,
      error: { code: 'RECIPIENT_OPTED_OUT', message: 'opted out', callerSafeMessage: "I can't text this number", retryable: false },
    });
    expect(await executeSendSms({ templateKey: 'confirmation', vars: {} }, ctx)).toEqual({
      success: false,
      code: 'RECIPIENT_OPTED_OUT',
      message: "I can't text this number",
    });

    sendSystemSms.mockResolvedValueOnce({ ok: true, data: { messageId: 'm2', status: 'deferred_quiet_hours' } });
    expect(await executeSendSms({ templateKey: 'confirmation', vars: {} }, ctx)).toMatchObject({
      success: true,
      status: 'deferred_quiet_hours',
      message: "You'll get the text in the morning.",
    });
  });
});
