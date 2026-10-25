import { describe, expect, it, vi } from 'vitest';
import { INSTRUCTIONS, SUCCESS_RUN_CEILING } from '../../../platform/callcore/invariants';
import { floorIdempotencyKey } from '../../../platform/actions/tickets';
import type { ActionContext, ActionResult } from '../../../platform/actions';
import type { CallOutcome } from './callOutcome';
import {
  CallInvariants,
  END_CALL_TOOLS,
  isAgentQuestion,
  isExplicitYes,
  isHoldingLine,
  isTransferRequest,
  sayObservedTotal,
  toolKind,
  toolOutputOk,
  type CallInvariantsInit,
  type FloorActionRunner,
} from './callInvariants';

const OK = JSON.stringify({ success: true });

function filed(reason = 'filed'): ActionResult {
  return { ok: true, data: { filed: reason === 'filed', reason } };
}

function make(overrides: Partial<CallInvariantsInit> = {}) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const runFloorAction = vi.fn<FloorActionRunner>(async () => filed());
  const inv = new CallInvariants({
    tenantId: 't-1',
    callId: 'cs-1',
    agent: {
      tools: [{ name: 'lookup_customer' }, { name: 'create_ticket' }, { name: 'triageEscalate' }, { name: 'escalate_to_human' }, { name: 'end_call' }],
      metadata: {},
      language: 'en',
      timeZone: 'America/New_York',
    },
    callerNumber: '+15550100142',
    calledNumber: '+15550199999',
    log,
    runFloorAction,
    smsEnabled: () => false,
    now: () => new Date('2026-10-18T15:00:00Z'),
    ...overrides,
  });
  const handler = vi.fn(async (_name: string, _args: Record<string, unknown>) => OK);
  const tool = inv.wrapToolHandler(handler);
  return { inv, log, runFloorAction, handler, tool };
}

function blockedRule(output: string): string | undefined {
  const parsed = JSON.parse(output) as { code?: string; rule?: string; success?: boolean };
  return parsed.code === 'INVARIANT_BLOCKED' && parsed.success === false ? parsed.rule : undefined;
}

describe('tool classification', () => {
  it('legacy reads and runtime bookkeeping are reads; other legacy tools are writes', () => {
    expect(toolKind('lookup_customer', {})).toBe('read');
    expect(toolKind('record_call_outcome', {})).toBe('read');
    expect(toolKind('transfer_to_agent', {})).toBe('read');
    expect(toolKind('create_booking', {})).toBe('write');
    expect(toolKind('createServiceTicket', {})).toBe('write');
    expect(toolKind('some_unknown_tool', {})).toBe('write');
  });

  it('two-phase platform actions keep their kind, by action name or external tool name', () => {
    expect(toolKind('scheduling.book.prepare', {})).toBe('prepare');
    expect(toolKind('scheduling_book_commit', {})).toBe('commit');
  });

  it('transfers: triageEscalate always, escalate_to_human only with a transfer_number', () => {
    expect(isTransferRequest('triageEscalate', {})).toBe(true);
    expect(isTransferRequest('escalate_to_human', { transfer_number: '+15550100000' })).toBe(true);
    expect(isTransferRequest('escalate_to_human', { transfer_number: '  ' })).toBe(false);
    expect(isTransferRequest('escalate_to_human', {})).toBe(false);
    expect(toolKind('triageEscalate', {})).toBe('transfer');
    expect(toolKind('escalate_to_human', {})).toBe('write');
    expect(END_CALL_TOOLS.has('end_call')).toBe(true);
  });

  it('an agent turn is a question when it starts with "¿" or its last sentence asks', () => {
    for (const text of ['Which location?', ' ¿Qué sede? ', '¿Qué sede', 'We have two shops. Which one?', 'Tenemos dos. ¿Cuál', 'Which one?"']) {
      expect(isAgentQuestion(text)).toBe(true);
    }
    for (const text of ['We open at nine.', 'Is it Saturday? We open at nine.', 'Marco works Tuesday to Saturday', '']) {
      expect(isAgentQuestion(text)).toBe(false);
    }
  });

  it('a holding line is "let me check" / "one moment" / "un momento" / "déjeme revisar", not an answer', () => {
    for (const text of ['Let me check that.', 'Let me look into it', 'Just a second.', 'Hold on.', "I'll check with Marco.", 'Un momento.', 'Déjeme revisar.', 'Permítame verificar.', 'Voy a revisar.']) {
      expect(isHoldingLine(text)).toBe(true);
    }
    for (const text of ['We open at nine.', 'We have a second location downtown.', 'Abrimos a las nueve.', '']) {
      expect(isHoldingLine(text)).toBe(false);
    }
  });

  it('a follow-up promise or a "don\'t know" is a holding line, not an answer (EN/ES)', () => {
    for (const text of [
      "We'll call you back with that.",
      'Someone from our team will reach out.',
      'I’ll get back to you on that.',
      'Someone will call you tomorrow.',
      'Someone will contact you shortly.',
      'I can have someone call you.',
      "I'll have a tech contact you.",
      "Pricing depends on the job, I'll have a technician reach out with a quote.",
      'I will have the team reach you today.',
      "I don't have that information.",
      'I do not know his schedule.',
      "I'm not sure about that.",
      'Un técnico le llamará mañana.',
      'Le devolveremos la llamada.',
      'Le contactaremos pronto.',
      'Alguien se comunicará con usted.',
      'No tengo esa información.',
      'No estoy segura.',
    ]) {
      expect(isHoldingLine(text), text).toBe(true);
    }
  });

  it('a trailing courtesy closer does not turn an answer into a question; a bare closer answers nothing', () => {
    for (const text of [
      'We open at nine. Anything else I can help with?',
      'We open at nine. Is there anything else?',
      'We open at nine. Can I help with anything else?',
      'Abrimos a las nueve. ¿Algo más?',
      'Abrimos a las nueve. ¿Le puedo ayudar en algo más?',
      'Abrimos a las nueve. ¿Hay algo más en que le pueda ayudar?',
    ]) {
      expect(isAgentQuestion(text)).toBe(false);
    }
    for (const text of [
      'Anything else?',
      '¿Algo más?',
      'Is there anything else?',
      'Which location?',
      'We have two shops. Which one do you mean?',
      'We have two shops. Which one do you mean? Anything else?',
    ]) {
      expect(isAgentQuestion(text)).toBe(true);
    }
  });

  it('reads tool success from the real output', () => {
    expect(toolOutputOk(OK)).toBe(true);
    expect(toolOutputOk(JSON.stringify({ success: false }))).toBe(false);
    expect(toolOutputOk(JSON.stringify({ ok: false }))).toBe(false);
    expect(toolOutputOk(JSON.stringify({ ok: false, success: false, code: 'TOOL_STOPPED' }))).toBe(false);
    expect(toolOutputOk(JSON.stringify({ success: true, status: 'needs_confirmation' }))).toBe(false);
    expect(toolOutputOk('not json')).toBe(true);
  });

  it('explicit yes: a short affirmative without a correction', () => {
    expect(isExplicitYes('Yes, that is right')).toBe(true);
    expect(isExplicitYes('sí, perfecto')).toBe(true);
    expect(isExplicitYes('Yes but make it ten')).toBe(false);
    expect(isExplicitYes('Friday at nine')).toBe(false);
    expect(isExplicitYes('Book it.', 'book')).toBe(true);
    expect(isExplicitYes('Book it.', 'cancel')).toBe(false);
    expect(isExplicitYes('dale')).toBe(true);
    expect(isExplicitYes('Book it but at 2')).toBe(false);
  });
});

describe('RUN (tool bridge)', () => {
  it('blocks a tool the agent does not expose with the fixed instruction, without running it', async () => {
    const { tool, handler, log } = make();
    const out = await tool('delete_all_bookings', {});
    expect(blockedRule(out)).toBe('run.action_not_allowed');
    expect(JSON.parse(out).message).toBe(INSTRUCTIONS['run.action_not_allowed']);
    expect(handler).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('invariant_block', { rule: 'run.action_not_allowed', tool: 'delete_all_bookings' });
  });

  it('runs exposed legacy tools unchanged and returns their output', async () => {
    const { tool, handler } = make();
    expect(await tool('lookup_customer', { phone: '1' })).toBe(OK);
    expect(await tool('create_ticket', { subject: 'x' })).toBe(OK);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it(`success-run ceiling: the ${SUCCESS_RUN_CEILING}th identical successful read in a row is blocked`, async () => {
    const { tool, handler } = make();
    for (let i = 1; i < SUCCESS_RUN_CEILING; i += 1) {
      expect(blockedRule(await tool('lookup_customer', { phone: '555' }))).toBeUndefined();
    }
    expect(handler).toHaveBeenCalledTimes(SUCCESS_RUN_CEILING - 1);
    expect(blockedRule(await tool('lookup_customer', { phone: '555' }))).toBe('run.success_run_ceiling');
    expect(handler).toHaveBeenCalledTimes(SUCCESS_RUN_CEILING - 1);
    // Different arguments are a different read.
    expect(blockedRule(await tool('lookup_customer', { phone: '556' }))).toBeUndefined();
  });

  it('a failed read breaks the run, and blocked calls are not counted as runs', async () => {
    const { tool, handler } = make();
    for (let i = 1; i < SUCCESS_RUN_CEILING - 1; i += 1) await tool('lookup_customer', { phone: '555' });
    handler.mockResolvedValueOnce(JSON.stringify({ success: false }));
    await tool('lookup_customer', { phone: '555' });
    expect(blockedRule(await tool('lookup_customer', { phone: '555' }))).toBeUndefined();
  });

  it('a commit without a prepared token and an explicit yes is blocked (two-phase platform actions only)', async () => {
    const { inv, tool, handler } = make({
      agent: { tools: [{ name: 'scheduling_book_prepare' }, { name: 'scheduling_book_commit' }] },
    });
    expect(blockedRule(await tool('scheduling_book_commit', {}))).toBe('run.commit_without_token');
    expect(blockedRule(await tool('scheduling_book_commit', { confirmationToken: 'tok-x' }))).toBe('run.commit_token_not_prepared');

    handler.mockResolvedValueOnce(JSON.stringify({ ok: true, data: { confirmationToken: 'tok-1', readback: 'Friday at nine' } }));
    await tool('scheduling_book_prepare', { service: 'fade' });
    expect(inv.facts.preparedTokens.has('tok-1')).toBe(true);
    expect(blockedRule(await tool('scheduling_book_commit', { confirmationToken: 'tok-1' }))).toBe('run.commit_without_yes');

    // A "yes" before the readback was voiced doesn't count.
    inv.callerTranscribed('Yes');
    expect(blockedRule(await tool('scheduling_book_commit', { confirmationToken: 'tok-1' }))).toBe('run.commit_without_yes');
    inv.agentTurnCompleted('That is a fade on Friday at nine, shall I book it?');
    inv.callerTranscribed('Yes, please');
    expect(blockedRule(await tool('scheduling_book_commit', { confirmationToken: 'tok-1' }))).toBeUndefined();
    expect(handler).toHaveBeenLastCalledWith('scheduling_book_commit', { confirmationToken: 'tok-1' });
  });

  it('"Book it." after the readback lets the commit through; "book it but at 2" does not', async () => {
    const { inv, tool, handler } = make({
      agent: { tools: [{ name: 'scheduling_book_prepare' }, { name: 'scheduling_book_commit' }] },
    });
    handler.mockResolvedValueOnce(JSON.stringify({ ok: true, data: { confirmationToken: 'tok-1', readback: 'Friday at nine' } }));
    await tool('scheduling_book_prepare', { service: 'fade' });
    inv.agentTurnCompleted('That is a fade on Friday at nine, shall I book it?');
    inv.callerTranscribed('Book it but at 2');
    expect(blockedRule(await tool('scheduling_book_commit', { confirmationToken: 'tok-1' }))).toBe('run.commit_without_yes');
    inv.callerTranscribed('Book it.');
    expect(blockedRule(await tool('scheduling_book_commit', { confirmationToken: 'tok-1' }))).toBeUndefined();
  });

  it.each(['Book it.', 'Resérvalo.', 'go ahead and book it'])(
    'a booking go-ahead is not a yes to a prepared cancel or reschedule: %s',
    async (line) => {
      for (const [prepare, commit] of [
        ['scheduling_cancel_prepare', 'scheduling_cancel_commit'],
        ['scheduling_reschedule_prepare', 'scheduling_reschedule_commit'],
      ]) {
        const { inv, tool, handler } = make({ agent: { tools: [{ name: prepare }, { name: commit }] } });
        handler.mockResolvedValueOnce(JSON.stringify({ ok: true, data: { confirmationToken: 'tok-1', readback: 'Friday at nine' } }));
        await tool(prepare, { bookingId: 'b-1' });
        inv.agentTurnCompleted('That is your fade on Friday at nine. Shall I go ahead?');
        inv.callerTranscribed(line);
        expect(blockedRule(await tool(commit, { confirmationToken: 'tok-1' }))).toBe('run.commit_without_yes');
        expect(handler).not.toHaveBeenCalledWith(commit, expect.anything());
      }
    },
  );

  it.each(['Go ahead.', 'Yes', 'Dale'])('a neutral yes confirms a prepared cancel: %s', async (line) => {
    const { inv, tool, handler } = make({
      agent: { tools: [{ name: 'scheduling_cancel_prepare' }, { name: 'scheduling_cancel_commit' }] },
    });
    handler.mockResolvedValueOnce(JSON.stringify({ ok: true, data: { confirmationToken: 'tok-1', readback: 'Friday at nine' } }));
    await tool('scheduling_cancel_prepare', { bookingId: 'b-1' });
    inv.agentTurnCompleted('That is your fade on Friday at nine. Shall I cancel it?');
    inv.callerTranscribed(line);
    expect(blockedRule(await tool('scheduling_cancel_commit', { confirmationToken: 'tok-1' }))).toBeUndefined();
    expect(handler).toHaveBeenLastCalledWith('scheduling_cancel_commit', { confirmationToken: 'tok-1' });
  });

  it('legacy write tools never hit the commit rules', async () => {
    const { tool } = make({ agent: { tools: [{ name: 'create_booking' }] } });
    expect(blockedRule(await tool('create_booking', { startTime: 'Friday 9' }))).toBeUndefined();
  });

  it('a handoff updates the exposed tools', async () => {
    const { inv, tool } = make();
    inv.setExposedTools([{ name: 'book_consult' }]);
    expect(blockedRule(await tool('lookup_customer', {}))).toBe('run.action_not_allowed');
    expect(blockedRule(await tool('book_consult', {}))).toBeUndefined();
  });

  it('a tool that throws is recorded as failed and the error still reaches the bridge', async () => {
    const { inv, tool, handler } = make();
    handler.mockRejectedValueOnce(new Error('boom'));
    await expect(tool('create_ticket', {})).rejects.toThrow('boom');
    expect(inv.facts.committed).toEqual([{ action: 'create_ticket', kind: 'write', ok: false, refs: [] }]);
  });
});

describe('TRANSFER', () => {
  it('no configured number: the transfer tool returns the fixed instruction instead of transferring', async () => {
    const { tool, handler } = make();
    const out = await tool('triageEscalate', { urgentConcern: 'eye pain' });
    expect(blockedRule(out)).toBe('transfer.no_number');
    expect(JSON.parse(out).message).toBe(INSTRUCTIONS['transfer.no_number']);
    expect(blockedRule(await tool('escalate_to_human', { reason: 'x', transfer_number: '+15550100000' }))).toBe('transfer.no_number');
    expect(handler).not.toHaveBeenCalled();
  });

  it('escalate_to_human without a transfer is not a transfer and runs', async () => {
    const { tool, handler } = make();
    expect(blockedRule(await tool('escalate_to_human', { reason: 'call me back' }))).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('with the agent transfer number configured, the transfer runs', async () => {
    const { tool, handler, inv } = make({
      agent: { tools: [{ name: 'triageEscalate' }], metadata: { onCallTransferNumber: '+15550100000' } },
    });
    expect(inv.facts.transferNumberConfigured).toBe(true);
    expect(blockedRule(await tool('triageEscalate', {}))).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('SAY (observe-only)', () => {
  it('logs the rule and a counter, never the text, and changes nothing else', () => {
    const { inv, log } = make();
    const before = sayObservedTotal('say.stage_direction');
    inv.agentTurnCompleted('(quietly) Filing that for you now.');
    inv.agentTurnCompleted('[pauses] One moment.');
    expect(log.info).toHaveBeenCalledWith('invariant_say_observed', { rule: 'say.stage_direction', count: 1 });
    expect(log.info).toHaveBeenCalledWith('invariant_say_observed', { rule: 'say.stage_direction', count: 2 });
    expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/Filing|pauses/);
    expect(inv.sayObservations.get('say.stage_direction')).toBe(2);
    expect(sayObservedTotal('say.stage_direction')).toBe(before + 2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a clean turn logs nothing; a turn marks the pending tool result voiced', async () => {
    const { inv, log, tool } = make();
    await tool('lookup_customer', {});
    expect(inv.facts.unvoicedToolResult).toBe(true);
    inv.agentTurnCompleted('I found your account.');
    expect(inv.facts.unvoicedToolResult).toBe(false);
    expect(log.info).not.toHaveBeenCalledWith('invariant_say_observed', expect.anything());
  });
});

describe('END (model-initiated end-call tool)', () => {
  it('an unvoiced tool result returns the fixed instruction so she speaks it first', async () => {
    const { inv, tool, handler } = make();
    inv.callerTranscribed('Hi, this is Dana, I need a fade Friday at nine');
    await tool('lookup_customer', {});
    const out = await tool('end_call', {});
    expect(blockedRule(out)).toBe('end.unvoiced_tool_result');
    expect(JSON.parse(out).message).toBe(INSTRUCTIONS['end.unvoiced_tool_result']);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('before the floor has run: evaluates the floor, then lets the end through', async () => {
    const { inv, tool, handler, runFloorAction } = make();
    inv.callerTranscribed('Hi, this is Dana, I need a fade Friday at nine');
    inv.agentTurnCompleted('Let me check that.');
    expect(inv.facts.floorEvaluated).toBe(false);
    expect(blockedRule(await tool('end_call', {}))).toBeUndefined();
    expect(runFloorAction).toHaveBeenCalledTimes(1);
    expect(inv.facts.floorEvaluated).toBe(true);
    expect(handler).toHaveBeenCalledWith('end_call', {});
    expect(handler).toHaveBeenCalledTimes(1);
    // The teardown later reuses that evaluation.
    await inv.evaluateFloor();
    expect(runFloorAction).toHaveBeenCalledTimes(1);
  });

  it('a never-heard caller ends without running the floor first', async () => {
    const { inv, runFloorAction } = make();
    await expect(inv.beforeAgentEnd()).resolves.toEqual({ ok: true });
    expect(runFloorAction).not.toHaveBeenCalled();
  });

  it('outbound call: a model-initiated end files no floor ticket', async () => {
    const { inv, tool, handler, runFloorAction, log } = make({ direction: 'outbound' });
    inv.callerTranscribed("No thanks, I'm not interested, take me off your list");
    inv.agentTurnCompleted('Understood, goodbye.');
    expect(blockedRule(await tool('end_call', {}))).toBeUndefined();
    expect(handler).toHaveBeenCalledWith('end_call', {});
    expect(runFloorAction).not.toHaveBeenCalled();
    expect(inv.facts.floorEvaluated).toBe(true);
    expect(log.info).toHaveBeenCalledWith('floor_evaluated', { outcome: 'skipped_outbound' });
  });
});

describe('floor at teardown', () => {
  it('outbound call: skipped without running the action; inbound (the default) runs it', async () => {
    const outbound = make({ direction: 'outbound' });
    outbound.inv.callerTranscribed('Take me off your list');
    await expect(outbound.inv.evaluateFloor()).resolves.toBe('skipped_outbound');
    expect(outbound.runFloorAction).not.toHaveBeenCalled();
    expect(outbound.inv.facts.floorEvaluated).toBe(true);
    expect(JSON.stringify(outbound.log.info.mock.calls)).not.toMatch(/list/);

    const inbound = make({ direction: 'inbound' });
    inbound.inv.callerTranscribed('I need a fade Friday');
    await expect(inbound.inv.evaluateFloor()).resolves.toBe('filed');
    expect(inbound.runFloorAction).toHaveBeenCalledTimes(1);
  });

  it('runs tickets.file_floor as the system actor with the floor key, the caller lines only and the language', async () => {
    const { inv, runFloorAction } = make({ agent: { tools: [{ name: 'create_ticket' }], language: 'es-MX', timeZone: 'America/Chicago' } });
    inv.agentTurnCompleted('Gracias por llamar.');
    inv.callerTranscribed('Hola, soy Dana');
    inv.callerTranscribed('  ');
    inv.callerTranscribed('Necesito un corte el viernes\na las nueve');
    // A failed write doesn't count as filed; the name it carried is kept.
    const failing = vi.fn(async (_name: string, _args: Record<string, unknown>) => JSON.stringify({ success: false }));
    await inv.wrapToolHandler(failing)('create_ticket', { customerName: 'Dana Ruiz' });
    await expect(inv.evaluateFloor()).resolves.toBe('filed');
    expect(runFloorAction).toHaveBeenCalledTimes(1);
    const [ctx, input] = runFloorAction.mock.calls[0] as [ActionContext, Record<string, unknown>];
    expect(ctx).toMatchObject({
      tenantId: 't-1',
      actor: { type: 'system', id: 'voice-runtime' },
      callId: 'cs-1',
      idempotencyKey: floorIdempotencyKey('cs-1'),
      tenantTimezone: 'America/Chicago',
      locale: 'es',
    });
    expect(input).toEqual({
      callId: 'cs-1',
      callerLines: ['Hola, soy Dana', 'Necesito un corte el viernes a las nueve'],
      callerName: 'Dana Ruiz',
      language: 'es',
      tools: [{ name: 'create_ticket', ok: false }],
      answered: false,
    });
    expect(inv.facts.floorEvaluated).toBe(true);
  });

  it('sends the recorded end reason, the tools run and whether the agent answered the last line', async () => {
    let endReason: CallOutcome | null = null;
    const { inv, runFloorAction } = make({ endReason: () => endReason });
    inv.callerTranscribed('What days does Marco work?');
    await inv.wrapToolHandler(vi.fn(async () => JSON.stringify({ success: true })))('lookup_customer', {});
    inv.agentTurnCompleted('Marco works Tuesday to Saturday.');
    endReason = 'max_duration';
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({
      endReason: 'max_duration',
      tools: [{ name: 'lookup_customer', ok: true }],
      answered: true,
    });
  });

  it('runs at most once even if teardown runs twice, concurrently or later', async () => {
    const { inv, runFloorAction } = make();
    inv.callerTranscribed('I need a fade Friday');
    const [a, b] = await Promise.all([inv.evaluateFloor(), inv.evaluateFloor()]);
    await inv.evaluateFloor();
    expect([a, b]).toEqual(['filed', 'filed']);
    expect(runFloorAction).toHaveBeenCalledTimes(1);
  });

  it('never throws: an action that throws, fails or hangs gives an outcome code, and the floor counts as evaluated', async () => {
    const thrown = make({ runFloorAction: async () => { throw new Error('db down'); } });
    await expect(thrown.inv.evaluateFloor()).resolves.toBe('error');
    expect(thrown.inv.facts.floorEvaluated).toBe(true);

    const failed = make({
      runFloorAction: async () => ({ ok: false, error: { code: 'INTERNAL', message: 'x', callerSafeMessage: 'x', retryable: true } }),
    });
    await expect(failed.inv.evaluateFloor()).resolves.toBe('action_failed');
    expect(failed.log.warn).toHaveBeenCalledWith('floor_action_failed', { code: 'INTERNAL' });

    const hung = make({ runFloorAction: () => new Promise<ActionResult>(() => {}), floorDeadlineMs: 20 });
    await expect(hung.inv.evaluateFloor()).resolves.toBe('timeout');
    expect(hung.inv.facts.floorEvaluated).toBe(true);
    expect(hung.log.info).toHaveBeenCalledWith('floor_evaluated', { outcome: 'timeout' });
  });

  it('passes the action verdict through (never_heard, nothing_substantive, already_filed)', async () => {
    for (const reason of ['never_heard', 'nothing_substantive', 'already_filed']) {
      const { inv } = make({ runFloorAction: async () => filed(reason) });
      await expect(inv.evaluateFloor()).resolves.toBe(reason);
    }
  });

  it('skips the floor when a write, commit or transfer tool returned ok on the call', async () => {
    const write = make();
    write.inv.callerTranscribed('I need a fade Friday');
    await write.tool('create_ticket', { subject: 'fade' });
    await expect(write.inv.evaluateFloor()).resolves.toBe('skipped_tool_write');
    expect(write.runFloorAction).not.toHaveBeenCalled();
    expect(write.inv.facts.floorEvaluated).toBe(true);

    const transfer = make({ agent: { tools: [{ name: 'triageEscalate' }], metadata: { onCallTransferNumber: '+15550100000' } } });
    await transfer.tool('triageEscalate', {});
    await expect(transfer.inv.evaluateFloor()).resolves.toBe('skipped_tool_write');
  });

  it('a successful read does not skip it', async () => {
    const { inv, tool, runFloorAction } = make();
    inv.callerTranscribed('I need a fade Friday');
    await tool('lookup_customer', {});
    await expect(inv.evaluateFloor()).resolves.toBe('filed');
    expect(runFloorAction).toHaveBeenCalledTimes(1);
  });

  it('waits for a write still running at hangup, then sees it', async () => {
    const { inv, handler, tool, runFloorAction } = make();
    let finish: (() => void) | undefined;
    handler.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = () => resolve(OK); }));
    const running = tool('create_ticket', {});
    // Hangup lands before the bridge has even started the tool.
    const floor = inv.evaluateFloor();
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish?.();
    await running;
    await expect(floor).resolves.toBe('skipped_tool_write');
    expect(runFloorAction).not.toHaveBeenCalled();
  });

  it('beforeFloor (the bookkeeping flush) runs after the tools in flight settle and before the floor decides', async () => {
    const order: string[] = [];
    let flushed!: () => void;
    const beforeFloor = vi.fn(() => new Promise<void>((resolve) => { flushed = () => { order.push('flushed'); resolve(); }; }));
    const { inv, handler, tool, runFloorAction } = make({ beforeFloor });
    runFloorAction.mockImplementationOnce(async () => { order.push('floor'); return filed(); });
    let finish!: () => void;
    handler.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = () => { order.push('tool done'); resolve(OK); }; }));
    inv.callerTranscribed('I need a fade Friday');
    const running = tool('lookup_customer', {});
    const floor = inv.evaluateFloor();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(beforeFloor).not.toHaveBeenCalled();
    finish();
    await running;
    await vi.waitFor(() => expect(beforeFloor).toHaveBeenCalledTimes(1));
    expect(runFloorAction).not.toHaveBeenCalled();
    flushed();
    await expect(floor).resolves.toBe('filed');
    expect(order).toEqual(['tool done', 'flushed', 'floor']);
  });

  it('beforeFloor does not change what the floor decides: an ok write still skips it, outbound never flushes', async () => {
    const beforeFloor = vi.fn(async () => {});
    const write = make({ beforeFloor });
    await write.tool('create_ticket', { subject: 'fade' });
    await expect(write.inv.evaluateFloor()).resolves.toBe('skipped_tool_write');
    expect(beforeFloor).toHaveBeenCalledTimes(1);
    const outbound = make({ beforeFloor: vi.fn(async () => {}), direction: 'outbound' });
    await expect(outbound.inv.evaluateFloor()).resolves.toBe('skipped_outbound');
  });

  it('a write that is still running after the settle wait skips the floor (no double filing)', async () => {
    const { inv, handler, tool, runFloorAction } = make({ toolSettleMs: 10 });
    handler.mockImplementationOnce(() => new Promise<string>(() => {}));
    void tool('create_ticket', {});
    await expect(inv.evaluateFloor()).resolves.toBe('skipped_tool_in_flight');
    expect(runFloorAction).not.toHaveBeenCalled();
  });

  it('a read still running after the settle wait does not stop the floor', async () => {
    const { inv, handler, tool, runFloorAction } = make({ toolSettleMs: 10 });
    handler.mockImplementationOnce(() => new Promise<string>(() => {}));
    void tool('lookup_customer', {});
    await expect(inv.evaluateFloor()).resolves.toBe('filed');
    expect(runFloorAction).toHaveBeenCalledTimes(1);
  });

  it.each(['Which location?', '¿Qué sede?', '¿Cuál sede prefiere', 'We have two shops. Which one do you mean?'])(
    'an agent clarifying question ("%s") after an info question does not count as answered',
    async (question) => {
      const { inv, runFloorAction } = make();
      inv.callerTranscribed('What are your hours?');
      inv.agentTurnCompleted(question);
      await inv.evaluateFloor();
      expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
    },
  );

  it('a clarifying question, then the caller answers and hangs up → not answered', async () => {
    const { inv, runFloorAction } = make();
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted('Sure. Which location?');
    inv.callerTranscribed('Downtown');
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

  it('the answer after a clarifying question counts as answered', async () => {
    const { inv, runFloorAction } = make();
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted('Which location?');
    inv.callerTranscribed('Downtown');
    inv.agentTurnCompleted('Downtown opens at nine and closes at seven.');
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: true });
  });

  it.each([
    'Let me check that.',
    'One moment please.',
    'Un momento, por favor.',
    'Déjeme revisar.',
    'Let me check. We open at nine.',
    "Pricing depends on the job, I'll have a technician reach out with a quote.",
    "We'll call you back with the price.",
    "I don't know if Marco works Saturdays.",
    'Le devolveremos la llamada con el precio.',
    'No tengo esa información.',
  ])(
    'a holding line ("%s") never counts as answered',
    async (hold) => {
      const { inv, runFloorAction } = make();
      inv.callerTranscribed('What are your hours?');
      inv.agentTurnCompleted(hold);
      await inv.evaluateFloor();
      expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
    },
  );

  it('a follow-up promise after an answer clears it', async () => {
    const { inv, runFloorAction } = make();
    inv.callerTranscribed('How much is a furnace tune-up?');
    inv.agentTurnCompleted('A tune-up is eighty-nine dollars.');
    inv.agentTurnCompleted("For anything more, I'll have a technician reach out with a quote.");
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

  it('a holding line, then an info tool returns ok, then the caller hangs up → not answered', async () => {
    const { inv, runFloorAction } = make();
    inv.callerTranscribed('What days does Marco work?');
    inv.agentTurnCompleted('Let me check that for you.');
    await inv.wrapToolHandler(vi.fn(async () => JSON.stringify({ success: true })))('lookup_customer', {});
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ tools: [{ name: 'lookup_customer', ok: true }], answered: false });
  });

  it('a tool starting after an answer resets answered', async () => {
    const { inv, runFloorAction } = make();
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted('We open at nine.');
    await inv.wrapToolHandler(vi.fn(async () => JSON.stringify({ success: true })))('lookup_customer', {});
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

  it('awaiting playback: an answer whose transcript completed but whose playback is not confirmed → not answered', async () => {
    const { inv, runFloorAction } = make({ awaitPlayback: true });
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted('We open at nine.');
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

  it('awaiting playback: the answer counts once its playback is confirmed', async () => {
    const { inv, runFloorAction } = make({ awaitPlayback: true });
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted('We open at nine.');
    inv.agentPlaybackConfirmed();
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: true });
  });

  it('awaiting playback: a confirmed holding line or question still does not count', async () => {
    const { inv, runFloorAction } = make({ awaitPlayback: true });
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted('One moment.');
    inv.agentPlaybackConfirmed();
    inv.agentTurnCompleted('Which location?');
    inv.agentPlaybackConfirmed();
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

  it('awaiting playback: a barge-in clears the answer, even if its mark is echoed after the clear', async () => {
    const { inv, runFloorAction } = make({ awaitPlayback: true });
    inv.callerTranscribed('What are your hours?');
    inv.agentPlaybackInterrupted();
    inv.agentTurnCompleted('We open at');
    inv.agentPlaybackConfirmed();
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

  it('the caller starts speaking after an answer and hangs up before it is transcribed → not answered', async () => {
    const { inv, runFloorAction } = make();
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted('We open at nine and close at seven.');
    inv.callerSpeechStarted();
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

  it('awaiting playback: caller speech before the mark echoes keeps the answer from counting', async () => {
    const { inv, runFloorAction } = make({ awaitPlayback: true });
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted('We open at nine.');
    inv.callerSpeechStarted();
    inv.agentPlaybackConfirmed();
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

  it('an answer after the caller speech is transcribed counts again', async () => {
    const { inv, runFloorAction } = make();
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted('We open at nine.');
    inv.callerSpeechStarted();
    inv.callerTranscribed('And on Sunday?');
    inv.agentTurnCompleted('We are closed on Sunday.');
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: true });
  });

  it.each(['Sorry, could you repeat that?', '¿Perdón, puede repetir?', 'One moment.'])(
    'an answer, then "%s" after untranscribed speech → not answered',
    async (followUp) => {
      const { inv, runFloorAction } = make();
      inv.callerTranscribed('What are your hours?');
      inv.agentTurnCompleted('We open at nine and close at seven.');
      inv.agentTurnCompleted(followUp);
      await inv.evaluateFloor();
      expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
    },
  );

  it.each(['Anything else?', '¿Algo más?', 'Is there anything else I can help you with today?'])(
    'a pure courtesy closer ("%s") after an answer keeps it answered',
    async (closer) => {
      const { inv, runFloorAction } = make();
      inv.callerTranscribed('What are your hours?');
      inv.agentTurnCompleted('We open at nine and close at seven.');
      inv.agentTurnCompleted(closer);
      await inv.evaluateFloor();
      expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: true });
    },
  );

  it.each([
    'Sorry, I missed that.',
    "That's a good question.",
    'Let me see.',
    'Hmm.',
    "I'm not sure.",
    'Okay.',
    'Got it.',
    'Sure.',
    'Perdón, no le entendí.',
    'Buena pregunta.',
    'Déjeme ver.',
    'No estoy seguro.',
  ])('awaiting playback: a confirmed turn without answer evidence ("%s") is not an answer, and the floor files', async (line) => {
    const { inv, runFloorAction } = make({ awaitPlayback: true, endReason: () => 'caller_hangup' });
    inv.callerTranscribed('What are your hours?');
    inv.agentTurnCompleted(line);
    inv.agentPlaybackConfirmed();
    await expect(inv.evaluateFloor()).resolves.toBe('filed');
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ endReason: 'caller_hangup', answered: false });
  });

  it.each(["We're open until 7 tonight.", 'Un corte cuesta $30.', "We're closed Sundays.", 'Yes, we close at seven.', 'Cerramos los domingos.'])(
    'awaiting playback: a confirmed real answer ("%s") counts as answered',
    async (answer) => {
      const { inv, runFloorAction } = make({ awaitPlayback: true });
      inv.callerTranscribed('What are your hours?');
      inv.agentTurnCompleted(answer);
      inv.agentPlaybackConfirmed();
      await inv.evaluateFloor();
      expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: true });
    },
  );

  it('awaiting playback: an answer, then a courtesy closer or a turn without evidence, stays answered', async () => {
    for (const after of ['Anything else?', 'Okay.', 'Perdón, no le entendí.']) {
      const { inv, runFloorAction } = make({ awaitPlayback: true });
      inv.callerTranscribed('What are your hours?');
      inv.agentTurnCompleted("We're open until 7 tonight.");
      inv.agentPlaybackConfirmed();
      inv.agentTurnCompleted(after);
      inv.agentPlaybackConfirmed();
      await inv.evaluateFloor();
      expect(runFloorAction.mock.calls[0][1], after).toMatchObject({ answered: true });
    }
  });

  it('a tool name past the floor limit is truncated before it reaches the floor', async () => {
    const { inv, tool, runFloorAction } = make();
    const long = `x${'y'.repeat(300)}`;
    await tool(long, {});
    await inv.evaluateFloor();
    const tools = (runFloorAction.mock.calls[0][1] as { tools: Array<{ name: string; ok: boolean }> }).tools;
    expect(tools).toEqual([{ name: long.slice(0, 128), ok: false }]);
  });

  it('a read still running after the settle wait leaves the tool list out, so the floor cannot skip', async () => {
    const { inv, handler, tool, runFloorAction } = make({ toolSettleMs: 10 });
    inv.callerTranscribed('What are your hours on Saturday?');
    handler.mockImplementationOnce(() => new Promise<string>(() => {}));
    void tool('lookup_customer', {});
    inv.agentTurnCompleted('We open at nine on Saturday.');
    await inv.evaluateFloor();
    expect(runFloorAction).toHaveBeenCalledTimes(1);
    expect(runFloorAction.mock.calls[0][1]).not.toHaveProperty('tools');
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: true });
  });

  it('record_language_change switches the floor language', async () => {
    const { inv, tool, runFloorAction } = make({ agent: { tools: [{ name: 'record_language_change' }], language: 'en' } });
    await tool('record_language_change', { language: 'es' });
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ language: 'es' });
  });

  it('logs only the outcome code', async () => {
    const { inv, log } = make();
    inv.callerTranscribed('Hi, this is Dana, call me at 555 010 0142');
    await inv.evaluateFloor();
    expect(log.info).toHaveBeenCalledWith('floor_evaluated', { outcome: 'filed' });
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toMatch(/Dana|0142/);
  });
});

describe('call facts', () => {
  it('starts from the agent config: tools, transfer number, refs texted by default, SMS flag, speakable numbers', () => {
    const { inv } = make({
      agent: { tools: [{ name: 'a' }], metadata: { onCallTransferNumber: ' +15550100000 ', businessPhone: '+15550123456' } },
      smsEnabled: () => true,
    });
    expect(inv.facts).toMatchObject({
      callId: 'cs-1',
      heard: false,
      allowedActions: ['a'],
      transferNumberConfigured: true,
      voiceRefs: false,
      smsEnabled: true,
      floorEvaluated: false,
    });
    expect(inv.facts.speakableNumbers).toEqual(['+15550199999', '+15550100142', '+15550100000', '+15550123456']);
  });

  it('heard comes from the first non-blank caller transcript', () => {
    const { inv } = make();
    inv.callerTranscribed('   ');
    expect(inv.facts.heard).toBe(false);
    expect(inv.callerLineCount).toBe(0);
    inv.callerTranscribed('hello?');
    expect(inv.facts.heard).toBe(true);
    expect(inv.callerLineCount).toBe(1);
  });

  it('reads the SMS flag from the existing SMS_ENABLED reader by default', () => {
    const prev = process.env.SMS_ENABLED;
    process.env.SMS_ENABLED = 'true';
    try {
      expect(make({ smsEnabled: undefined }).inv.facts.smsEnabled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SMS_ENABLED;
      else process.env.SMS_ENABLED = prev;
    }
  });
});

describe('isHoldingLine: broad follow-up and don\'t-know replies (review P2)', () => {
  it.each([
    'No sé el precio exacto.', 'No lo sé.', 'Lo llamaremos mañana con el precio.', 'Te llamamos más tarde.',
    'Le vamos a llamar.', 'A technician will call you with a quote.', "We'll call you with pricing.",
    'Someone from our team will call you.', 'We will follow up.', "I can't give pricing over the phone.",
    'No podemos dar precios por teléfono.', 'I\'ll pass that along.',
  ])('is not an answer: %s', (line) => {
    expect(isHoldingLine(line)).toBe(true);
  });
  it.each(['We close at five on Saturdays.', 'Cerramos a las cinco.', 'A haircut is thirty dollars.'])('a real answer still counts: %s', (line) => {
    expect(isHoldingLine(line)).toBe(false);
  });
});
