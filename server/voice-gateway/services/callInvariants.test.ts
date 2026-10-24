import { describe, expect, it, vi } from 'vitest';
import { INSTRUCTIONS, SUCCESS_RUN_CEILING } from '../../../platform/callcore/invariants';
import { floorIdempotencyKey } from '../../../platform/actions/tickets';
import type { ActionContext, ActionResult } from '../../../platform/actions';
import {
  CallInvariants,
  END_CALL_TOOLS,
  isExplicitYes,
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
    expect(isExplicitYes('Book it.')).toBe(true);
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
    });
    expect(inv.facts.floorEvaluated).toBe(true);
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
