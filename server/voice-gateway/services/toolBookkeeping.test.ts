/**
 * RT-14 prereq item 1: a contract tool call gets the bookkeeping every other
 * tool gets: one tool_invocations start + complete with the right status,
 * tool_start/tool_end events with the call state moves, the observability
 * error for a failure, exactly one tool-execution meter increment and the
 * trial check.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createToolExecution: vi.fn(async (..._args: unknown[]) => 'exec-1'),
  completeToolExecution: vi.fn(async (..._args: unknown[]) => {}),
  writeCallEvent: vi.fn(async (..._args: unknown[]) => {}),
  updateCallState: vi.fn(async (..._args: unknown[]) => {}),
  recordToolExecution: vi.fn(async (..._args: unknown[]) => {}),
  logError: vi.fn(),
  checkTrialLimits: vi.fn(async () => ({ isTrial: true, allowed: true, usage: { toolExecutions: 1, maxToolExecutions: 100 } })),
}));

vi.mock('../../../platform/tools/ToolExecutionService', () => ({
  createToolExecution: m.createToolExecution,
  completeToolExecution: m.completeToolExecution,
}));
vi.mock('./callPersistence', () => ({
  writeCallEvent: m.writeCallEvent,
  updateCallState: m.updateCallState,
  // One transaction for the pair; recorded as the two writes it holds, in order.
  updateCallStateWithEvent: async (tenantId: string, callId: string, state: string, event: { type: string; from: unknown; to: unknown; payload?: unknown }) => {
    await m.updateCallState(tenantId, callId, state);
    await m.writeCallEvent(tenantId, callId, event.type, event.from, event.to, event.payload);
  },
}));
vi.mock('../../../platform/billing/usage/UsageRecorder', () => ({ recordToolExecution: m.recordToolExecution }));
vi.mock('../../../platform/core/observability', () => ({ logError: m.logError }));
vi.mock('../../../platform/billing/guardrails/TrialGuard', () => ({ checkTrialLimits: m.checkTrialLimits }));

import { compose } from '../../../platform/agent-runtime/composer';
import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import { actionFail, actionOk, type ActionResult } from '../../../platform/actions';
import { ToolStopGuard } from '../../../platform/tools/ToolStopGuard';
import { BookkeepingQueue } from './bookkeepingQueue';
import { ContractToolBridge, type ContractActionRunner } from './contractToolBridge';
import { containsUuid } from './contractToolHandles';
import { runContractTool as runQueued, type ToolRunCall } from './toolBookkeeping';

let queue = new BookkeepingQueue();

/** runContractTool, then the call's queued bookkeeping written (what these checks read). */
async function runContractTool(...args: [Parameters<typeof runQueued>[0], ToolRunCall, Parameters<typeof runQueued>[2]?]): Promise<string> {
  const out = await runQueued(args[0], args[1], args[2], queue);
  expect(await queue.flush()).toBe('drained');
  return out;
}

const BINDING = compose(BARBERSHOP_TEMPLATE_V1, undefined, { businessName: 'Sharp Line Barbers' }, { language: 'en' }).contractTools;

function bridge(runner: ContractActionRunner, over: Partial<ConstructorParameters<typeof ContractToolBridge>[0]> = {}) {
  return new ContractToolBridge({
    tenantId: 't-shop',
    callId: 'cs-book',
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

function call(toolName: string, args: Record<string, unknown> = {}, over: Partial<ToolRunCall> = {}): ToolRunCall {
  return { tenantId: 't-shop' as never, callSessionId: 'cs-book', agentId: 'ag-shop', toolName, args, ...over };
}

const events = () => m.writeCallEvent.mock.calls.map((c) => c[2]);
const states = () => m.updateCallState.mock.calls.map((c) => c[2]);
const completed = () => m.completeToolExecution.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockClear();
  queue = new BookkeepingQueue();
});

/** One start + one complete row, tool_start → tool_end, one meter increment. */
function expectOneRun(toolName: string, status: string) {
  expect(m.createToolExecution).toHaveBeenCalledTimes(1);
  expect(m.createToolExecution.mock.calls[0][0]).toMatchObject({ tenantId: 't-shop', callSessionId: 'cs-book', agentId: 'ag-shop', agentSlug: 'ag-shop', toolName });
  expect(m.completeToolExecution).toHaveBeenCalledTimes(1);
  expect(completed()[0]).toMatchObject({ tenantId: 't-shop', executionId: 'exec-1', callSessionId: 'cs-book', status });
  expect(typeof completed()[0].durationMs).toBe('number');
  expect(events()).toEqual(['tool_start', 'tool_end']);
  expect(m.writeCallEvent.mock.calls[1][5]).toMatchObject({ tool: toolName, executionId: 'exec-1', status });
  expect(states()).toEqual(['TOOL_EXECUTION', 'ACTIVE_CONVERSATION']);
  expect(m.recordToolExecution).toHaveBeenCalledTimes(1);
  expect(m.recordToolExecution).toHaveBeenCalledWith('t-shop', 1);
}

describe('runContractTool bookkeeping', () => {
  it('ok: a success row holding what the model got (no internal ids), no error log', async () => {
    const bookingId = randomUUID();
    const b = bridge(async () => actionOk({ bookingId, status: 'confirmed', readback: 'Confirmed.' }, { readback: 'Confirmed.' }));
    const out = await runContractTool(b, call('scheduling_book_commit', { confirmationToken: randomUUID() }));
    expect(JSON.parse(out).ok).toBe(true);
    expectOneRun('scheduling_book_commit', 'success');
    expect(completed()[0].result).toEqual(JSON.parse(out));
    expect(completed()[0].errorMessage).toBeUndefined();
    expect(containsUuid(JSON.stringify(completed()[0].result))).toBe(false);
    expect(m.logError).not.toHaveBeenCalled();
  });

  it('SLOT_MISSING: an ask is a success row (not a tool failure), with the template\'s ask', async () => {
    const b = bridge(async () => actionFail('SLOT_MISSING', 'missing staff', { askId: 'ask.staff', field: 'staff' }));
    const out = JSON.parse(await runContractTool(b, call('scheduling_book_prepare', { serviceIds: ['s'] })));
    expect(out.error.callerSafeMessage).toBe(BARBERSHOP_TEMPLATE_V1.asks['ask.staff'].en);
    expectOneRun('scheduling_book_prepare', 'success');
    expect(m.logError).not.toHaveBeenCalled();
  });

  it('failure: a failed row with the error code and recovery text, and one observability error', async () => {
    const b = bridge(async () => actionFail('CONFLICT', 'slot taken'));
    await runContractTool(b, call('scheduling_book_prepare', { serviceIds: ['s'] }));
    expectOneRun('scheduling_book_prepare', 'failed');
    expect(completed()[0]).toMatchObject({ errorMessage: 'CONFLICT: slot taken' });
    expect(typeof completed()[0].recoveryAction).toBe('string');
    expect(m.logError).toHaveBeenCalledTimes(1);
    expect(m.logError.mock.calls[0][2]).toMatch(/scheduling_book_prepare/);
  });

  it('timeout: a timeout row, one observability error, still one meter increment', async () => {
    const b = bridge(() => new Promise<ActionResult>(() => {}));
    const out = JSON.parse(await runContractTool(b, call('scheduling_book_commit', { confirmationToken: randomUUID() })));
    expect(out.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expectOneRun('scheduling_book_commit', 'timeout');
    expect(completed()[0].errorMessage).toMatch(/^UPSTREAM_UNAVAILABLE: /);
    expect(completed()[0].recoveryAction).toBeUndefined();
    expect(m.logError).toHaveBeenCalledTimes(1);
  });

  it('a thrown action is a failed row', async () => {
    const b = bridge(async () => {
      throw new Error('db down');
    });
    await runContractTool(b, call('scheduling_list_services'));
    expectOneRun('scheduling_list_services', 'failed');
    expect(JSON.stringify(completed()[0])).not.toContain('db down');
  });

  it('a stopped tool (nothing runs) still gets its row and events, like the legacy stop', async () => {
    const guard = new ToolStopGuard();
    for (let i = 0; i < guard.threshold; i++) guard.recordFailure('cs-book', 'scheduling_list_services');
    const run = vi.fn<ContractActionRunner>(async () => actionOk([]));
    const out = JSON.parse(await runContractTool(bridge(run, { stopGuard: guard }), call('scheduling_list_services')));
    expect(out.code).toBe('TOOL_STOPPED');
    expect(run).not.toHaveBeenCalled();
    expectOneRun('scheduling_list_services', 'failed');
    expect(completed()[0].errorMessage).toBe('TOOL_STOPPED');
  });

  it('rate-limited: one failed row as the legacy path writes it, no events, no metering', async () => {
    const run = vi.fn<ContractActionRunner>(async () => actionOk([]));
    const out = JSON.parse(await runContractTool(bridge(run, { checkRateLimit: () => false }), call('scheduling_list_services')));
    expect(out.error.code).toBe('RATE_LIMITED');
    expect(run).not.toHaveBeenCalled();
    expect(m.createToolExecution).toHaveBeenCalledTimes(1);
    expect(completed()).toEqual([expect.objectContaining({ status: 'failed', result: { success: false, reason: 'rate_limited' }, errorMessage: 'Rate limit exceeded' })]);
    expect(events()).toEqual([]);
    expect(m.recordToolExecution).not.toHaveBeenCalled();
  });

  it('a workflow call writes workflow_execution_start first; a trial call runs the trial check once', async () => {
    const b = bridge(async () => actionOk([]));
    await runContractTool(b, call('scheduling_list_services', {}, { workflow: true, isTrial: true }));
    expect(events()).toEqual(['workflow_execution_start', 'tool_start', 'tool_end']);
    expect(states()).toEqual(['WORKFLOW_EXECUTION', 'TOOL_EXECUTION', 'ACTIVE_CONVERSATION']);
    expect(m.checkTrialLimits).toHaveBeenCalledTimes(1);
    expect(m.recordToolExecution).toHaveBeenCalledTimes(1);
  });
});

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

describe('RT-HOLD-LINE part 2: the critical path', () => {
  it('the model gets the output while the bookkeeping is still queued; the writes then run in the old order', async () => {
    const order: string[] = [];
    const db = gate();
    m.createToolExecution.mockImplementationOnce(async () => { await db.opened; order.push('create'); return 'exec-1'; });
    m.updateCallState.mockImplementation(async (...args: unknown[]) => { order.push(`state ${String(args[2])}`); });
    m.writeCallEvent.mockImplementation(async (...args: unknown[]) => { order.push(`event ${String(args[2])}`); });
    m.completeToolExecution.mockImplementationOnce(async () => { order.push('complete'); });
    m.recordToolExecution.mockImplementationOnce(async () => { order.push('meter'); });
    const action = vi.fn<ContractActionRunner>(async () => { order.push('action'); return actionOk([]); });

    const out = await runQueued(bridge(action), call('scheduling_list_services'), undefined, queue);
    order.push('output to the model');
    expect(JSON.parse(out).ok).toBe(true);
    // The action ran without waiting for the row insert; nothing is written yet.
    expect(order).toEqual(['action', 'output to the model']);
    expect(queue.depth).toBeGreaterThan(0);

    db.open();
    expect(await queue.flush()).toBe('drained');
    expect(order).toEqual([
      'action', 'output to the model',
      'create', 'state TOOL_EXECUTION', 'event tool_start',
      'complete', 'state ACTIVE_CONVERSATION', 'event tool_end', 'meter',
    ]);
    m.updateCallState.mockReset();
    m.writeCallEvent.mockReset();
  });

  it('a later write gets the row id from the earlier insert inside the queue', async () => {
    m.createToolExecution.mockImplementationOnce(async () => 'exec-from-insert');
    await runContractTool(bridge(async () => actionOk([])), call('scheduling_list_staff'));
    expect(completed()[0].executionId).toBe('exec-from-insert');
    expect(m.writeCallEvent.mock.calls.map((c) => (c[5] as { executionId?: string }).executionId)).toEqual(['exec-from-insert', 'exec-from-insert']);
  });

  it('a failed bookkeeping write never reaches the model and the rest still land', async () => {
    m.createToolExecution.mockImplementationOnce(async () => { throw new Error('db down'); });
    const out = JSON.parse(await runQueued(bridge(async () => actionOk([])), call('scheduling_list_services'), undefined, queue));
    expect(out.ok).toBe(true);
    // The writes that need the row id fail at once (logged); the meter, which doesn't, still lands.
    expect(await queue.flush('test', 500)).toBe('drained');
    expect(m.completeToolExecution).not.toHaveBeenCalled();
    expect(m.recordToolExecution).toHaveBeenCalledTimes(1);
  });
});

describe('RT-HOLD-LINE part 2: gates stay before the action', () => {
  it('the rate limit counts calls in memory: a refusal is decided at once even while earlier rows are still queued', async () => {
    const db = gate();
    m.createToolExecution.mockImplementation(async () => { await db.opened; return 'exec-1'; });
    let allowed = 2;
    const run = vi.fn<ContractActionRunner>(async () => actionOk([]));
    const b = bridge(run, { checkRateLimit: () => allowed-- > 0 });

    for (let i = 0; i < 2; i += 1) expect(JSON.parse(await runQueued(b, call('scheduling_list_services', { query: `q${i}` }), undefined, queue)).ok).toBe(true);
    // Nothing is written yet (the DB is stuck), and the third call is refused anyway, before its action.
    expect(m.completeToolExecution).not.toHaveBeenCalled();
    const refused = JSON.parse(await runQueued(b, call('scheduling_list_services', { query: 'q2' }), undefined, queue));
    expect(refused.error.code).toBe('RATE_LIMITED');
    expect(run).toHaveBeenCalledTimes(2);

    db.open();
    expect(await queue.flush()).toBe('drained');
    // The refusal is the same single failed row as before, after the two runs' rows.
    expect(completed().map((c) => [c.status, (c.result as { reason?: string }).reason ?? null])).toEqual([
      ['success', null], ['success', null], ['failed', 'rate_limited'],
    ]);
    expect(events()).toEqual(['tool_start', 'tool_end', 'tool_start', 'tool_end']);
    expect(m.recordToolExecution).toHaveBeenCalledTimes(2);
    m.createToolExecution.mockReset();
    m.createToolExecution.mockImplementation(async () => 'exec-1');
  });
});

describe('RT-HOLD-LINE part 2: call-stable reads from the call cache', () => {
  const SERVICE_ID = randomUUID();
  const STAFF_ID = randomUUID();
  const catalog = () => actionOk([{ id: SERVICE_ID, name: 'Cut', durationMin: 30, priceText: '$30', staffIds: [STAFF_ID] }]);

  it('the binding marks list_services and list_staff call-stable, never check_availability', () => {
    expect(BINDING.cacheable).toEqual({ 'scheduling.list_services': 'call', 'scheduling.list_staff': 'call' });
  });

  it('list_services twice with the same args: one DB read, two success rows, the same handles', async () => {
    const run = vi.fn<ContractActionRunner>(async () => catalog());
    const b = bridge(run);
    const first = await runContractTool(b, call('scheduling_list_services', { query: 'cut' }));
    // Key order and stray whitespace don't make it a different read.
    const second = await runContractTool(b, call('scheduling_list_services', { query: ' cut ', lang: undefined }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(containsUuid(first)).toBe(false);
    // Billing and logs stay truthful: each call has its own row, events and meter increment.
    expect(m.createToolExecution).toHaveBeenCalledTimes(2);
    expect(completed().map((c) => c.status)).toEqual(['success', 'success']);
    expect(events()).toEqual(['tool_start', 'tool_end', 'tool_start', 'tool_end']);
    expect(m.recordToolExecution).toHaveBeenCalledTimes(2);

    // The cached handle still resolves to the real id in a later call.
    const handle = (JSON.parse(second).data as Array<{ id: string }>)[0].id;
    run.mockImplementationOnce(async () => actionOk({ slots: [] }));
    await runContractTool(b, call('scheduling_check_availability', { serviceIds: [handle], staffId: 'any' }));
    expect((run.mock.calls[1][2] as { serviceIds: string[] }).serviceIds).toEqual([SERVICE_ID]);
  });

  it('a cache hit is flagged on the run (tool_timing cache_hit), a first read is not', async () => {
    const b = bridge(async () => catalog());
    const runs: Array<boolean | undefined> = [];
    await runContractTool(b, call('scheduling_list_staff'), (r) => runs.push(r.cacheHit));
    await runContractTool(b, call('scheduling_list_staff'), (r) => runs.push(r.cacheHit));
    expect(runs).toEqual([undefined, true]);
  });

  it('different args are two reads', async () => {
    const run = vi.fn<ContractActionRunner>(async () => catalog());
    const b = bridge(run);
    await runContractTool(b, call('scheduling_list_services', { query: 'cut' }));
    await runContractTool(b, call('scheduling_list_services', { query: 'beard' }));
    await runContractTool(b, call('scheduling_list_services', { staffId: 'any' }));
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('check_availability is never cached: slots change', async () => {
    const run = vi.fn<ContractActionRunner>(async () => actionOk({ slots: [] }));
    const b = bridge(run);
    for (let i = 0; i < 3; i += 1) await runContractTool(b, call('scheduling_check_availability', { serviceIds: ['s'], staffId: 'any', date: '2026-10-21' }));
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('a failed or asked read is not cached: the next identical call reads again', async () => {
    const run = vi.fn<ContractActionRunner>(async () => actionFail('INTERNAL', 'db down'));
    const b = bridge(run);
    await runContractTool(b, call('scheduling_list_services'));
    run.mockImplementation(async () => catalog());
    await runContractTool(b, call('scheduling_list_services'));
    await runContractTool(b, call('scheduling_list_services'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('the cache is per call: two calls (two bridges) of the same tenant read twice', async () => {
    const run = vi.fn<ContractActionRunner>(async () => catalog());
    await runContractTool(bridge(run, { callId: 'cs-one' }), call('scheduling_list_services', {}, { callSessionId: 'cs-one' }));
    await runContractTool(bridge(run, { callId: 'cs-two' }), call('scheduling_list_services', {}, { callSessionId: 'cs-two' }));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a cached read still counts against the rate limit, decided before the cache', async () => {
    const run = vi.fn<ContractActionRunner>(async () => catalog());
    let allowed = 1;
    const b = bridge(run, { checkRateLimit: () => allowed-- > 0 });
    await runContractTool(b, call('scheduling_list_services'));
    const refused = JSON.parse(await runContractTool(b, call('scheduling_list_services')));
    expect(refused.error.code).toBe('RATE_LIMITED');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
