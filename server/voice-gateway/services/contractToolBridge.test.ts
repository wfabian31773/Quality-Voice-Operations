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
import { spokenWeek } from '../../../platform/actions/scheduling/spokenHours';
import { resolveStaffRef } from '../../../platform/actions/scheduling/staffRefs';
import { DEFAULT_RETRY_CONFIG } from '../../../platform/tools/RetryOrchestrator';
import { TOOL_STOP_THRESHOLD, ToolStopGuard } from '../../../platform/tools/ToolStopGuard';
import { CallInvariants } from './callInvariants';
import { CONTRACT_TOOL_TIMEOUT_MS, ContractToolBridge, createContractToolBridge, GUESS_FAILURES_EXCUSED, READ_TIMED_OUT, type ContractActionRunner } from './contractToolBridge';

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

describe('contract tool bridge: call-stable reads follow the call\'s language', () => {
  it('list_staff in English, then a switch to Spanish: the next list_staff reads again and words spokenHours in Spanish', async () => {
    const hours = { tue: '09:00-17:00', sat: '09:00-12:00, 13:00-16:00' };
    // list_staff's language rule: spokenHours in ctx.locale (listStaff.ts).
    const run = vi.fn<ContractActionRunner>(async (_name, ctx) =>
      actionOk([{ id: 'marco', displayName: 'Marco', serviceIds: [], workingDays: ['tue', 'sat'], hours, spokenHours: spokenWeek(hours, ctx.locale?.startsWith('es') ? 'es' : 'en') }]));
    const b = bridge(run, { language: 'en' });

    const en = parse(await b.runTool('scheduling_list_staff', {}));
    expect(en.data[0].spokenHours).toEqual({ tue: '9 AM to 5 PM', sat: '9 AM to noon and 1 PM to 4 PM' });
    b.observeToolCall('record_language_change', { language: 'es', confidence: 'high' });
    const es = parse(await b.runTool('scheduling_list_staff', {}));
    expect(es.data[0].spokenHours).toEqual({ tue: '9 a. m. a 5 p. m.', sat: '9 a. m. a 12 del mediodía y 1 p. m. a 4 p. m.' });
    expect(run).toHaveBeenCalledTimes(2);

    // Still cached within a language: asking again in Spanish is no new read.
    expect(parse(await b.runTool('scheduling_list_staff', {}))).toEqual(es);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('contract tool bridge: booking with the template\'s reads', () => {
  /** Fake catalog + availability on top of the fake booking backend. */
  function withReads() {
    const booking = fakeBooking();
    const runner: ContractActionRunner = async (name, ctx, input) => {
      if (name === 'scheduling.list_services') {
        booking.calls.push({ name, ctx, input });
        return actionOk({ services: [{ id: 'svc-cut', displayName: 'Cut', durationMinutes: 30, priceText: 'thirty dollars' }] });
      }
      if (name === 'scheduling.check_availability') {
        booking.calls.push({ name, ctx, input });
        return actionOk({ slots: [{ start: '2026-10-23T19:30:00.000Z', staffId: 'st-marco', spoken: 'Friday at 3:30 PM' }] });
      }
      return booking.runner(name, ctx, input);
    };
    return { runner, calls: booking.calls };
  }

  it('list_services → check_availability → book.prepare → explicit yes → book.commit succeeds', async () => {
    const { runner, calls } = withReads();
    const b = bridge(runner, { stopGuard: new ToolStopGuard() });
    const invariants = new CallInvariants({
      tenantId: 't-shop',
      callId: 'cs-reads',
      agent: { tools: composed.tools, metadata: {}, language: 'en', timeZone: 'America/New_York' },
      callerNumber: CALLER,
      log: { info: vi.fn(), warn: vi.fn() },
      smsEnabled: () => false,
      runFloorAction: async () => actionOk({ reason: 'never_heard' }),
    });
    const handler = invariants.wrapToolHandler((name, args) => (b.handles(name) ? b.runTool(name, args) : Promise.resolve('{}')));

    const services = parse(await handler('scheduling_list_services', { query: 'cut' }));
    expect(services.ok).toBe(true);
    const serviceId = services.data.services[0].id as string;
    const open = parse(await handler('scheduling_check_availability', { serviceIds: [serviceId], staffId: 'any' }));
    expect(open.ok).toBe(true);
    const slot = open.data.slots[0] as { start: string; staffId: string };
    const prep = parse(await handler('scheduling_book_prepare', {
      serviceIds: [serviceId], staffId: slot.staffId, start: slot.start, customer: { name: 'Luis' },
    }));
    expect(prep.ok).toBe(true);

    invariants.agentTurnCompleted('A cut with Marco, Friday at 3:30, for Luis. Shall I book it?');
    invariants.callerTranscribed('Yes, please.');
    const done = parse(await handler('scheduling_book_commit', { confirmationToken: prep.data.confirmationToken }));
    expect(done.ok).toBe(true);
    expect(done.say).toMatch(/^You're booked\./);

    expect(calls.map((c) => c.name)).toEqual([
      'scheduling.list_services',
      'scheduling.check_availability',
      'scheduling.book.prepare',
      'scheduling.book.commit',
    ]);
    // Reads run as the same agent, with no idempotency key.
    for (const read of calls.slice(0, 2)) {
      expect(read.ctx).toMatchObject({ tenantId: 't-shop', actor: { type: 'agent', id: 'ag-shop' }, callerPhone: CALLER, locale: 'en' });
      expect(read.ctx.idempotencyKey).toBeUndefined();
    }
  });
});

describe('contract tool bridge: timeout, repeated-failure stop, rate limit', () => {
  it('uses the legacy tools\' timeout', () => {
    expect(CONTRACT_TOOL_TIMEOUT_MS).toBe(DEFAULT_RETRY_CONFIG.timeoutMs);
  });

  it('a hung read times out with a "try again or take a message" line, and counts as a failure', async () => {
    const guard = new ToolStopGuard();
    const b = bridge(() => new Promise<ActionResult>(() => {}), { callId: 'cs-hang', timeoutMs: 20, stopGuard: guard });
    const out = parse(await b.runTool('scheduling_check_availability', { serviceIds: ['s'] }));
    expect(out.ok).toBe(false);
    // Nothing changed on a read: another try is fine, so no exit.
    expect(out.error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    expect(out.error.exit).toBeUndefined();
    expect(out.error.callerSafeMessage).toBe(READ_TIMED_OUT.en);
    expect(out.error.callerSafeMessage).toMatch(/try again/);
    expect(out.error.callerSafeMessage).toMatch(/take a message/);
    expect(guard.failureCount('cs-hang', 'scheduling_check_availability')).toBe(1);

    b.observeToolCall('record_language_change', { language: 'es', confidence: 'high' });
    const es = parse(await b.runTool('scheduling_check_availability', { serviceIds: ['s'] }));
    expect(es.error.callerSafeMessage).toBe(READ_TIMED_OUT.es);
    expect(es.error.callerSafeMessage).toMatch(/tomar un mensaje/);
  });

  it(`${TOOL_STOP_THRESHOLD} failures of the same tool trip the stop, and it no longer runs`, async () => {
    const guard = new ToolStopGuard();
    const run = vi.fn<ContractActionRunner>(async () => actionFail('NOT_FOUND', 'no such service'));
    const b = bridge(run, { callId: 'cs-fail', stopGuard: guard });
    const outs: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < TOOL_STOP_THRESHOLD + 1; i++) outs.push(parse(await b.runTool('scheduling_book_prepare', { serviceIds: ['x'] })));

    expect(outs.slice(0, TOOL_STOP_THRESHOLD - 1).map((o) => o.error.code)).toEqual(Array(TOOL_STOP_THRESHOLD - 1).fill('NOT_FOUND'));
    expect(outs[TOOL_STOP_THRESHOLD - 1]).toMatchObject({ code: 'TOOL_STOPPED', tool: 'scheduling_book_prepare', failedAttempts: TOOL_STOP_THRESHOLD });
    expect(outs[TOOL_STOP_THRESHOLD]).toMatchObject({ code: 'TOOL_STOPPED' });
    expect(run).toHaveBeenCalledTimes(TOOL_STOP_THRESHOLD);
    // Per tool: another tool still runs.
    expect(parse(await b.runTool('tickets_open_prepare', {})).error.code).toBe('NOT_FOUND');
  });

  it('timeouts and thrown errors count toward the stop too', async () => {
    const guard = new ToolStopGuard();
    const hang = bridge(() => new Promise<ActionResult>(() => {}), { callId: 'cs-mix', timeoutMs: 5, stopGuard: guard });
    const thrower = bridge(async () => { throw new Error('boom'); }, { callId: 'cs-mix', stopGuard: guard });
    await hang.runTool('scheduling_book_prepare', {});
    await thrower.runTool('scheduling_book_prepare', {});
    expect(parse(await hang.runTool('scheduling_book_prepare', {}))).toMatchObject({ code: 'TOOL_STOPPED' });
  });

  it('successes and SLOT_MISSING asks (with or without the exit) do not count toward the stop', async () => {
    const guard = new ToolStopGuard();
    let n = 0;
    const b = bridge(async () => {
      n += 1;
      if (n % 3 === 0) return actionOk({ services: [] });
      return actionFail('SLOT_MISSING', 'missing service', { askId: 'ask.service', field: 'service', ...(n % 3 === 2 ? { exit: 'message_ticket' as const } : {}) });
    }, { callId: 'cs-asks', stopGuard: guard });
    for (let i = 0; i < TOOL_STOP_THRESHOLD * 3; i++) {
      expect(parse(await b.runTool('scheduling_book_prepare', {})).code).not.toBe('TOOL_STOPPED');
    }
    expect(guard.failureCount('cs-asks', 'scheduling_book_prepare')).toBe(0);
  });

  describe('Oct 31 test call: a burst of guessed handles while pricing a second back-to-back booking', () => {
    const DEE = randomUUID();
    const LUIS = randomUUID();
    const MARCUS = randomUUID();
    const CATALOG = { staff: [{ id: DEE, name: 'Dee' }, { id: LUIS, name: 'Luis' }, { id: MARCUS, name: 'Marcus' }] } as unknown as Parameters<typeof resolveStaffRef>[0];
    const slot = (staffId: string, start: string) => ({
      staffId,
      start,
      end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
      blockedUntil: new Date(Date.parse(start) + 35 * 60_000).toISOString(),
    });
    const FIRST_SLOTS = ['2026-10-31T13:00:00.000Z', '2026-10-31T14:00:00.000Z', '2026-10-31T15:00:00.000Z'];

    /** check_availability's staff resolution, with the real resolveStaffRef and its alternatives. */
    function shop() {
      const inputs: Record<string, unknown>[] = [];
      const runner: ContractActionRunner = async (_name, _ctx, raw) => {
        const input = raw as { staffId?: string; startTime?: string };
        inputs.push(input);
        const member = input.staffId ? resolveStaffRef(CATALOG, input.staffId, 'en') : CATALOG.staff[0];
        if ('ok' in member) return member;
        // An exact check: the time asked for if it is open, else the next open one. Dee's 13:35 isn't, 13:45 is.
        if (input.startTime) return actionOk({ slots: [slot(member.id, input.startTime === '2026-10-31T13:35:00.000Z' ? '2026-10-31T13:45:00.000Z' : input.startTime)] });
        return actionOk({ slots: FIRST_SLOTS.map((start) => slot(member.id, start)) });
      };
      return { runner, inputs };
    }

    it('availability stays up, the error is consistent, and the alternatives\' handle reaches the right barber', async () => {
      const guard = new ToolStopGuard();
      const { runner, inputs } = shop();
      const b = bridge(runner, { callId: 'cs-1031', stopGuard: guard, checkRateLimit: () => true });
      const tool = 'scheduling_check_availability';

      const open = parse(await b.runTool(tool, { serviceIds: ['service-haircut'] }));
      expect(open.data.slots.map((s: { staffId: string }) => s.staffId)).toEqual(['staff-1', 'staff-1', 'staff-1']);
      const [first] = open.data.slots as Array<{ start: string; blockedUntil: string }>;

      // The back-to-back path: Dee again, at the first slot's blockedUntil.
      const next = parse(await b.runTool(tool, { staffId: 'staff-1', startTime: first.blockedUntil }));
      expect(inputs.at(-1)).toEqual({ staffId: DEE, startTime: '2026-10-31T13:35:00.000Z' });
      expect(next.data.slots[0]).toMatchObject({ staffId: 'staff-1', start: '2026-10-31T13:45:00.000Z' });

      // The son with "another barber": three parallel calls with a handle nothing issued.
      const burst = (await Promise.all(FIRST_SLOTS.map((startTime) => b.runTool(tool, { staffId: 'staff-2', startTime })))).map(parse);
      expect(guard.failureCount('cs-1031', tool)).toBe(0);
      const alternatives = [
        { staffId: 'staff-1', name: 'Dee' },
        { staffId: 'staff-3', name: 'Luis' },
        { staffId: 'staff-4', name: 'Marcus' },
      ];
      for (const out of burst) {
        expect(out.code).not.toBe('TOOL_STOPPED');
        expect(out.error.code).toBe('NOT_FOUND');
        expect(out.error.message).toMatch(/Unknown staff member: staff-2/);
        expect(out.error.message).toMatch(/staff-2 never came from a tool result/);
        // The handle that failed never names someone else in the same breath.
        expect(out.error.alternatives).toEqual(alternatives);
      }

      // The same guess later still means nobody: it did not turn into Luis.
      expect(parse(await b.runTool(tool, { staffId: 'staff-2' })).error.code).toBe('NOT_FOUND');
      expect(inputs.at(-1)).toEqual({ staffId: 'staff-2' });

      const luis = parse(await b.runTool(tool, { staffId: 'staff-3', startTime: first.start }));
      expect(inputs.at(-1)).toEqual({ staffId: LUIS, startTime: first.start });
      expect(luis.ok).toBe(true);
      expect(luis.data.slots[0]).toMatchObject({ staffId: 'staff-3', start: first.start });

      // Dee's handle is untouched by all of it.
      await b.runTool(tool, { staffId: 'staff-1', startTime: first.start });
      expect(inputs.at(-1)).toEqual({ staffId: DEE, startTime: first.start });
    });

    it('a not-found on a handle this call did issue, or a guess that fails some other way, still counts', async () => {
      const guard = new ToolStopGuard();
      const results: ActionResult[] = [actionOk({ staffId: DEE }), actionFail('NOT_FOUND', 'gone'), actionFail('INTERNAL', 'boom')];
      const b = bridge(async () => results.shift() ?? actionOk({}), { callId: 'cs-count', stopGuard: guard, checkRateLimit: () => true });
      const tool = 'scheduling_check_availability';
      await b.runTool(tool, {});
      await b.runTool(tool, { staffId: 'staff-1' });
      expect(guard.failureCount('cs-count', tool)).toBe(1);
      await b.runTool(tool, { staffId: 'staff-9' });
      expect(guard.failureCount('cs-count', tool)).toBe(2);
    });

    it('a model that keeps guessing is stopped on its own call, whatever it guesses, without touching other tools or calls', async () => {
      const guard = new ToolStopGuard();
      const { runner, inputs } = shop();
      // The tenant-wide limit never steps in here: the stop alone has to end it.
      const b = bridge(runner, { callId: 'cs-guessing', stopGuard: guard, checkRateLimit: () => true });
      const tool = 'scheduling_check_availability';
      const untilStop = GUESS_FAILURES_EXCUSED + TOOL_STOP_THRESHOLD;

      for (let i = 1; i < untilStop; i++) {
        // Numbered clear of the handles the errors' alternatives issue, so each one stays a guess.
        const out = parse(await b.runTool(tool, { staffId: `staff-${50 + i}` }));
        expect(out.error.code).toBe('NOT_FOUND');
        expect(out.error.message).toMatch(/never came from a tool result/);
        expect(guard.failureCount('cs-guessing', tool)).toBe(Math.max(0, i - GUESS_FAILURES_EXCUSED));
      }
      expect(parse(await b.runTool(tool, { staffId: 'staff-99' }))).toMatchObject({ code: 'TOOL_STOPPED', tool, failedAttempts: TOOL_STOP_THRESHOLD });
      expect(inputs).toHaveLength(untilStop);

      // Stopped for the rest of the call: nothing more reaches the action.
      expect(parse(await b.runTool(tool, { staffId: 'staff-100' }))).toMatchObject({ code: 'TOOL_STOPPED' });
      expect(inputs).toHaveLength(untilStop);

      // Per tool: another tool has its own excused guesses.
      const other = 'scheduling_book_prepare';
      expect(parse(await b.runTool(other, { staffId: 'staff-101' })).error.code).toBe('NOT_FOUND');
      expect(guard.failureCount('cs-guessing', other)).toBe(0);

      // Per call: another call on the tenant keeps its availability and its own excused guesses.
      const elsewhere = bridge(shop().runner, { callId: 'cs-elsewhere', stopGuard: guard, checkRateLimit: () => true });
      expect(parse(await elsewhere.runTool(tool, { staffId: 'staff-2' })).error.code).toBe('NOT_FOUND');
      expect(guard.failureCount('cs-elsewhere', tool)).toBe(0);
      expect(parse(await elsewhere.runTool(tool, { serviceIds: ['service-haircut'] })).ok).toBe(true);
    });
  });

  it('a rate-limited tool does not run', async () => {
    const run = vi.fn<ContractActionRunner>(async () => actionOk({}));
    const b = bridge(run, { checkRateLimit: () => false, stopGuard: new ToolStopGuard() });
    expect(parse(await b.runTool('scheduling_list_services', {})).error.code).toBe('RATE_LIMITED');
    expect(run).not.toHaveBeenCalled();
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
