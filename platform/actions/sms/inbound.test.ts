import { describe, expect, it, vi } from 'vitest';
import { isSmsOptOut } from '../../campaigns/DncService';
import { createMemoryStore } from '../core';
import { isLikelySmsOptOut, isSmsHelp, isSmsOptIn } from './consent';
import {
  EMPTY_INBOUND_TWIML,
  handleInboundSms,
  parseInboundSmsPayload,
  type InboundConversation,
  type PersistInboundInput,
  type PersistInboundResult,
  type SmsInboundDeps,
  type SmsInboundStore,
} from './inbound';
import { createSmsSendAction, sendSystemSms } from './send';
import { SMS_MAX_BODY_CHARS } from './templates';

const TENANT = 'tenant-a';
const FROM = '+13125550142';
const TO = '+13125550100';
const SID = 'SM' + 'a'.repeat(32);

function payload(overrides: Record<string, unknown> = {}) {
  return { From: FROM, To: TO, MessageSid: SID, Body: 'hello', ...overrides };
}

interface MemoryState {
  messages: Array<{ tenantId: string; sid: string; body: string; metadata: Record<string, unknown> }>;
  consents: Array<{ tenantId: string; phone: string; action: string; sid: string }>;
  dnc: Set<string>;
  activities: Array<{ tenantId: string; conversationId: string; action: string; details: Record<string, unknown> }>;
  autoReplies: string[];
  csatCalls: number;
  persistShouldFail?: boolean;
}

function dncKey(tenantId: string, phone: string) {
  return `${tenantId}:${phone}`;
}

function createMemoryStoreBackend(state: MemoryState): SmsInboundStore {
  const locks = new Map<string, Promise<void>>();
  const conversations = new Map<string, InboundConversation>();

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => {
      release = r;
    });
    locks.set(key, prev.then(() => current));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    async persistInbound(input: PersistInboundInput): Promise<PersistInboundResult> {
      return withLock(`${input.tenantId}:${input.parsed.messageSid}`, async () => {
        if (state.persistShouldFail) throw new Error('persist down');
        if (
          state.messages.some(
            (m) => m.tenantId === input.tenantId && m.sid === input.parsed.messageSid,
          )
        ) {
          return { duplicate: true };
        }
        const convKey = `${input.tenantId}:${input.phoneNumberId}:${input.parsed.from}`;
        let conversation = conversations.get(convKey);
        if (!conversation) {
          conversation = {
            id: `conv-${conversations.size + 1}`,
            tenantId: input.tenantId,
            phoneNumberId: input.phoneNumberId,
            remoteNumber: input.parsed.from,
            assigneeUserId: null,
            assigneeTeam: null,
            contactLocation: null,
          };
          conversations.set(convKey, conversation);
        }
        if (input.keyword === 'opt_out') {
          state.dnc.add(dncKey(input.tenantId, input.parsed.from));
          state.consents.push({
            tenantId: input.tenantId,
            phone: input.parsed.from,
            action: 'opt_out',
            sid: input.parsed.messageSid,
          });
        } else if (input.keyword === 'opt_in') {
          state.consents.push({
            tenantId: input.tenantId,
            phone: input.parsed.from,
            action: 'opt_in',
            sid: input.parsed.messageSid,
          });
          state.dnc.delete(dncKey(input.tenantId, input.parsed.from));
        } else if (input.keyword === 'help') {
          state.consents.push({
            tenantId: input.tenantId,
            phone: input.parsed.from,
            action: 'help_request',
            sid: input.parsed.messageSid,
          });
        }
        state.messages.push({
          tenantId: input.tenantId,
          sid: input.parsed.messageSid,
          body: input.parsed.body,
          metadata: {
            numMedia: input.parsed.numMedia,
            ...(input.parsed.media.length > 0 ? { media: input.parsed.media } : {}),
          },
        });
        state.activities.push({
          tenantId: input.tenantId,
          conversationId: conversation.id,
          action: 'message_received',
          details: { from: input.parsed.from },
        });
        if (input.likelyOptOut) {
          state.activities.push({
            tenantId: input.tenantId,
            conversationId: conversation.id,
            action: 'likely_opt_out',
            details: { likely_opt_out: true },
          });
        }
        return { duplicate: false, conversation };
      });
    },
  };
}

function setup(overrides: Partial<SmsInboundDeps> = {}, stateOverrides: Partial<MemoryState> = {}) {
  const state: MemoryState = {
    messages: [],
    consents: [],
    dnc: new Set(),
    activities: [],
    autoReplies: [],
    csatCalls: 0,
    ...stateOverrides,
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: SmsInboundDeps = {
    lookupByTo: vi.fn(async () => ({ tenantId: TENANT, phoneNumberId: 'pn-a' })),
    store: createMemoryStoreBackend(state),
    isOptOut: isSmsOptOut,
    isOptIn: isSmsOptIn,
    isHelp: isSmsHelp,
    isLikelyOptOut: isLikelySmsOptOut,
    tryRecordCsat: vi.fn(async () => {
      state.csatCalls += 1;
      return { handled: false as const };
    }),
    markCsatOptedOut: vi.fn(async () => 0),
    evaluateAutoReplies: vi.fn(async () => null),
    evaluateAssignmentRules: vi.fn(async () => null),
    updateConversation: vi.fn(async () => null),
    logActivity: vi.fn(async () => {}),
    saveAutoReply: vi.fn(async ({ body }) => {
      state.autoReplies.push(body);
    }),
    logger: log,
    ...overrides,
  };
  return { deps, state, log };
}

describe('parseInboundSmsPayload', () => {
  it('normalizes From/To to E.164 and accepts an SM MessageSid', () => {
    const parsed = parseInboundSmsPayload({
      From: '+1 (312) 555-0142',
      To: '+1-312-555-0100',
      MessageSid: SID,
      Body: 'hi',
    });
    expect(parsed).toMatchObject({ from: FROM, to: TO, messageSid: SID, body: 'hi', numMedia: 0 });
  });

  it('rejects a missing From/To, a non-E.164 number, a bad MessageSid, an overlong body, and a bad NumMedia', () => {
    expect(parseInboundSmsPayload({ To: TO, MessageSid: SID, Body: 'hi' })).toBeNull();
    expect(parseInboundSmsPayload(payload({ From: '555-0142' }))).toBeNull();
    expect(parseInboundSmsPayload(payload({ MessageSid: 'CA123' }))).toBeNull();
    expect(parseInboundSmsPayload(payload({ Body: 'x'.repeat(SMS_MAX_BODY_CHARS + 1) }))).toBeNull();
    expect(parseInboundSmsPayload(payload({ NumMedia: '11' }))).toBeNull();
    expect(parseInboundSmsPayload(payload({ NumMedia: 'nope' }))).toBeNull();
  });

  it('accepts an MM MessageSid and records MMS URLs/types without fetching', () => {
    const parsed = parseInboundSmsPayload(
      payload({
        MessageSid: 'MM' + 'b'.repeat(32),
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.test/media/1',
        MediaContentType0: 'image/jpeg',
      }),
    );
    expect(parsed).toMatchObject({
      numMedia: 1,
      media: [{ url: 'https://api.twilio.test/media/1', contentType: 'image/jpeg' }],
    });
  });

  it('rejects a non-http MediaUrl', () => {
    expect(
      parseInboundSmsPayload(
        payload({ NumMedia: '1', MediaUrl0: 'javascript:alert(1)' }),
      ),
    ).toBeNull();
  });
});

describe('CTIA keywords (isSmsOptOut / isSmsOptIn / isSmsHelp)', () => {
  it.each(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'stop', ' stopall ', 'Unsubscribe'])(
    'treats %s as an exact opt-out',
    (keyword) => {
      expect(isSmsOptOut(keyword)).toBe(true);
      expect(isSmsOptIn(keyword)).toBe(false);
    },
  );

  it.each(['START', 'UNSTOP', ' start ', 'Unstop'])('treats %s as an exact opt-in', (keyword) => {
    expect(isSmsOptIn(keyword)).toBe(true);
    expect(isSmsOptOut(keyword)).toBe(false);
  });

  it.each(['HELP', 'INFO', ' help ', 'Info'])('treats %s as help', (keyword) => {
    expect(isSmsHelp(keyword)).toBe(true);
    expect(isSmsOptOut(keyword)).toBe(false);
  });

  it('does not opt out a non-exact phrase', () => {
    expect(isSmsOptOut('stop texting me so much')).toBe(false);
    expect(isSmsOptOut('please stop')).toBe(false);
    expect(isSmsOptOut('start time?')).toBe(false);
    expect(isLikelySmsOptOut('stop texting me so much')).toBe(true);
    expect(isLikelySmsOptOut('please stop')).toBe(true);
    expect(isLikelySmsOptOut('STOP')).toBe(false);
  });
});

describe('handleInboundSms', () => {
  it('returns empty TwiML and a warn (no phone) for an invalid payload', async () => {
    const { deps, log, state } = setup();
    const result = await handleInboundSms({ Body: 'hi' }, deps);
    expect(result).toEqual({ twiml: EMPTY_INBOUND_TWIML, httpStatus: 200 });
    expect(log.warn).toHaveBeenCalledWith('Inbound SMS payload failed validation', {
      reason: 'invalid_payload',
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/\+1/);
    expect(state.messages).toHaveLength(0);
  });

  it('returns empty TwiML when no routing matches', async () => {
    const { deps } = setup({ lookupByTo: vi.fn(async () => null) });
    const result = await handleInboundSms(payload(), deps);
    expect(result.twiml).toBe(EMPTY_INBOUND_TWIML);
    expect(result.httpStatus).toBe(200);
  });

  it('returns a Message TwiML when an auto-reply matches', async () => {
    const { deps, state } = setup({
      evaluateAutoReplies: vi.fn(async () => 'Thanks for your message'),
    });
    const result = await handleInboundSms(payload(), deps);
    expect(result.twiml).toContain('<Message>Thanks for your message</Message>');
    expect(state.autoReplies).toEqual(['Thanks for your message']);
  });

  it('escapes auto-reply XML', async () => {
    const { deps } = setup({
      evaluateAutoReplies: vi.fn(async () => 'A <B> & C'),
    });
    const result = await handleInboundSms(payload(), deps);
    expect(result.twiml).toContain('<Message>A &lt;B&gt; &amp; C</Message>');
  });

  it.each(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'])(
    'records %s as opt_out, adds DNC, and skips auto-reply',
    async (keyword) => {
      const { deps, state } = setup({
        evaluateAutoReplies: vi.fn(async () => 'should not send'),
      });
      const result = await handleInboundSms(payload({ Body: keyword, MessageSid: 'SM' + keyword.padEnd(32, '0') }), deps);
      expect(result.twiml).toBe(inboundEmpty());
      expect(state.consents.map((c) => c.action)).toEqual(['opt_out']);
      expect(state.dnc.has(dncKey(TENANT, FROM))).toBe(true);
      expect(state.autoReplies).toHaveLength(0);
      expect(deps.markCsatOptedOut).toHaveBeenCalledWith(TENANT, FROM);
    },
  );

  it.each(['START', ' unstop '])('records %s as opt_in and lifts the SMS-sourced DNC entry', async (keyword) => {
    const { deps, state } = setup();
    state.dnc.add(dncKey(TENANT, FROM));
    await handleInboundSms(payload({ Body: keyword, MessageSid: 'SM' + 'c'.repeat(32) }), deps);
    expect(state.consents.map((c) => c.action)).toEqual(['opt_in']);
    expect(state.dnc.has(dncKey(TENANT, FROM))).toBe(false);
    expect(deps.markCsatOptedOut).not.toHaveBeenCalled();
  });

  it('does not treat ordinary messages as opt-in or opt-out', async () => {
    const { deps, state } = setup();
    await handleInboundSms(payload({ Body: 'start time?' }), deps);
    expect(state.consents).toHaveLength(0);
    expect(state.dnc.size).toBe(0);
  });

  it.each(['HELP', 'INFO'])('records %s as help_request without DNC', async (keyword) => {
    const { deps, state } = setup();
    await handleInboundSms(payload({ Body: keyword, MessageSid: 'SM' + keyword.padEnd(32, '0') }), deps);
    expect(state.consents.map((c) => c.action)).toEqual(['help_request']);
    expect(state.dnc.size).toBe(0);
  });

  it('§2.6 #3 flags a non-exact opt-out phrase as likely_opt_out without DNC', async () => {
    const { deps, state } = setup();
    await handleInboundSms(payload({ Body: 'stop texting me so much' }), deps);
    expect(state.consents).toHaveLength(0);
    expect(state.dnc.size).toBe(0);
    expect(state.activities.some((a) => a.action === 'likely_opt_out')).toBe(true);
    expect(state.messages).toHaveLength(1);
  });

  it('§2.6 #10 records NumMedia and media URLs/types on the saved inbound message', async () => {
    const { deps, state } = setup();
    await handleInboundSms(
      payload({
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.test/media/nail.jpg',
        MediaContentType0: 'image/jpeg',
      }),
      deps,
    );
    expect(state.messages[0]?.metadata).toEqual({
      numMedia: 1,
      media: [{ url: 'https://api.twilio.test/media/nail.jpg', contentType: 'image/jpeg' }],
    });
  });

  it('does not re-save, re-log consent, re-run CSAT, or re-send an auto-reply on a duplicate MessageSid', async () => {
    const { deps, state } = setup({
      evaluateAutoReplies: vi.fn(async () => 'Thanks'),
    });
    const first = await handleInboundSms(payload({ Body: 'STOP' }), deps);
    const second = await handleInboundSms(payload({ Body: 'STOP' }), deps);
    expect(first.duplicate).toBeUndefined();
    expect(second.duplicate).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.consents).toHaveLength(1);
    expect(state.csatCalls).toBe(1);
    expect(state.autoReplies).toHaveLength(0);
    expect(deps.markCsatOptedOut).toHaveBeenCalledTimes(1);
  });

  it('returns 500 empty TwiML and no auto-reply when the opt-out persist fails', async () => {
    const { deps, state, log } = setup(
      { evaluateAutoReplies: vi.fn(async () => 'Thanks') },
      { persistShouldFail: true },
    );
    const result = await handleInboundSms(payload({ Body: 'STOP' }), deps);
    expect(result).toEqual({ twiml: EMPTY_INBOUND_TWIML, httpStatus: 500 });
    expect(state.autoReplies).toHaveLength(0);
    expect(log.error).toHaveBeenCalledWith(
      'Inbound SMS persist failed',
      expect.objectContaining({ tenantId: TENANT, messageSid: SID }),
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(FROM);
  });

  it('records a CSAT reply, still saves the inbound message, and skips auto-reply', async () => {
    const { deps, state } = setup({
      tryRecordCsat: vi.fn(async () => ({ handled: true as const, csat: { id: 'cs1' } })),
      evaluateAutoReplies: vi.fn(async () => 'Thanks'),
    });
    const result = await handleInboundSms(payload({ Body: '5' }), deps);
    expect(result.twiml).toBe(EMPTY_INBOUND_TWIML);
    expect(state.messages).toHaveLength(1);
    expect(state.autoReplies).toHaveLength(0);
  });

  it('§2.6 #2 STOP then START: latest consent wins and DNC is lifted; chokepoint then allows send', async () => {
    const { deps, state } = setup();
    await handleInboundSms(payload({ Body: 'STOP', MessageSid: 'SM' + 'd'.repeat(32) }), deps);
    const afterStop = await sendViaChokepoint(state);
    expect(afterStop.ok ? null : afterStop.error.code).toBe('RECIPIENT_OPTED_OUT');

    await handleInboundSms(payload({ Body: 'START', MessageSid: 'SM' + 'e'.repeat(32) }), deps);
    expect(state.consents.map((c) => c.action)).toEqual(['opt_out', 'opt_in']);
    expect(state.dnc.size).toBe(0);
    const afterStart = await sendViaChokepoint(state);
    expect(afterStart).toMatchObject({ ok: true, data: { status: 'queued' } });
  });

  it('§2.6 #1 opted-out caller later books: chokepoint still suppresses (see also send.test.ts RECIPIENT_OPTED_OUT)', async () => {
    const { deps, state } = setup();
    await handleInboundSms(payload({ Body: 'STOP' }), deps);
    const refused = await sendViaChokepoint(state);
    expect(refused.ok ? null : refused.error.code).toBe('RECIPIENT_OPTED_OUT');
  });
});

function inboundEmpty() {
  return EMPTY_INBOUND_TWIML;
}

async function sendViaChokepoint(state: MemoryState) {
  const transport = {
    defaultFromNumber: vi.fn(async () => TO),
    send: vi.fn(async () => ({ sid: 'SMx' })),
  };
  const latest = () => {
    const row = [...state.consents].reverse().find((c) => c.phone === FROM && c.action !== 'help_request');
    return (row?.action as 'opt_in' | 'opt_out' | undefined) ?? null;
  };
  const action = createSmsSendAction({
    store: {
      isTenantMessagingEnabled: async () => true,
      isTenantSender: async () => true,
      loadStoredOutbound: async () => null,
      latestConsentAction: async () => latest(),
      reserveOutbound: async () => ({ reserved: true }),
      reserveDeferredSend: async () => ({ reserved: true }),
      insertOutbound: async () => {},
      updateOutbound: async () => {},
      claimDueDeferred: async () => [],
    },
    transport,
    quietHours: { isAllowed: async () => true, nextWindowStart: async (_t, _to, now) => now },
    config: {
      smsEnabled: () => true,
      liveCallExemptSeconds: () => 60,
      rateLimit: () => ({ max: 0, windowMs: 0 }),
      statusCallbackUrl: () => null,
    },
  });
  const memory = createMemoryStore();
  return sendSystemSms(
    {
      tenantId: TENANT,
      to: FROM,
      templateKey: 'directions',
      vars: { businessName: 'Fade Lab', address: '12 Main St' },
      purpose: 'transactional',
    },
    { action, runtime: { store: memory, withTenantTx: memory.withTenantTx.bind(memory) } },
  );
}
