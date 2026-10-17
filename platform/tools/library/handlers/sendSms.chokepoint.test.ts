import { beforeEach, describe, expect, it, vi } from 'vitest';

// End to end: agent tool handler -> sendSystemSms -> sms.send chokepoint -> transport.
// The default action deps and action store are swapped for in-memory fakes;
// the Twilio sender is stubbed so a real send can never happen.
const fake = vi.hoisted(() => {
  const records: Array<{ id: string; to: string; body: string; status: string }> = [];
  const transport = {
    defaultFromNumber: vi.fn(async () => '+13125550100'),
    send: vi.fn(async (_req: { tenantId: string; from: string; to: string; body: string; statusCallback: string | null }) => ({
      sid: 'SM-fake-1',
      status: 'queued',
    })),
  };
  const twilio = {
    sendTwilioSms: vi.fn(async () => {
      throw new Error('Twilio must not be called in tests');
    }),
    getTwilioCredentials: vi.fn(async () => {
      throw new Error('Twilio must not be called in tests');
    }),
  };
  const quiet = { allowed: true };
  return { records, transport, twilio, quiet };
});

vi.mock('../../../db', () => ({
  getPlatformPool: () => ({ query: async () => ({ rows: [] }) }),
  getPrivilegedPool: () => ({ query: async () => ({ rows: [] }) }),
  withTenantClient: vi.fn(),
  withPrivilegedClient: vi.fn(),
  withTenantContext: vi.fn(),
}));

vi.mock('../../../integrations/twilio/sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../integrations/twilio/sender')>()),
  sendTwilioSms: fake.twilio.sendTwilioSms,
  getTwilioCredentials: fake.twilio.getTwilioCredentials,
}));

vi.mock('../../../actions/core/postgresStore', async () => {
  const { createMemoryStore } = await import('../../../actions/core/memoryStore');
  return { postgresActionStore: createMemoryStore() };
});

vi.mock('../../../actions/core/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../actions/core/runtime')>();
  return {
    ...actual,
    defaultWithTenantTx: async <T>(_tenantId: string, fn: (tx: never) => Promise<T>) =>
      fn({ query: async () => ({ rows: [] }) } as never),
  };
});

vi.mock('../../../actions/sms/deps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../actions/sms/deps')>();
  return {
    ...actual,
    defaultSmsSendDeps: {
      store: {
        isTenantMessagingEnabled: async () => true,
        isTenantSender: async () => true,
        latestConsentAction: async () => null,
        reserveOutbound: async (record: { id: string; to: string; body: string; status: string }) => {
          fake.records.push({ id: record.id, to: record.to, body: record.body, status: record.status });
          return { reserved: true };
        },
        reserveDeferredSend: async () => ({ reserved: true }),
        insertOutbound: async (record: { id: string; to: string; body: string; status: string }) => {
          fake.records.push({ id: record.id, to: record.to, body: record.body, status: record.status });
        },
        updateOutbound: async (_tenantId: string, id: string, patch: { status: string }) => {
          const row = fake.records.find((r) => r.id === id);
          if (row) row.status = patch.status;
        },
        claimDueDeferred: async () => [],
      },
      transport: fake.transport,
      quietHours: {
        isAllowed: async () => fake.quiet.allowed,
        nextWindowStart: async () => new Date('2026-10-15T13:00:00.000Z'),
      },
      config: {
        smsEnabled: () => true,
        liveCallExemptSeconds: () => 60,
        rateLimit: () => ({ max: 5, windowMs: 3_600_000 }),
        statusCallbackUrl: () => 'https://voice.example.com/twilio/sms-status',
      },
    },
  };
});

const fetchSpy = vi.fn(async () => {
  throw new Error('network must not be used in tests');
});
vi.stubGlobal('fetch', fetchSpy);

import { sendSmsTool } from './sendSms';

const ctx = { tenantId: 'tenant-1', callSid: 'CA-e2e', callerNumber: '+13125550142', agentSlug: 'barber' };

beforeEach(() => {
  fake.records.length = 0;
  fake.quiet.allowed = true;
  fake.transport.send.mockClear();
  fake.twilio.sendTwilioSms.mockClear();
  fetchSpy.mockClear();
});

describe('send_sms tool -> sms.send chokepoint', () => {
  it('sends the rendered confirmation template through the chokepoint transport', async () => {
    const result = await sendSmsTool.handler(
      {
        templateKey: 'confirmation',
        vars: { businessName: 'Fade Lab', summary: "a men's cut with Marco, Tue Oct 20 at 3:30 PM" },
      },
      ctx as never,
    );

    expect(result).toEqual({ success: true, status: 'queued', sid: 'SM-fake-1', message: 'SMS queued.' });
    expect(fake.transport.send).toHaveBeenCalledTimes(1);
    expect(fake.transport.send.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      from: '+13125550100',
      to: '+13125550142',
      body: "Fade Lab: you are confirmed for a men's cut with Marco, Tue Oct 20 at 3:30 PM.",
      statusCallback: 'https://voice.example.com/twilio/sms-status',
    });
    expect(fake.records).toEqual([
      expect.objectContaining({ to: '+13125550142', status: 'queued', body: expect.stringContaining('Fade Lab') }),
    ]);
    expect(fake.twilio.sendTwilioSms).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends directions and link templates with the template text only', async () => {
    await sendSmsTool.handler(
      { toNumber: '+13125550199', templateKey: 'directions', vars: { businessName: 'Fade Lab', address: '12 Main St' } },
      ctx as never,
    );
    await sendSmsTool.handler(
      { templateKey: 'link', vars: { businessName: 'Fade Lab', url: 'https://fadelab.example/book' } },
      ctx as never,
    );
    expect(fake.transport.send.mock.calls.map((call) => [call[0].to, call[0].body])).toEqual([
      ['+13125550199', 'Fade Lab is at 12 Main St.'],
      ['+13125550142', "Fade Lab: here's the link you asked for: https://fadelab.example/book"],
    ]);
    expect(fake.twilio.sendTwilioSms).not.toHaveBeenCalled();
  });

  it.each([
    ['missing templateKey', { vars: { businessName: 'Fade Lab' } }],
    ['unknown templateKey', { templateKey: 'promo', vars: { businessName: 'Fade Lab' } }],
    ['system-only templateKey', { templateKey: 'ops_alert', vars: { message: 'hi' } }],
    ['free-text body', { body: 'Come in anytime, 50% off!' }],
  ])('refuses %s without reaching the chokepoint', async (_label, input) => {
    const result = await sendSmsTool.handler(input, ctx as never);
    expect(result).toMatchObject({ success: false, code: 'TEMPLATE_REQUIRED' });
    expect(fake.transport.send).not.toHaveBeenCalled();
    expect(fake.records).toEqual([]);
    expect(fake.twilio.sendTwilioSms).not.toHaveBeenCalled();
  });

  it('rejects bad vars without sending, then sends the corrected retry on the same call', async () => {
    const call = { ...ctx, callSid: 'CA-e2e-retry' } as never;
    const bad = await sendSmsTool.handler(
      { templateKey: 'link', vars: { businessName: 'Fade Lab', url: 'http://not-https.example' } },
      call,
    );
    expect(bad).toMatchObject({ success: false, code: 'VALIDATION_FAILED' });
    expect(fake.transport.send).not.toHaveBeenCalled();

    const corrected = await sendSmsTool.handler(
      { templateKey: 'link', vars: { businessName: 'Fade Lab', url: 'https://fadelab.example/book' } },
      call,
    );
    expect(corrected).toMatchObject({ success: true, status: 'queued' });
    expect(fake.transport.send).toHaveBeenCalledTimes(1);
  });

  it('sends two different confirmations in the same call', async () => {
    const call = { ...ctx, callSid: 'CA-e2e-two' } as never;
    const first = await sendSmsTool.handler(
      { templateKey: 'confirmation', vars: { businessName: 'Fade Lab', summary: 'a cut with Marco, Tue 3:30 PM' } },
      call,
    );
    const second = await sendSmsTool.handler(
      { templateKey: 'confirmation', vars: { businessName: 'Fade Lab', summary: 'a beard trim with Marco, Tue 4:00 PM' } },
      call,
    );
    expect(first).toMatchObject({ success: true, status: 'queued' });
    expect(second).toMatchObject({ success: true, status: 'queued' });
    expect(fake.transport.send).toHaveBeenCalledTimes(2);
    expect(fake.records).toHaveLength(2);
  });

  it('dedupes an exact duplicate in the same call (Twilio called once)', async () => {
    const call = { ...ctx, callSid: 'CA-e2e-dup' } as never;
    const input = { templateKey: 'directions', vars: { businessName: 'Fade Lab', address: '12 Main St' } };
    const first = await sendSmsTool.handler(input, call);
    // Same message; the number is spelled differently but normalizes to the caller.
    const repeat = await sendSmsTool.handler({ ...input, toNumber: '+1 312-555-0142' }, call);
    expect(first).toMatchObject({ success: true, status: 'queued' });
    expect(repeat).toEqual(first);
    expect(fake.transport.send).toHaveBeenCalledTimes(1);
    expect(fake.records).toHaveLength(1);
  });

  describe('quiet hours during a live call', () => {
    const vars = { businessName: 'Fade Lab', address: '12 Main St' };

    it('sends to the caller on the active call (exempt)', async () => {
      fake.quiet.allowed = false;
      const result = await sendSmsTool.handler(
        { templateKey: 'directions', vars },
        { ...ctx, callSid: 'CA-e2e-quiet-caller' } as never,
      );
      expect(result).toMatchObject({ success: true, status: 'queued' });
      expect(fake.transport.send).toHaveBeenCalledTimes(1);
    });

    it('defers a send to any other number', async () => {
      fake.quiet.allowed = false;
      const result = await sendSmsTool.handler(
        { toNumber: '+13125550199', templateKey: 'directions', vars },
        { ...ctx, callSid: 'CA-e2e-quiet-other' } as never,
      );
      expect(result).toMatchObject({ success: true, status: 'deferred_quiet_hours' });
      expect(fake.transport.send).not.toHaveBeenCalled();
      expect(fake.records).toEqual([expect.objectContaining({ to: '+13125550199', status: 'deferred_quiet_hours' })]);
    });
  });
});
