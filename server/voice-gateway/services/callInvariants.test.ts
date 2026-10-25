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
    for (const text of [
      'Let me check that.', 'Let me look into it', 'Just a second.', 'Hold on.', 'Hang on.', 'Hold, please.', 'Please hold.',
      'Bear with me while I check.', "I'll check with Marco.", 'Un momento.', 'Déjeme revisar.', 'Permítame verificar.',
      'Permítame.', 'Permitame, por favor.', 'Espere.', 'Espéreme tantito.', 'Voy a revisar.',
    ]) {
      expect(isHoldingLine(text), text).toBe(true);
    }
    for (const text of ['We open at nine.', 'We have a second location downtown.', 'Abrimos a las nueve.', 'Permítame decirle que sí tenemos.', 'Disculpe la espera.', '']) {
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

  it.each([
    'Lisa works Mon–Fri.',
    "We're open Tue through Sat.",
    'Tue through Sat.',
    'Lisa works Mon. to Thurs.',
    'Mon, Wed, Fri.',
    'Sat & Sun.',
    'Trabaja de lun a vie.',
    'De mar a dom.',
    'Sábados y dom.',
    'Lun a sáb.',
    'Mon–Thu.',
    'Mon thru Thurs.',
    'De lun al vie.',
    'Tue—Sat.',
  ])('awaiting playback: weekday abbreviations ("%s") count as answered', async (answer) => {
    const { inv, runFloorAction } = make({ awaitPlayback: true });
    inv.callerTranscribed('When does Lisa work?');
    inv.agentTurnCompleted(answer);
    inv.agentPlaybackConfirmed();
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: true });
  });

  it.each([
    'I sat down.',
    'Enjoy the sun!',
    'Sorry, I missed that.',
    'Wed like to help.',
    'Mar.',
    'El mar está bonito.',
    "C'mon, sorry.",
    'C’mon, sorry.',
    'Got it, a full set with Thu.',
    'Okay, Thu.',
  ])(
    'awaiting playback: a word that only looks like a weekday abbreviation ("%s") is not an answer',
    async (line) => {
      const { inv, runFloorAction } = make({ awaitPlayback: true, endReason: () => 'caller_hangup' });
      inv.callerTranscribed('When does Lisa work?');
      inv.agentTurnCompleted(line);
      inv.agentPlaybackConfirmed();
      await expect(inv.evaluateFloor()).resolves.toBe('filed');
      expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
    },
  );

  it.each([
    'One p.m.',
    'We close at one pm.',
    'At one o’clock.',
    "At one o'clock.",
    'One a.m.',
    'One o clock.',
    'One in the afternoon.',
    'We close at one.',
    'Half past one.',
    'Quarter to one.',
    'She’s in until one.',
    'A la una.',
    'La una y media.',
    'A la una de la tarde.',
    'Cerramos a la una.',
    'Una de la tarde.',
    'Una y cuarto.',
  ])('awaiting playback: the hour one as a time ("%s") counts as answered', async (answer) => {
    const { inv, runFloorAction } = make({ awaitPlayback: true });
    inv.callerTranscribed('What time do you close?');
    inv.agentTurnCompleted(answer);
    inv.agentPlaybackConfirmed();
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: true });
  });

  it.each([
    'One moment.',
    'Give me one second.',
    'Which one?',
    'We have one amazing stylist.',
    'Until one of us is free.',
    'At one point we moved.',
    'We see them one by one.',
    'Es una pregunta.',
    'Una pregunta más.',
  ])('awaiting playback: "one" or "una" outside a time ("%s") is not an answer', async (line) => {
    const { inv, runFloorAction } = make({ awaitPlayback: true, endReason: () => 'caller_hangup' });
    inv.callerTranscribed('What time do you close?');
    inv.agentTurnCompleted(line);
    inv.agentPlaybackConfirmed();
    await expect(inv.evaluateFloor()).resolves.toBe('filed');
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

  const answeredFor = async (question: string, reply: string) => {
    const { inv, runFloorAction } = make({ awaitPlayback: true, endReason: () => 'caller_hangup' });
    inv.callerTranscribed(question);
    inv.agentTurnCompleted(reply);
    inv.agentPlaybackConfirmed();
    await inv.evaluateFloor();
    return (runFloorAction.mock.calls[0][1] as { answered: boolean }).answered;
  };

  it.each([
    ['Are you open on Saturday?', 'Yes, we are.'],
    ['Are you open on Saturday?', 'Yes.'],
    ['Are you open on Saturday?', 'Yes we are.'],
    ['Do you do oil changes?', "No, we don't."],
    ['Do you do oil changes?', 'Nope.'],
    ['Is there parking?', 'Yep, out back.'],
    ['Do you have a website?', 'Of course!'],
    ['Does Marco work Saturdays?', 'Correct.'],
    ['¿Están abiertos hoy?', 'Sí, estamos abiertos.'],
    ['¿Están abiertos hoy?', 'Sí.'],
    ['¿Ofrecen cambios de aceite?', 'Claro.'],
    ['¿Tienen estacionamiento?', 'Por supuesto.'],
    ['¿Ofrecen cambios de aceite?', 'No, solo hacemos frenos.'],
  ])('a yes/no question ("%s") is answered by a leading yes or no ("%s")', async (question, reply) => {
    expect(await answeredFor(question, reply)).toBe(true);
  });

  it.each([
    ['How much is an oil change?', "It's free."],
    ['How much is an oil change?', 'No charge.'],
    ['How much is an oil change?', "There's no cost for that."],
    ['How much is an oil change?', "It's complimentary with a tire rotation."],
    ['¿Cuánto cuesta un cambio de aceite?', 'Es gratis.'],
    ['¿Cuánto cuesta un cambio de aceite?', 'Sin costo.'],
    ['¿Cuánto cuesta un cambio de aceite?', 'Es gratuito.'],
    ['¿Cuál es el precio de las llantas?', 'Sin cargo.'],
    ['How much is an oil change?', 'Oil changes are free this month.'],
    ['How much is an oil change?', 'The first one is free.'],
    ['How much is an oil change?', "That's totally free."],
    ['How much is an oil change?', 'Completely free with a tire rotation.'],
    ['How much is an oil change?', 'We do it free of charge.'],
    ['How much is an oil change?', 'We do that for free.'],
    ['How much is an oil change?', 'Free.'],
    ['¿Cuánto cuestan los cambios de aceite?', 'Son gratis.'],
    ['¿Cuánto cuesta un cambio de aceite?', 'Es totalmente gratis.'],
    ['¿Cuánto cuesta un cambio de aceite?', 'Gratis con la rotación de llantas.'],
  ])('a price question ("%s") is answered by "free" ("%s")', async (question, reply) => {
    expect(await answeredFor(question, reply)).toBe(true);
  });

  it.each([
    ['Where are you located?', "We're right next to the post office."],
    ['Where are you located?', 'Across the street from the high school.'],
    ['¿Dónde están ubicados?', 'Estamos enfrente del parque.'],
    ['¿Dónde están ubicados?', 'Cerca de la plaza.'],
  ])('a location question ("%s") is answered by a landmark ("%s")', async (question, reply) => {
    expect(await answeredFor(question, reply)).toBe(true);
  });

  it.each([
    'Are you open on Saturday?',
    '¿Están abiertos hoy?',
    'What are your hours?',
    'How much is an oil change?',
    'Where are you located?',
    'Does Marco work Saturdays?',
    'What services do you offer?',
    'I need a fade Friday.',
  ])('filler never answers, whatever was asked ("%s")', async (question) => {
    for (const reply of [
      'Sorry, I missed that.',
      'One moment.',
      'Lo siento, no le escuché.',
      'Okay.',
      "No, I don't know.",
      'No, sorry, I missed that.',
      'No, perdón, ¿me repite?',
      'Sí, un momento.',
      'Anything else?',
    ]) {
      expect(await answeredFor(question, reply), reply).toBe(false);
    }
  });

  it.each([
    ['Are you open on Saturday?', 'Sure.'],
    ['Does Marco work Saturdays?', 'Yes, he does.'],
    ['¿Están abiertos hoy?', 'Sí, estamos abiertos.'],
    ['Is there parking?', 'Yes, out back. Anything else I can help with?'],
    ['Do you have a website?', 'Of course! Anything else I can help you with?'],
    ['How much is an oil change?', 'Free with any tire purchase.'],
  ])('a typed answer stands beside help or a courtesy question ("%s" → "%s")', async (question, reply) => {
    expect(await answeredFor(question, reply)).toBe(true);
  });

  it.each([
    // "What days does {N} work" asks for days, not a yes or no.
    ['What days does Marco work?', 'Sure.'],
    ['What days does Marco work?', 'Of course.'],
    ['What days does Marco work?', 'Yes.'],
    ['¿Qué días trabaja Marco?', 'Claro.'],
    ['¿Qué días trabaja Marco?', 'Sí.'],
    // An acknowledgement that opens the turn is not a yes or no.
    ['Are you open on Saturday?', 'Sure, I can help with that.'],
    ['Is there parking?', "Of course, I'd be happy to help."],
    ['Do you do oil changes?', 'Sure, let me look into that.'],
    ['Are you open on Saturday?', 'Yes, I can help you with that.'],
    ['Is there parking?', "Yeah, I'm glad to assist."],
    ['Are you open on Saturday?', 'Sure! Happy to help.'],
    ['¿Están abiertos hoy?', 'Claro, con gusto le ayudo.'],
    ['¿Están abiertos hoy?', 'Claro. Con gusto le ayudo.'],
    ['¿Tienen estacionamiento?', 'Sí, le puedo ayudar con eso.'],
    ['¿Ofrecen cambios de aceite?', 'Por supuesto, en qué le puedo ayudar.'],
    // A yes or no before not hearing the caller or a bad line.
    ['Are you open on Saturday?', "No, sorry, I didn't understand that."],
    ['Are you open on Saturday?', "No, sorry, I couldn't hear you."],
    ['Are you open on Saturday?', "No, sorry, I didn't quite catch that."],
    ['Are you open on Saturday?', "Yes, sorry, you're breaking up."],
    ['Are you open on Saturday?', "Yes, sorry, you're cutting out."],
    ['Are you open on Saturday?', "No, sorry, I can't make out what you said."],
    ['Is there parking?', "Yeah, sorry, it's a bad connection."],
    ['¿Están abiertos hoy?', 'No, perdón, no le entendí.'],
    ['¿Están abiertos hoy?', 'Sí, lo siento, no le oigo bien.'],
    ['¿Están abiertos hoy?', 'Sí, lo siento, se corta.'],
    ['¿Están abiertos hoy?', 'Sí, lo siento, se está cortando la llamada.'],
    ['¿Tienen estacionamiento?', 'No, lo siento, no se escucha.'],
    ['¿Ofrecen cambio de aceite?', 'Sí, con mucho gusto.'],
    // A yes that only holds the line.
    ['Do you do brake jobs?', 'Yes, hang on.'],
    ['Do you do brake jobs?', 'Yes, please hold while I check.'],
    ['Do you do brake jobs?', 'Yes, hold please.'],
    ['Do you do brake jobs?', 'Yeah, while I look.'],
    ['¿Tienen estacionamiento?', 'Sí, permítame.'],
    ['¿Tienen estacionamiento?', 'Sí, permítame un momento.'],
    ['¿Tienen estacionamiento?', 'Sí, espere.'],
    ['¿Tienen estacionamiento?', 'Sí, espéreme.'],
    // "Free" that is no price.
    ['How much is an oil change?', 'Call our toll free line.'],
    ['How much is an oil change?', "It's not free."],
    ['¿Cuánto cuesta un cambio de aceite?', 'No es gratis.'],
    ['How much is a brake job?', 'We offer free estimates, so bring it in anytime.'],
    ['How much is a brake job?', 'Free consultations are available.'],
    ['How much is a haircut?', "Whenever you're free, swing by and we'll take a look."],
    ['How much is a haircut?', "You're free to stop by anytime."],
    ['How much is a haircut?', 'If you are free, come on in.'],
    ['How much is an oil change?', "It wouldn't be free."],
    ['How much is an oil change?', "It won't be free of charge."],
    ['How much is an oil change?', "It isn't totally free."],
    ['How much is an oil change?', "That's not for free."],
    ['¿Cuánto cuesta un cambio de aceite?', 'Ofrecemos consultas gratuitas.'],
    ['¿Cuánto cuesta un cambio de aceite?', 'No es gratuito.'],
    ['¿Cuánto cuesta un cambio de aceite?', 'No, no son gratis.'],
    ['¿Cuánto cuesta un corte?', 'Cuando esté libre, venga.'],
  ])('filler or a non-answer does not answer "%s" ("%s")', async (question, reply) => {
    expect(await answeredFor(question, reply)).toBe(false);
  });

  it('a yes/no answer about a haircut is not mistaken for a bad line ("se corta el pelo")', async () => {
    expect(await answeredFor('¿Ofrecen cortes de pelo?', 'Sí, aquí se corta el pelo a niños y adultos.')).toBe(true);
  });

  // By design a bare yes or no answers only a yes/no or "does {N} work Saturdays" question, and "free" only a price question.
  it.each([
    ['What are your hours?', 'Yes.'],
    ['What time do you close?', 'Sure.'],
    ['How much is an oil change?', 'Yes.'],
    ['Where are you located?', 'Yes.'],
    ['What services do you offer?', 'Yes.'],
    ['¿A qué hora cierran?', 'Sí.'],
    ['What are your hours?', "It's free."],
    ['Are you open on Saturday?', "It's free."],
    ['¿A qué hora cierran?', 'Es gratis.'],
    ['How much is an oil change?', "We're right next to the post office."],
    ['Are you open on Saturday?', 'No problem.'],
    ['Are you open on Saturday?', 'Feel free to stop by.'],
  ])('evidence for another question type does not answer "%s" ("%s")', async (question, reply) => {
    expect(await answeredFor(question, reply)).toBe(false);
  });

  // A line that asks two things needs typed evidence for each; a time, day, price or place word covers any.
  it.each([
    ['Is there parking? How much is an oil change?', 'Yes, there is.', false],
    ['Is there parking? How much is an oil change?', "Yes, and it's $40.", true],
    ['Is there parking? How much is an oil change?', "Yes, and it's free.", true],
    ['Are you open Saturday? What time do you close?', 'Yes.', false],
    ['Are you open Saturday? What time do you close?', 'Yes, until five.', true],
    ['Is there parking? Where are you located?', 'Yes, next to the post office.', true],
    ['¿Tienen estacionamiento? ¿Cuánto cuesta un cambio de aceite?', 'Sí, tenemos.', false],
    ['¿Tienen estacionamiento? ¿Cuánto cuesta un cambio de aceite?', 'Sí, y cuesta 40 dólares.', true],
    ['¿Tienen estacionamiento? ¿Cuánto cuesta un cambio de aceite?', 'Sí, y es gratis.', true],
  ])('two questions ("%s") answered by "%s": %s', async (question, reply, expected) => {
    expect(await answeredFor(question, reply)).toBe(expected);
  });

  it('the type follows the caller\'s last line: a clarification answer resets it', async () => {
    const { inv, runFloorAction } = make();
    inv.callerTranscribed('Are you open on Saturday?');
    inv.agentTurnCompleted('Which location?');
    inv.callerTranscribed('Downtown');
    inv.agentTurnCompleted('Yes.');
    await inv.evaluateFloor();
    expect(runFloorAction.mock.calls[0][1]).toMatchObject({ answered: false });
  });

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
