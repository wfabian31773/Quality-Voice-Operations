/**
 * RT-14 prereq item 4: a timed-out write may still have gone through, so its
 * line never says it failed and never invites a second booking; a timed-out
 * read keeps "try again or take a message"; the stop after repeated timeouts
 * keeps the write-safe wording. Nothing is retried automatically.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { compose } from '../../../platform/agent-runtime/composer';
import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import { actionOk, type ActionResult } from '../../../platform/actions';
import { checkSay, createCallFacts } from '../../../platform/callcore/invariants';
import { isToolStoppedResult, TOOL_STOP_THRESHOLD, TOOL_STOPPED_CALLER_HINT, ToolStopGuard } from '../../../platform/tools/ToolStopGuard';
import { CallInvariants, toolOutputOk } from './callInvariants';
import { ContractToolBridge, PREPARE_TIMED_OUT, READ_TIMED_OUT, type ContractActionRunner } from './contractToolBridge';

const TEMPLATE = BARBERSHOP_TEMPLATE_V1;
const composed = compose(TEMPLATE, undefined, { businessName: 'Sharp Line Barbers' }, { language: 'en' });
const BINDING = composed.contractTools;

const COMMIT_SMS_OFF = {
  en: `I'm still waiting on the system, so I can't confirm that right now. The shop will follow up with you to confirm it. ${TEMPLATE.afterWrite.textWillFollow.en} I can also take a message for them.`,
  es: `Todavía estoy esperando al sistema, así que no puedo confirmarlo en este momento. Le van a dar seguimiento para confirmárselo. ${TEMPLATE.afterWrite.textWillFollow.es} También le puedo tomar un mensaje.`,
};

/** Words that claim or imply the write failed, or invite the caller to do it again. */
const FAILURE_OR_RETRY = /fail|couldn't (complete|book|get)|could not|wasn't able|try (it )?again|book (it )?again|otra vez|de nuevo|no se pudo|no pude (agendar|completar)/i;

const hang: ContractActionRunner = () => new Promise<ActionResult>(() => {});

function bridge(runner: ContractActionRunner, over: Partial<ConstructorParameters<typeof ContractToolBridge>[0]> = {}) {
  return new ContractToolBridge({
    tenantId: 't-shop',
    callId: `cs-${randomUUID()}`,
    agentId: 'ag-shop',
    binding: BINDING,
    timeZone: 'America/New_York',
    language: 'en',
    runAction: runner,
    smsEnabled: () => false,
    checkRateLimit: () => true,
    stopGuard: new ToolStopGuard(),
    timeoutMs: 5,
    ...over,
  });
}

const parse = (s: string) => JSON.parse(s) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** No SAY rule (success claim, ref-shaped speech, transfer words) objects to the line. */
function sayOk(line: string): boolean {
  return checkSay(createCallFacts({ callId: 'c', transferNumberConfigured: false, voiceRefs: false, smsEnabled: false, allowedActions: [], speakableNumbers: [] }), line).ok;
}

describe('a timed-out commit may have gone through', () => {
  it('EN: "still confirming", the shop follows up, a text once texting is enabled, a message offered; no failure, no rebook', async () => {
    const run = vi.fn(hang);
    const b = bridge(run);
    const out = parse(await b.runTool('scheduling_book_commit', { confirmationToken: randomUUID() }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: false, exit: 'message_ticket' });
    expect(out.error.callerSafeMessage).toBe(COMMIT_SMS_OFF.en);
    expect(out.error.callerSafeMessage).not.toMatch(FAILURE_OR_RETRY);
    expect(out.error.message).toMatch(/may still have gone through/);
    expect(out.error.message).toMatch(/Do not call it again/);
    expect(sayOk(out.error.callerSafeMessage)).toBe(true);
    // Not retried automatically.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ES: the same in Spanish', async () => {
    const b = bridge(hang, { language: 'es' });
    const out = parse(await b.runTool('scheduling_book_commit', { confirmationToken: randomUUID() }));
    expect(out.error.callerSafeMessage).toBe(COMMIT_SMS_OFF.es);
    expect(out.error.callerSafeMessage).not.toMatch(FAILURE_OR_RETRY);
    expect(sayOk(out.error.callerSafeMessage)).toBe(true);
  });

  it('once SMS is on, it says a confirmation text or a follow-up will come', async () => {
    const en = parse(await bridge(hang, { smsEnabled: () => true }).runTool('scheduling_cancel_commit', { confirmationToken: randomUUID() }));
    expect(en.error.callerSafeMessage).toBe(
      "I'm still waiting on the system, so I can't confirm that right now. You'll get a confirmation text or a follow-up from the shop. I can also take a message for them.",
    );
    expect(en.error.callerSafeMessage).not.toContain(TEMPLATE.afterWrite.textWillFollow.en);
    const es = parse(await bridge(hang, { smsEnabled: () => true, language: 'es' }).runTool('tickets_open_commit', { confirmationToken: randomUUID() }));
    expect(es.error.callerSafeMessage).toMatch(/mensaje de confirmación o le darán seguimiento/);
  });

  it('a timed-out prepare (a hold may sit until it expires) says she cannot confirm it and offers a message, with no text promise', async () => {
    const en = parse(await bridge(hang).runTool('scheduling_book_prepare', { serviceIds: ['s'] }));
    expect(en.error).toMatchObject({ retryable: false, exit: 'message_ticket', callerSafeMessage: PREPARE_TIMED_OUT.en });
    expect(en.error.callerSafeMessage).not.toMatch(FAILURE_OR_RETRY);
    const es = parse(await bridge(hang, { language: 'es' }).runTool('scheduling_book_prepare', { serviceIds: ['s'] }));
    expect(es.error.callerSafeMessage).toBe(PREPARE_TIMED_OUT.es);
    expect(sayOk(PREPARE_TIMED_OUT.en) && sayOk(PREPARE_TIMED_OUT.es)).toBe(true);
  });
});

describe('a timed-out read', () => {
  it('EN and ES: a plain "couldn\'t check, try again or take a message"', async () => {
    const en = parse(await bridge(hang).runTool('scheduling_find_bookings', { phone: '+15555550142' }));
    expect(en.error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true, callerSafeMessage: READ_TIMED_OUT.en });
    expect(en.error.exit).toBeUndefined();
    const es = parse(await bridge(hang, { language: 'es' }).runTool('scheduling_list_services', {}));
    expect(es.error.callerSafeMessage).toBe(READ_TIMED_OUT.es);
  });
});

describe(`the stop after ${TOOL_STOP_THRESHOLD} timeouts`, () => {
  it('a commit: still a stop, but in the "can\'t confirm yet" words, never "could not complete it"', async () => {
    const run = vi.fn(hang);
    const b = bridge(run);
    const outs: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < TOOL_STOP_THRESHOLD + 1; i++) outs.push(parse(await b.runTool('scheduling_book_commit', { confirmationToken: randomUUID() })));

    const stop = outs[TOOL_STOP_THRESHOLD - 1];
    expect(isToolStoppedResult(stop)).toBe(true);
    expect(stop).toMatchObject({ ok: false, success: false, code: 'TOOL_STOPPED', retryable: false, failedAttempts: TOOL_STOP_THRESHOLD });
    expect(stop.message_for_caller_hint).toBe(COMMIT_SMS_OFF.en);
    expect(stop.message_for_caller_hint).not.toBe(TOOL_STOPPED_CALLER_HINT);
    expect(stop.message).not.toMatch(/could not complete/);
    expect(stop.message).toMatch(/may still have gone through/);
    expect(stop.message).toMatch(/do not say it failed/);
    // Stopped: the fourth call doesn't run, and keeps the same wording.
    expect(outs[TOOL_STOP_THRESHOLD].message_for_caller_hint).toBe(COMMIT_SMS_OFF.en);
    expect(run).toHaveBeenCalledTimes(TOOL_STOP_THRESHOLD);
  });

  it('in Spanish, the stop hint is the Spanish line', async () => {
    const b = bridge(hang, { language: 'es' });
    let last: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < TOOL_STOP_THRESHOLD; i++) last = parse(await b.runTool('scheduling_book_commit', { confirmationToken: randomUUID() }));
    expect(last).toMatchObject({ code: 'TOOL_STOPPED', message_for_caller_hint: COMMIT_SMS_OFF.es });
  });

  it('a read keeps the guard\'s usual stop', async () => {
    const b = bridge(hang);
    let last: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < TOOL_STOP_THRESHOLD; i++) last = parse(await b.runTool('scheduling_check_availability', { serviceIds: ['s'] }));
    expect(last).toMatchObject({ code: 'TOOL_STOPPED', message_for_caller_hint: TOOL_STOPPED_CALLER_HINT });
  });
});

describe('the invariant checker and floor after a timed-out commit', () => {
  it('records it as not ok (no success words allowed) and leaves the floor decision to tickets.file_floor', async () => {
    const floor = vi.fn(async () => actionOk({ reason: 'already_filed' }));
    const invariants = new CallInvariants({
      tenantId: 't-shop',
      callId: 'cs-floor',
      agent: { tools: composed.tools, metadata: {}, language: 'en', timeZone: 'America/New_York' },
      log: { info: vi.fn(), warn: vi.fn() },
      smsEnabled: () => false,
      runFloorAction: floor,
    });
    const token = randomUUID();
    const b = bridge(async (name) => (name.endsWith('.prepare') ? actionOk({ confirmationToken: token, readback: 'Friday at 3:30?' }) : hang(name, {} as never, {})));
    const handler = invariants.wrapToolHandler((name, args) => b.runTool(name, args));
    await handler('scheduling_book_prepare', { serviceIds: ['s'] });
    invariants.agentTurnCompleted('A cut Friday at 3:30. Shall I book it?');
    invariants.callerTranscribed('Yes.');
    const out = await handler('scheduling_book_commit', { confirmationToken: token });
    expect(toolOutputOk(out)).toBe(false);
    // SAY: "you're booked" is still a claim before an ok commit.
    expect(checkSay(invariants.facts, "You're booked.").ok).toBe(false);
    // Not skipped as "filed by a tool": the floor action runs and checks the call's
    // artifacts itself (a booking that did land → already_filed, no second ticket).
    expect(await invariants.evaluateFloor()).toBe('already_filed');
    expect(floor).toHaveBeenCalledTimes(1);
  });
});
