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
vi.mock('./callPersistence', () => ({ writeCallEvent: m.writeCallEvent, updateCallState: m.updateCallState }));
vi.mock('../../../platform/billing/usage/UsageRecorder', () => ({ recordToolExecution: m.recordToolExecution }));
vi.mock('../../../platform/core/observability', () => ({ logError: m.logError }));
vi.mock('../../../platform/billing/guardrails/TrialGuard', () => ({ checkTrialLimits: m.checkTrialLimits }));

import { compose } from '../../../platform/agent-runtime/composer';
import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import { actionFail, actionOk, type ActionResult } from '../../../platform/actions';
import { ToolStopGuard } from '../../../platform/tools/ToolStopGuard';
import { ContractToolBridge, type ContractActionRunner } from './contractToolBridge';
import { containsUuid } from './contractToolHandles';
import { runContractTool, type ToolRunCall } from './toolBookkeeping';

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
