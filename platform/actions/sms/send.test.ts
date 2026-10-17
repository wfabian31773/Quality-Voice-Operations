import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  // SmsQuietHours reads tenant overrides; no override = federal 08:00–21:00.
  getPlatformPool: () => ({ query: async () => ({ rows: [] }) }),
  getPrivilegedPool: () => ({ query: async () => ({ rows: [] }) }),
  withTenantClient: vi.fn(),
  withPrivilegedClient: vi.fn(),
  withTenantContext: vi.fn(),
}));

import { createMemoryStore, runActionDefinition, type ActionContext, type Actor } from '../core';
import { TwilioApiError } from '../../integrations/twilio/sender';
import { clearSmsQuietHoursCache } from '../../sms/SmsQuietHours';
import {
  tenantSmsQuietHours,
  type OutboundSmsPatch,
  type OutboundSmsRecord,
  type SmsSendConfig,
  type SmsSendDeps,
  type SmsSendStore,
} from './deps';
import {
  automatedSmsIdempotencyKey,
  createSmsSendAction,
  releaseDueDeferredSms,
  sendSystemSms,
  type SystemSmsRequest,
} from './send';

const TENANT = 'tenant-1';
const TO = '+13125550142'; // 312 → America/Chicago (tenant-local)
const FROM = '+13125550100';
const CALLBACK = 'https://voice.example.com/twilio/sms-status';
const DAYTIME = new Date('2026-10-14T15:00:00.000Z'); // 10:00 AM CDT
const NINE_OH_FIVE_PM = new Date('2026-10-15T02:05:00.000Z'); // 9:05 PM CDT on Oct 14
const WINDOW_START = '2026-10-15T13:00:00.000Z'; // 8:00 AM CDT on Oct 15

type StoredRecord = OutboundSmsRecord & { twilioSid?: string; errorMessage?: string; sentAt?: Date };

function setup(overrides: Partial<SmsSendConfig> = {}) {
  const state = {
    smsEnabled: true,
    tenantEnabled: true,
    defaultFrom: FROM as string | null,
    senders: [FROM],
    consent: new Map<string, 'opt_in' | 'opt_out'>(),
  };
  const records = new Map<string, StoredRecord>();
  let seq = 0;

  const store: SmsSendStore = {
    isTenantMessagingEnabled: vi.fn(async () => state.tenantEnabled),
    isTenantSender: vi.fn(async (_tx: unknown, _tenant: string, from: string) => state.senders.includes(from)),
    latestConsentAction: vi.fn(async (_tx: unknown, _tenant: string, phone: string) => state.consent.get(phone) ?? null),
    countRecentOutbound: vi.fn(async (_tx: unknown, _tenant: string, to: string) =>
      [...records.values()].filter((r) => r.to === to && r.status !== 'failed').length,
    ),
    insertOutbound: vi.fn(async (record: OutboundSmsRecord) => {
      records.set(record.id, { ...record });
    }),
    updateOutbound: vi.fn(async (_tenant: string, id: string, patch: OutboundSmsPatch) => {
      const row = records.get(id);
      if (row) Object.assign(row, patch);
    }),
    claimDueDeferred: vi.fn(async (now: Date) => {
      const due = [...records.values()].filter(
        (r) => r.status === 'deferred_quiet_hours' && r.scheduledAt && r.scheduledAt <= now,
      );
      for (const r of due) r.status = 'sending';
      return due.map((r) => ({ ...r }));
    }),
  };
  const transport = {
    defaultFromNumber: vi.fn(async () => state.defaultFrom),
    send: vi.fn(async (_req: { statusCallback: string | null }) => ({ sid: `SM${++seq}`, status: 'queued' })),
  };
  const config: SmsSendConfig = {
    smsEnabled: () => state.smsEnabled,
    liveCallExemptSeconds: () => 60,
    rateLimit: () => ({ max: 5, windowMs: 3_600_000 }),
    statusCallbackUrl: () => CALLBACK,
    ...overrides,
  };
  const deps: SmsSendDeps = {
    store,
    transport,
    quietHours: tenantSmsQuietHours,
    config,
    newId: () => `msg-${records.size + 1}`,
  };
  const action = createSmsSendAction(deps);
  const memory = createMemoryStore();
  const runtime = { store: memory, withTenantTx: memory.withTenantTx.bind(memory) };

  function system(req: Partial<SystemSmsRequest> & { now?: Date } = {}) {
    return sendSystemSms(
      {
        tenantId: TENANT,
        to: TO,
        templateKey: 'confirmation',
        vars: { businessName: 'Fade Lab', summary: 'a cut with Marco, Tue Oct 20 at 3:30 PM' },
        purpose: 'transactional',
        now: DAYTIME,
        ...req,
      },
      { action, runtime },
    );
  }

  function asActor(actor: Actor, input: Record<string, unknown>, now = DAYTIME, key = `k-${Math.random()}`) {
    const ctx: ActionContext = { tenantId: TENANT, actor, now, idempotencyKey: key, tenantTimezone: 'America/Chicago' };
    return runActionDefinition(action, ctx, input, runtime);
  }

  return { state, records, store, transport, deps, action, system, asActor, runtime };
}

const owner: Actor = { type: 'user', id: 'u1', role: 'owner' };

beforeEach(() => {
  clearSmsQuietHoursCache();
});

describe('sms.send chokepoint', () => {
  it('persists, sends with a StatusCallback and returns queued', async () => {
    const t = setup();
    const result = await t.system();
    expect(result).toMatchObject({ ok: true, data: { status: 'queued', twilioSid: 'SM1', segments: 1, encoding: 'GSM-7' } });
    expect(t.transport.send).toHaveBeenCalledTimes(1);
    expect(t.transport.send.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      from: FROM,
      to: TO,
      body: 'Fade Lab: you are confirmed for a cut with Marco, Tue Oct 20 at 3:30 PM.',
      statusCallback: CALLBACK,
    });
    const [row] = [...t.records.values()];
    expect(row).toMatchObject({ status: 'queued', twilioSid: 'SM1', from: FROM, to: TO });
    expect(row.metadata).toMatchObject({ source: 'sms.send', templateKey: 'confirmation', purpose: 'transactional' });
    // Persisted before Twilio was called.
    const insertOrder = (t.store.insertOutbound as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(insertOrder).toBeLessThan(t.transport.send.mock.invocationCallOrder[0]);
  });

  it('returns RECIPIENT_OPTED_OUT and never calls Twilio for an opted-out recipient', async () => {
    const t = setup();
    t.state.consent.set(TO, 'opt_out');
    const result = await t.system();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RECIPIENT_OPTED_OUT');
    expect(result.error.retryable).toBe(false);
    expect(result.error.callerSafeMessage).toContain("can't text this number");
    expect(t.transport.send).not.toHaveBeenCalled();
    expect(t.records.size).toBe(0);
  });

  it('allows a recipient whose latest consent event is a re-opt-in (START)', async () => {
    const t = setup();
    t.state.consent.set(TO, 'opt_in');
    expect((await t.system()).ok).toBe(true);
    expect(t.transport.send).toHaveBeenCalledTimes(1);
  });

  it('returns MESSAGING_NOT_ENABLED when SMS_ENABLED is off, the tenant flag is off, or no sender exists', async () => {
    for (const disable of [
      (s: ReturnType<typeof setup>['state']) => (s.smsEnabled = false),
      (s: ReturnType<typeof setup>['state']) => (s.tenantEnabled = false),
      (s: ReturnType<typeof setup>['state']) => (s.defaultFrom = null),
    ]) {
      const t = setup();
      disable(t.state);
      const result = await t.system();
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('MESSAGING_NOT_ENABLED');
      expect(t.transport.send).not.toHaveBeenCalled();
      expect(t.records.size).toBe(0);
    }
  });

  it('defers a 9:05 PM tenant-local send to the window start instead of dropping it', async () => {
    const t = setup();
    const result = await t.system({ now: NINE_OH_FIVE_PM });
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'deferred_quiet_hours', reason: 'QUIET_HOURS', deferredUntil: WINDOW_START },
    });
    expect(t.transport.send).not.toHaveBeenCalled();
    const [row] = [...t.records.values()];
    expect(row.status).toBe('deferred_quiet_hours');
    expect(row.scheduledAt?.toISOString()).toBe(WINDOW_START);
  });

  it('releases the deferred message at the window start, re-checking consent', async () => {
    const t = setup();
    await t.system({ now: NINE_OH_FIVE_PM });
    await t.system({
      now: NINE_OH_FIVE_PM,
      to: '+13125550199',
      relatedEntity: { type: 'booking', id: 'b2' },
    });
    t.state.consent.set('+13125550199', 'opt_out');

    const early = await releaseDueDeferredSms({
      deps: t.deps,
      now: new Date('2026-10-15T12:59:00.000Z'),
      withTenantTx: t.runtime.withTenantTx,
    });
    expect(early.claimed).toBe(0);

    const summary = await releaseDueDeferredSms({
      deps: t.deps,
      now: new Date(WINDOW_START),
      withTenantTx: t.runtime.withTenantTx,
    });
    expect(summary).toMatchObject({ claimed: 2, sent: 1, suppressed: 1 });
    expect(t.transport.send).toHaveBeenCalledTimes(1);
    expect(t.transport.send.mock.calls[0][0]).toMatchObject({ to: TO, statusCallback: CALLBACK });
    const statuses = [...t.records.values()].map((r) => [r.to, r.status]);
    expect(statuses).toEqual([
      [TO, 'queued'],
      ['+13125550199', 'suppressed'],
    ]);
  });

  describe('live-call exemption', () => {
    it('sends a transactional message during a live call at 9:05 PM', async () => {
      const t = setup();
      const result = await t.system({ now: NINE_OH_FIVE_PM, liveCall: { callId: 'CA1' } });
      expect(result).toMatchObject({ ok: true, data: { status: 'queued' } });
      expect(t.transport.send).toHaveBeenCalledTimes(1);
    });

    it('exempts within 60 s of the call ending but not after', async () => {
      const t = setup();
      const within = await t.system({
        now: NINE_OH_FIVE_PM,
        liveCall: { callId: 'CA1', endedAt: new Date(NINE_OH_FIVE_PM.getTime() - 30_000).toISOString() },
      });
      expect(within).toMatchObject({ ok: true, data: { status: 'queued' } });

      const after = await t.system({
        now: NINE_OH_FIVE_PM,
        to: '+13125550111',
        liveCall: { callId: 'CA2', endedAt: new Date(NINE_OH_FIVE_PM.getTime() - 90_000).toISOString() },
      });
      expect(after).toMatchObject({ ok: true, data: { status: 'deferred_quiet_hours' } });
      expect(t.transport.send).toHaveBeenCalledTimes(1);
    });

    it('uses the configured window', async () => {
      const t = setup({ liveCallExemptSeconds: () => 120 });
      const result = await t.system({
        now: NINE_OH_FIVE_PM,
        liveCall: { callId: 'CA1', endedAt: new Date(NINE_OH_FIVE_PM.getTime() - 90_000).toISOString() },
      });
      expect(result).toMatchObject({ ok: true, data: { status: 'queued' } });

      const off = setup({ liveCallExemptSeconds: () => 0 });
      const deferred = await off.system({ now: NINE_OH_FIVE_PM, liveCall: { callId: 'CA1' } });
      expect(deferred).toMatchObject({ ok: true, data: { status: 'deferred_quiet_hours' } });
    });

    it('does not exempt conversational sends or non-system callers', async () => {
      const t = setup();
      const conversational = await t.system({
        now: NINE_OH_FIVE_PM,
        purpose: 'conversational',
        liveCall: { callId: 'CA1' },
      });
      expect(conversational).toMatchObject({ ok: true, data: { status: 'deferred_quiet_hours' } });

      const fromUi = await t.asActor(
        owner,
        { to: '+13125550177', body: 'See you soon', purpose: 'transactional', liveCall: { callId: 'CA1' } },
        NINE_OH_FIVE_PM,
      );
      expect(fromUi).toMatchObject({ ok: true, data: { status: 'deferred_quiet_hours' } });
      expect(t.transport.send).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('calls Twilio once for a repeated automated send', async () => {
      const t = setup();
      const req = {
        templateKey: 'reminder_24h' as const,
        vars: { businessName: 'Fade Lab', summary: 'your cut with Marco', time: '3:30 PM' },
        relatedEntity: { type: 'booking', id: 'b1' },
      };
      const first = await t.system(req);
      const second = await t.system(req);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.data.messageId).toBe(first.data.messageId);
      expect(t.transport.send).toHaveBeenCalledTimes(1);
      expect(t.records.size).toBe(1);
    });

    it('keys on the reminder kind so 24h and 2h reminders both send', async () => {
      const t = setup();
      const vars = { businessName: 'Fade Lab', summary: 'your cut with Marco', time: '3:30 PM' };
      const relatedEntity = { type: 'booking', id: 'b1' };
      await t.system({ templateKey: 'reminder_24h', vars, relatedEntity });
      await t.system({ templateKey: 'reminder_2h', vars, relatedEntity });
      expect(t.transport.send).toHaveBeenCalledTimes(2);
      expect(automatedSmsIdempotencyKey({ relatedEntity, templateKey: 'reminder_24h', to: TO })).not.toBe(
        automatedSmsIdempotencyKey({ relatedEntity, templateKey: 'reminder_2h', to: TO }),
      );
    });
  });

  describe('Twilio failures', () => {
    it('maps a Twilio 5xx to UPSTREAM_UNAVAILABLE and stores the message as failed', async () => {
      const t = setup();
      t.transport.send.mockRejectedValueOnce(new TwilioApiError('Twilio API error: 503 Service Unavailable', 503, null));
      const result = await t.system();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(result.error.retryable).toBe(true);
      const [row] = [...t.records.values()];
      expect(row.status).toBe('failed');
      expect(row.errorMessage).toContain('UPSTREAM_UNAVAILABLE');
    });

    it('maps a network error to UPSTREAM_UNAVAILABLE', async () => {
      const t = setup();
      t.transport.send.mockRejectedValueOnce(new Error('fetch failed'));
      const result = await t.system();
      expect(result.ok ? null : result.error.code).toBe('UPSTREAM_UNAVAILABLE');
    });

    it('maps Twilio 21211 to INVALID_NUMBER and 21610 to RECIPIENT_OPTED_OUT', async () => {
      const t = setup();
      t.transport.send.mockRejectedValueOnce(new TwilioApiError('Twilio API error: 400 invalid To', 400, 21211));
      const invalid = await t.system();
      expect(invalid.ok ? null : invalid.error.code).toBe('INVALID_NUMBER');

      t.transport.send.mockRejectedValueOnce(new TwilioApiError('Twilio API error: 400 unsubscribed', 400, 21610));
      const unsubscribed = await t.system({ to: '+13125550123' });
      expect(unsubscribed.ok ? null : unsubscribed.error.code).toBe('RECIPIENT_OPTED_OUT');
      expect([...t.records.values()].map((r) => r.status)).toEqual(['failed', 'failed']);
    });
  });

  it('returns INVALID_NUMBER for a non-E.164 recipient without persisting', async () => {
    const t = setup();
    const result = await t.system({ to: '555-0142' });
    expect(result.ok ? null : result.error.code).toBe('INVALID_NUMBER');
    expect(t.records.size).toBe(0);
  });

  it('rate-limits per recipient', async () => {
    const t = setup({ rateLimit: () => ({ max: 2, windowMs: 3_600_000 }) });
    expect((await t.system()).ok).toBe(true);
    expect((await t.system()).ok).toBe(true);
    const third = await t.system();
    expect(third.ok ? null : third.error.code).toBe('RATE_LIMITED');
    expect(t.transport.send).toHaveBeenCalledTimes(2);
  });

  describe('bodies', () => {
    it('refuses free text from system senders', async () => {
      const t = setup();
      const result = await t.asActor({ type: 'system', id: 'auto' }, { to: TO, body: 'hello', purpose: 'transactional' });
      expect(result.ok ? null : result.error.code).toBe('FORBIDDEN');
      expect(t.transport.send).not.toHaveBeenCalled();
    });

    it('allows UI/MCP free text up to 640 chars and counts segments', async () => {
      const t = setup();
      const spanish = 'Hola, su cita está confirmada para el martes a las 3:30. ¡Gracias por elegirnos! Nos vemos pronto.';
      const ui = await t.asActor(owner, { to: TO, body: spanish, purpose: 'conversational' });
      expect(ui).toMatchObject({ ok: true, data: { status: 'queued', encoding: 'UCS-2', segments: 2 } });

      const mcp = await t.asActor(
        { type: 'mcp', id: 'bot', scopes: ['sms:send'] },
        { to: '+13125550160', body: 'x'.repeat(640), purpose: 'conversational' },
      );
      expect(mcp).toMatchObject({ ok: true, data: { segments: 5 } });

      const tooLong = await t.asActor(owner, { to: TO, body: 'x'.repeat(641), purpose: 'conversational' });
      expect(tooLong.ok ? null : tooLong.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects agent actors, marketing, unknown templates, missing vars and non-https links', async () => {
      const t = setup();
      const agent = await t.asActor({ type: 'agent', id: 'a' }, { to: TO, templateKey: 'confirmation', purpose: 'transactional' });
      expect(agent.ok ? null : agent.error.code).toBe('FORBIDDEN');

      const marketing = await t.system({ purpose: 'marketing' as never });
      expect(marketing.ok ? null : marketing.error.code).toBe('OUTSIDE_POLICY');

      const unknown = await t.system({ templateKey: 'promo' as never });
      expect(unknown.ok ? null : unknown.error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'templateKey' });

      const missing = await t.system({ vars: { businessName: 'Fade Lab' } });
      expect(missing.ok ? null : missing.error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'vars.summary' });

      const link = await t.system({ templateKey: 'link', vars: { businessName: 'Fade Lab', url: 'http://evil.example' } });
      expect(link.ok ? null : link.error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'vars.url' });
      expect(t.transport.send).not.toHaveBeenCalled();
    });

    it('only sends from the tenant’s own numbers', async () => {
      const t = setup();
      const spoofed = await t.asActor(owner, { to: TO, from: '+14155550000', body: 'hi', purpose: 'conversational' });
      expect(spoofed.ok ? null : spoofed.error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'from' });

      t.state.senders.push('+13125550101');
      const own = await t.asActor(owner, { to: TO, from: '+13125550101', body: 'hi', purpose: 'conversational' });
      expect(own.ok).toBe(true);
      expect(t.transport.send.mock.calls[0][0]).toMatchObject({ from: '+13125550101' });
    });
  });
});
