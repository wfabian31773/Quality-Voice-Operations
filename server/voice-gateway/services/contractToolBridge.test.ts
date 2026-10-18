import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { compose } from '../../../platform/agent-runtime/composer';
import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import {
  actionFail,
  actionOk,
  createMemoryStore,
  runAction,
  type ActionContext,
  type ActionResult,
} from '../../../platform/actions';
import { CallInvariants } from './callInvariants';
import { ContractToolBridge, createContractToolBridge, type ContractActionRunner } from './contractToolBridge';

const TEMPLATE = BARBERSHOP_TEMPLATE_V1;
const composed = compose(TEMPLATE, undefined, { businessName: 'Sharp Line Barbers' }, { language: 'en' });
const BINDING = composed.contractTools;
const CALLER = '+15555550142';

function bridge(runner: ContractActionRunner, over: Partial<ConstructorParameters<typeof ContractToolBridge>[0]> = {}) {
  return new ContractToolBridge({
    tenantId: 't-shop',
    callId: `cs-${randomUUID()}`,
    agentId: 'ag-shop',
    binding: BINDING,
    timeZone: 'America/New_York',
    language: 'en',
    callerNumber: CALLER,
    runAction: runner,
    smsEnabled: () => false,
    now: () => new Date('2026-10-20T14:00:00Z'),
    ...over,
  });
}

/** The real platform actions over an in-memory store (no DB). */
function realActions(): ContractActionRunner {
  const store = createMemoryStore();
  return (name, ctx, input) => runAction(name, ctx, input, { store, withTenantTx: store.withTenantTx.bind(store) });
}

/**
 * A fake scheduling backend with the server's language rule: a proposal keeps
 * the prepare's locale, and the commit's readback speaks
 * `payload.locale ?? ctx.locale` (book.ts, cancel.ts).
 */
function fakeBooking() {
  const proposals = new Map<string, string | null>();
  const calls: Array<{ name: string; ctx: ActionContext; input: unknown }> = [];
  const runner: ContractActionRunner = async (name, ctx, input) => {
    calls.push({ name, ctx, input });
    if (name.endsWith('.prepare')) {
      const token = randomUUID();
      proposals.set(token, ctx.locale ?? null);
      return actionOk({ confirmationToken: token, readback: 'readback' }, { readback: 'readback' });
    }
    const token = (input as { confirmationToken: string }).confirmationToken;
    if (!proposals.has(token)) return actionFail('CONFIRMATION_INVALID', 'unknown token');
    const lang = (proposals.get(token) ?? ctx.locale ?? 'en').startsWith('es') ? 'es' : 'en';
    const readback = lang === 'es' ? 'Confirmado: corte con Marco, viernes, 3:30 p. m.' : 'Confirmed: cut with Marco, Friday at 3:30 PM.';
    return actionOk({ bookingId: 'b-1', status: 'confirmed', readback }, { readback });
  };
  return { runner, calls };
}

const parse = (s: string) => JSON.parse(s) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('contract tool bridge: real actions', () => {
  it('a book.prepare with a missing slot returns the contract\'s ask, in the template\'s words', async () => {
    const b = bridge(realActions());
    const out = parse(await b.runTool('scheduling_book_prepare', { serviceIds: ['svc-cut'] }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: 'SLOT_MISSING', askId: 'ask.staff', field: 'staff', retryable: true });
    expect(out.error.callerSafeMessage).toBe(TEMPLATE.asks['ask.staff'].en);
  });

  it('asks in Spanish after the caller switches, and the second miss is the contract\'s exit, not a second ask', async () => {
    const b = bridge(realActions());
    b.observeToolCall('record_language_change', { language: 'es', confidence: 'high' });
    const first = parse(await b.runTool('scheduling_book_prepare', {}));
    expect(first.error).toMatchObject({ code: 'SLOT_MISSING', askId: 'ask.service' });
    expect(first.error.callerSafeMessage).toBe(TEMPLATE.asks['ask.service'].es);

    const second = parse(await b.runTool('scheduling_book_prepare', {}));
    expect(second.error).toMatchObject({ code: 'SLOT_MISSING', askId: 'ask.service', exit: 'message_ticket', retryable: false });
    expect(second.error.callerSafeMessage).not.toBe(TEMPLATE.asks['ask.service'].es);
    expect(second.error.callerSafeMessage).toMatch(/mensaje/);
  });

  it('a message prepare holds the callback number from caller ID (no ask) even when the model passes "caller_id"', async () => {
    const seen: unknown[] = [];
    const real = realActions();
    const b = bridge(async (name, ctx, input) => {
      seen.push(input);
      return real(name, ctx, input);
    });
    const out = parse(await b.runTool('tickets_open_prepare', { kind: 'message', customer: { phone: 'caller_id' } }));
    expect(seen[0]).toEqual({ kind: 'message', customer: {} });
    // The subject is the first missing slot; the callback number is never asked for.
    expect(out.error).toMatchObject({ code: 'SLOT_MISSING', askId: 'ask.messageSubject' });
  });
});

describe('contract tool bridge: ActionContext', () => {
  it('runs the mapped action as the agent, with the call\'s tenant, session, caller number and language', async () => {
    const { runner, calls } = fakeBooking();
    const b = bridge(runner, { callId: 'cs-42', newIdempotencyKey: () => 'key-1' });
    const prep = parse(await b.runTool('scheduling_book_prepare', { serviceIds: ['s'], customer: { phone: '+1 555 010 9999' } }));
    await b.runTool('scheduling_book_commit', { confirmationToken: prep.data.confirmationToken });

    expect(calls.map((c) => c.name)).toEqual(['scheduling.book.prepare', 'scheduling.book.commit']);
    expect(calls[0].ctx).toEqual({
      tenantId: 't-shop',
      actor: { type: 'agent', id: 'ag-shop' },
      now: new Date('2026-10-20T14:00:00Z'),
      callId: 'cs-42',
      locale: 'en',
      tenantTimezone: 'America/New_York',
      callerPhone: CALLER,
      idempotencyKey: 'key-1',
    });
    // A real number the caller gave is passed through untouched.
    expect(calls[0].input).toEqual({ serviceIds: ['s'], customer: { phone: '+1 555 010 9999' } });
    // The commit is keyed by its confirmation token inside runAction, not by a new key.
    expect(calls[1].ctx.idempotencyKey).toBeUndefined();
  });

  it('only handles the agent\'s contract tools', () => {
    const b = bridge(fakeBooking().runner);
    expect(b.handles('scheduling_book_prepare')).toBe(true);
    expect(b.handles('get_current_tenant_time')).toBe(false);
    expect(b.handles('create_booking')).toBe(false);
    expect(b.handles('constructor')).toBe(false);
  });

  it('gives the model caller-safe text only when an action fails inside or throws', async () => {
    const internal = bridge(async () => actionFail('INTERNAL', 'relation "bookings" does not exist at db.ts:42'));
    expect(parse(await internal.runTool('scheduling_book_prepare', {})).error.message).not.toMatch(/relation|db\.ts/);
    const thrown = bridge(async () => {
      throw new Error('secret stack');
    });
    const out = parse(await thrown.runTool('scheduling_book_prepare', {}));
    expect(out.error.code).toBe('INTERNAL');
    expect(JSON.stringify(out)).not.toContain('secret stack');
  });

  it('exists only for an agent with a contract-tool binding', () => {
    const session = { tenantId: 't', callId: 'c', agent: { agentId: 'a', timeZone: 'UTC' } };
    expect(createContractToolBridge(session)).toBeUndefined();
    expect(createContractToolBridge({ ...session, agent: { ...session.agent, contractTools: BINDING } })).toBeInstanceOf(ContractToolBridge);
  });
});

describe('contract tool bridge: after-write line in the commit\'s language', () => {
  const booked = TEMPLATE.afterWrite.booked;
  const text = TEMPLATE.afterWrite.textWillFollow;

  it('an ES commit inside an EN-started call gets the ES line', async () => {
    const { runner } = fakeBooking();
    const b = bridge(runner, { language: 'en' });
    b.observeToolCall('record_language_change', { language: 'es', confidence: 'high' });
    const prep = parse(await b.runTool('scheduling_book_prepare', {}));
    const out = parse(await b.runTool('scheduling_book_commit', { confirmationToken: prep.data.confirmationToken }));
    expect(out.readback).toMatch(/^Confirmado/);
    expect(out.say).toBe(`${booked.es.replace('{{readback}}', out.readback)} ${text.es}`);
  });

  it('an EN commit gets the EN line, even if the caller switched to Spanish after the readback', async () => {
    const { runner } = fakeBooking();
    const b = bridge(runner, { language: 'en' });
    const prep = parse(await b.runTool('scheduling_book_prepare', {}));
    b.observeToolCall('record_language_change', { language: 'es', confidence: 'high' });
    const out = parse(await b.runTool('scheduling_book_commit', { confirmationToken: prep.data.confirmationToken }));
    expect(out.readback).toMatch(/^Confirmed/);
    expect(out.say).toBe(`${booked.en.replace('{{readback}}', out.readback)} ${text.en}`);
  });

  it('no text line once SMS is on; no line at all for a token this bridge did not prepare', async () => {
    const { runner } = fakeBooking();
    const sms = bridge(runner, { smsEnabled: () => true });
    const prep = parse(await sms.runTool('scheduling_book_prepare', {}));
    const out = parse(await sms.runTool('scheduling_book_commit', { confirmationToken: prep.data.confirmationToken }));
    expect(out.say).toBe(booked.en.replace('{{readback}}', out.readback));

    const other = bridge(runner);
    const foreign = parse(await other.runTool('scheduling_book_commit', { confirmationToken: prep.data.confirmationToken }));
    expect(foreign.ok).toBe(true);
    expect(foreign.say).toBeUndefined();
  });

  it('a message commit has no after-write line', async () => {
    const { runner } = fakeBooking();
    const b = bridge(runner);
    const prep = parse(await b.runTool('tickets_open_prepare', {}));
    const out = parse(await b.runTool('tickets_open_commit', { confirmationToken: prep.data.confirmationToken }));
    expect(out.ok).toBe(true);
    expect(out.say).toBeUndefined();
  });
});

describe('contract tools go through the RT-12 invariant checker', () => {
  function wired() {
    const { runner, calls } = fakeBooking();
    const b = bridge(runner);
    const invariants = new CallInvariants({
      tenantId: 't-shop',
      callId: 'cs-inv',
      agent: { tools: composed.tools, metadata: {}, language: 'en', timeZone: 'America/New_York' },
      callerNumber: CALLER,
      log: { info: vi.fn(), warn: vi.fn() },
      smsEnabled: () => false,
      runFloorAction: async () => actionOk({ reason: 'never_heard' }),
    });
    // The same order openaiSession uses: invariants wrap the tool handler, the handler reaches the bridge.
    const handler = invariants.wrapToolHandler((name, args) => (b.handles(name) ? b.runTool(name, args) : Promise.resolve('{}')));
    return { handler, invariants, calls };
  }

  it('a commit with no prepare is refused before any action runs', async () => {
    const { handler, calls } = wired();
    const out = parse(await handler('scheduling_book_commit', { confirmationToken: randomUUID() }));
    expect(out).toMatchObject({ success: false, code: 'INVARIANT_BLOCKED', rule: 'run.commit_token_not_prepared' });
    expect(calls).toEqual([]);
  });

  it('a commit after prepare but before an explicit yes is refused; after the yes it runs', async () => {
    const { handler, invariants, calls } = wired();
    const prep = parse(await handler('scheduling_book_prepare', { serviceIds: ['s'] }));
    const token = prep.data.confirmationToken as string;

    const early = parse(await handler('scheduling_book_commit', { confirmationToken: token }));
    expect(early).toMatchObject({ code: 'INVARIANT_BLOCKED', rule: 'run.commit_without_yes' });
    expect(calls.map((c) => c.name)).toEqual(['scheduling.book.prepare']);

    invariants.agentTurnCompleted('Friday at 3:30 with Marco, for Luis. Shall I book it?');
    invariants.callerTranscribed('Yes, that works.');
    const done = parse(await handler('scheduling_book_commit', { confirmationToken: token }));
    expect(done.ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['scheduling.book.prepare', 'scheduling.book.commit']);
    // An ok contract commit counts as filed: the floor will not file a second ticket.
    expect(await invariants.evaluateFloor()).toBe('skipped_tool_write');
  });

  it('a tool outside the composed list is refused by RUN', async () => {
    const { handler } = wired();
    expect(parse(await handler('create_booking', {}))).toMatchObject({ rule: 'run.action_not_allowed' });
  });
});
