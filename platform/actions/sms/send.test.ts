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
  type SmsRateLimitWindow,
  type SmsSendConfig,
  type SmsSendDeps,
  type SmsSendStore,
} from './deps';
import {
  agentSmsIdempotencyKey,
  automatedSmsIdempotencyKey,
  createSmsSendAction,
  releaseDueDeferredSms,
  sendSystemSms,
  SMS_RELEASE_MAX_ATTEMPTS,
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

  // Mirrors the Postgres store: deferred/suppressed/failed rows were never sent and don't count.
  // Like COALESCE(sent_at, created_at): a live row with no sentAt yet was just
  // created and counts; a released deferred row was created hours ago and
  // counts only once reserveDeferredSend stamps sentAt.
  const recentSends = (to: string, since: Date, excludeId?: string) =>
    [...records.values()].filter(
      (r) =>
        r.to === to &&
        r.id !== excludeId &&
        !['failed', 'deferred_quiet_hours', 'suppressed'].includes(r.status) &&
        (r.sentAt ? r.sentAt >= since : !r.metadata.releaseClaimedAt),
    ).length;

  const store: SmsSendStore = {
    isTenantMessagingEnabled: vi.fn(async () => state.tenantEnabled),
    isTenantSender: vi.fn(async (_tx: unknown, _tenant: string, from: string) => state.senders.includes(from)),
    latestConsentAction: vi.fn(async (_tx: unknown, _tenant: string, phone: string) => state.consent.get(phone) ?? null),
    reserveOutbound: vi.fn(async (record: OutboundSmsRecord, limit: SmsRateLimitWindow | null) => {
      const recent = limit ? recentSends(record.to, limit.since) : 0;
      if (limit && recent >= limit.max) return { reserved: false as const, recent };
      records.set(record.id, { ...record });
      return { reserved: true as const };
    }),
    reserveDeferredSend: vi.fn(async (msg: { id: string; to: string }, limit: SmsRateLimitWindow | null, now: Date) => {
      const recent = limit ? recentSends(msg.to, limit.since, msg.id) : 0;
      if (limit && recent >= limit.max) return { reserved: false as const, recent };
      const row = records.get(msg.id);
      if (row) row.sentAt = now;
      return { reserved: true as const };
    }),
    insertOutbound: vi.fn(async (record: OutboundSmsRecord) => {
      records.set(record.id, { ...record });
    }),
    updateOutbound: vi.fn(async (_tenant: string, id: string, patch: OutboundSmsPatch) => {
      const row = records.get(id);
      if (!row) return;
      const { metadata, ...rest } = patch;
      Object.assign(row, rest);
      if (metadata) row.metadata = { ...row.metadata, ...metadata };
    }),
    claimDueDeferred: vi.fn(async (now: Date, _limit: number, stuckBefore: Date) => {
      const due = [...records.values()].filter(
        (r) =>
          (r.status === 'deferred_quiet_hours' && r.scheduledAt && r.scheduledAt <= now) ||
          (r.status === 'sending' &&
            !r.twilioSid &&
            typeof r.metadata.releaseClaimedAt === 'string' &&
            new Date(r.metadata.releaseClaimedAt) <= stuckBefore),
      );
      return due.map((r) => {
        const reclaimed = r.status === 'sending';
        r.status = 'sending';
        r.metadata = { ...r.metadata, releaseClaimedAt: now.toISOString() };
        return { ...r, reclaimed };
      });
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
    const insertOrder = (t.store.reserveOutbound as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
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

  describe('deferred release', () => {
    const release = (t: ReturnType<typeof setup>, at: Date | string) =>
      releaseDueDeferredSms({ deps: t.deps, now: new Date(at), withTenantTx: t.runtime.withTenantTx });
    const defer = (t: ReturnType<typeof setup>, id: string, to = TO) =>
      t.system({ now: NINE_OH_FIVE_PM, to, relatedEntity: { type: 'booking', id } });
    const row = (t: ReturnType<typeof setup>, id: string) => t.records.get(id)!;
    const plusMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

    it('applies the per-recipient rate limit at release and re-defers instead of dropping', async () => {
      const t = setup({ rateLimit: () => ({ max: 1, windowMs: 3_600_000 }) });
      await defer(t, 'b1');
      await defer(t, 'b2');

      const first = await release(t, WINDOW_START);
      expect(first).toMatchObject({ claimed: 2, sent: 1, rateLimited: 1 });
      expect(t.transport.send).toHaveBeenCalledTimes(1);
      expect(row(t, 'msg-2')).toMatchObject({ status: 'deferred_quiet_hours' });
      expect(row(t, 'msg-2').scheduledAt?.toISOString()).toBe(plusMs(WINDOW_START, 10 * 60_000));
      expect(row(t, 'msg-2').metadata).toMatchObject({ deferredReason: 'RATE_LIMITED' });

      // Still inside the window 10 minutes later: pushed out again, still not sent.
      const again = await release(t, plusMs(WINDOW_START, 10 * 60_000));
      expect(again).toMatchObject({ claimed: 1, sent: 0, rateLimited: 1 });
      expect(t.transport.send).toHaveBeenCalledTimes(1);

      // The first send (at WINDOW_START) has left the 1 h window: the held message goes out.
      expect(row(t, 'msg-1').sentAt?.toISOString()).toBe(WINDOW_START);
      const later = await release(t, plusMs(WINDOW_START, 70 * 60_000));
      expect(later).toMatchObject({ claimed: 1, sent: 1 });
      expect(t.transport.send).toHaveBeenCalledTimes(2);
      expect(row(t, 'msg-2').status).toBe('queued');
    });

    it('re-defers a transient Twilio failure with attempt+1 and a later scheduled_at', async () => {
      const t = setup();
      await defer(t, 'b1');
      t.transport.send.mockRejectedValueOnce(new TwilioApiError('Twilio API error: 503 Service Unavailable', 503, null));

      const summary = await release(t, WINDOW_START);
      expect(summary).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
      const r = row(t, 'msg-1');
      expect(r.status).toBe('deferred_quiet_hours');
      expect(r.metadata).toMatchObject({ releaseAttempts: 1, deferredReason: 'RETRY' });
      expect(r.metadata.lastReleaseError).toContain('UPSTREAM_UNAVAILABLE');
      expect(r.scheduledAt?.toISOString()).toBe(plusMs(WINDOW_START, 60_000));

      const retry = await release(t, plusMs(WINDOW_START, 60_000));
      expect(retry).toMatchObject({ sent: 1 });
      expect(row(t, 'msg-1').status).toBe('queued');
    });

    it('treats a DB error in the gate checks as transient', async () => {
      const t = setup();
      await defer(t, 'b1');
      (t.store.latestConsentAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('connection reset'));
      const summary = await release(t, WINDOW_START);
      expect(summary).toMatchObject({ retried: 1, failed: 0 });
      expect(row(t, 'msg-1')).toMatchObject({ status: 'deferred_quiet_hours', metadata: expect.objectContaining({ releaseAttempts: 1 }) });
      expect(t.transport.send).not.toHaveBeenCalled();
    });

    it('marks the row failed on the 5th transient failure, with growing backoff before that', async () => {
      const t = setup();
      await defer(t, 'b1');
      t.transport.send.mockRejectedValue(new Error('fetch failed'));
      let at = WINDOW_START;
      const delays: number[] = [];
      for (let attempt = 1; attempt < SMS_RELEASE_MAX_ATTEMPTS; attempt++) {
        expect(await release(t, at)).toMatchObject({ retried: 1 });
        const next = row(t, 'msg-1').scheduledAt!.toISOString();
        delays.push(Date.parse(next) - Date.parse(at));
        expect(row(t, 'msg-1').metadata.releaseAttempts).toBe(attempt);
        at = next;
      }
      expect(delays).toEqual([60_000, 120_000, 240_000, 480_000]);

      expect(await release(t, at)).toMatchObject({ failed: 1, retried: 0 });
      expect(row(t, 'msg-1')).toMatchObject({ status: 'failed', metadata: expect.objectContaining({ releaseAttempts: 5 }) });
      expect(t.transport.send).toHaveBeenCalledTimes(5);
      expect(await release(t, plusMs(at, 3_600_000))).toMatchObject({ claimed: 0 });
    });

    it('fails a non-retryable Twilio error at once', async () => {
      const t = setup();
      await defer(t, 'b1');
      t.transport.send.mockRejectedValueOnce(new TwilioApiError('Twilio API error: 400 invalid To', 400, 21211));
      expect(await release(t, WINDOW_START)).toMatchObject({ failed: 1, retried: 0 });
      expect(row(t, 'msg-1')).toMatchObject({ status: 'failed', metadata: expect.objectContaining({ releaseAttempts: 1 }) });
      expect(row(t, 'msg-1').errorMessage).toContain('INVALID_NUMBER');
      expect(await release(t, plusMs(WINDOW_START, 3_600_000))).toMatchObject({ claimed: 0 });
    });

    it('reclaims a row stuck in sending without a Twilio SID after 10 minutes', async () => {
      const t = setup();
      await defer(t, 'b1');
      // A release claimed it and the process died before Twilio answered.
      await t.store.claimDueDeferred(new Date(WINDOW_START), 100, new Date(0));
      expect(row(t, 'msg-1').status).toBe('sending');

      expect(await release(t, plusMs(WINDOW_START, 5 * 60_000))).toMatchObject({ claimed: 0 });
      const summary = await release(t, plusMs(WINDOW_START, 11 * 60_000));
      expect(summary).toMatchObject({ claimed: 1, reclaimed: 1, sent: 1 });
      expect(t.transport.send).toHaveBeenCalledTimes(1);
      expect(row(t, 'msg-1').status).toBe('queued');
    });

    it('never reclaims a sending row that has a Twilio SID', async () => {
      const t = setup();
      await defer(t, 'b1');
      await t.store.claimDueDeferred(new Date(WINDOW_START), 100, new Date(0));
      row(t, 'msg-1').twilioSid = 'SM-already-sent';

      expect(await release(t, plusMs(WINDOW_START, 60 * 60_000))).toMatchObject({ claimed: 0, reclaimed: 0 });
      expect(t.transport.send).not.toHaveBeenCalled();
      expect(row(t, 'msg-1').status).toBe('sending');
    });

    it('fails a row that keeps getting stuck once it reaches the attempt cap', async () => {
      const t = setup();
      await defer(t, 'b1');
      await t.store.claimDueDeferred(new Date(WINDOW_START), 100, new Date(0));
      row(t, 'msg-1').metadata.releaseAttempts = SMS_RELEASE_MAX_ATTEMPTS - 1;
      expect(await release(t, plusMs(WINDOW_START, 11 * 60_000))).toMatchObject({ reclaimed: 1, failed: 1 });
      expect(row(t, 'msg-1')).toMatchObject({ status: 'failed', errorMessage: 'STUCK_SENDING' });
      expect(t.transport.send).not.toHaveBeenCalled();
    });
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

    it('agent key = call + stable hash of templateKey, canonical vars and normalized recipient', () => {
      const base = { callId: 'CA1', templateKey: 'link', vars: { businessName: 'Fade Lab', url: 'https://a.example' }, to: TO };
      const key = agentSmsIdempotencyKey(base);
      expect(key).toMatch(/^sms:agent:CA1:[0-9a-f]{32}$/);
      // Same content, different var order / number formatting: same key.
      expect(
        agentSmsIdempotencyKey({ ...base, vars: { url: 'https://a.example', businessName: 'Fade Lab' }, to: '+1 (312) 555-0142' }),
      ).toBe(key);
      // Corrected vars, another template, another number or another call: different key.
      expect(agentSmsIdempotencyKey({ ...base, vars: { ...base.vars, url: 'https://b.example' } })).not.toBe(key);
      expect(agentSmsIdempotencyKey({ ...base, templateKey: 'directions' })).not.toBe(key);
      expect(agentSmsIdempotencyKey({ ...base, to: '+13125550199' })).not.toBe(key);
      expect(agentSmsIdempotencyKey({ ...base, callId: 'CA2' })).not.toBe(key);
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
        { type: 'mcp', id: 'bot', scopes: ['qvo:read', 'qvo:admin'] },
        { to: '+13125550160', body: 'x'.repeat(640), purpose: 'conversational' },
      );
      expect(mcp).toMatchObject({ ok: true, data: { segments: 5 } });

      const tooLong = await t.asActor(owner, { to: TO, body: 'x'.repeat(641), purpose: 'conversational' });
      expect(tooLong.ok ? null : tooLong.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses MCP callers without qvo:admin before calling Twilio', async () => {
      const t = setup();
      for (const scopes of [['qvo:read'], ['sms:send'], []]) {
        const result = await t.asActor({ type: 'mcp', id: 'bot', scopes }, { to: TO, body: 'hi', purpose: 'conversational' });
        expect(result.ok ? null : result.error.code).toBe('FORBIDDEN');
      }
      expect(t.transport.send).not.toHaveBeenCalled();
      expect(t.records.size).toBe(0);
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
