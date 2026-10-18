/**
 * RT-HOLD-LINE part 2: the golden record of what a tool call's bookkeeping
 * writes, statement by statement (SQL + params), plus the meter, the trial
 * check and the observability error. The snapshot was recorded on 31996d53
 * (bookkeeping awaited inline, before the per-call queue; the same cases run
 * through the old API) and is the reference the queued path must reproduce:
 * same rows, same values, same order. Only the transaction framing (BEGIN /
 * set_config / COMMIT) differs, so the data statements are compared on their
 * own and the framing is counted separately.
 *
 * Real ToolExecutionService and callPersistence over a recording pool. Ids
 * are normalized in order of appearance (so "the tool_start event names the
 * row's id" is still checked) and durations to 0.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const g = vi.hoisted(() => ({
  log: [] as Array<{ sql: string; params: unknown[] } | { effect: string; args: unknown[] }>,
}));

vi.mock('../../../platform/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/db')>();
  const query = async (sql: string, params: unknown[] = []) => {
    g.log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
  return {
    ...actual,
    getPlatformPool: () => ({ query, connect: async () => ({ query, release: () => {} }) }),
  };
});
vi.mock('../../../platform/core/observability/traceLogger', () => ({ recordTrace: async () => {} }));
vi.mock('../../../platform/activation/ActivationService', () => ({ recordActivationEvent: async () => {} }));
vi.mock('../../../platform/billing/usage/UsageRecorder', () => ({
  recordToolExecution: async (...args: unknown[]) => { g.log.push({ effect: 'meter', args }); },
}));
vi.mock('../../../platform/billing/guardrails/TrialGuard', () => ({
  checkTrialLimits: async (...args: unknown[]) => {
    g.log.push({ effect: 'trial_check', args });
    return { isTrial: true, allowed: true, usage: { toolExecutions: 1, maxToolExecutions: 100 } };
  },
}));
vi.mock('../../../platform/core/observability', () => ({
  logError: (...args: unknown[]) => { g.log.push({ effect: 'observability_error', args: [args[0], args[1], args[2]] }); },
}));

import { compose } from '../../../platform/agent-runtime/composer';
import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import { actionFail, actionOk, type ActionResult } from '../../../platform/actions';
import { ToolStopGuard } from '../../../platform/tools/ToolStopGuard';
import { BookkeepingQueue } from './bookkeepingQueue';
import { ContractToolBridge, type ContractActionRunner } from './contractToolBridge';
import { beginToolRun, finishToolRun, runContractTool, type ToolRunCall } from './toolBookkeeping';

const BINDING = compose(BARBERSHOP_TEMPLATE_V1, undefined, { businessName: 'Sharp Line Barbers' }, { language: 'en' }).contractTools;
const FRAMING = /^(BEGIN|COMMIT|ROLLBACK)$|set_config\('app\.tenant_id'/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function bridge(runner: ContractActionRunner, over: Partial<ConstructorParameters<typeof ContractToolBridge>[0]> = {}) {
  return new ContractToolBridge({
    tenantId: 't-shop',
    callId: 'cs-golden',
    agentId: 'ag-shop',
    binding: BINDING,
    timeZone: 'America/New_York',
    language: 'en',
    runAction: runner,
    smsEnabled: () => false,
    checkRateLimit: () => true,
    stopGuard: new ToolStopGuard(),
    timeoutMs: 5,
    newIdempotencyKey: () => 'idem-1',
    ...over,
  });
}

function call(toolName: string, over: Partial<ToolRunCall> = {}): ToolRunCall {
  return { tenantId: 't-shop' as never, callSessionId: 'cs-golden', agentId: 'ag-shop', toolName, args: { query: 'fade' }, ...over };
}

function normalized() {
  const ids = new Map<string, string>();
  const label = (text: string) => text.replace(UUID, (id) => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
    return ids.get(id) as string;
  }).replace(/(durationMs\\*":)\d+/g, (_match, key: string) => `${key}0`);
  const data: unknown[] = [];
  let framing = 0;
  for (const entry of g.log) {
    if ('effect' in entry) {
      data.push({ effect: entry.effect, args: JSON.parse(label(JSON.stringify(entry.args))) });
      continue;
    }
    if (FRAMING.test(entry.sql)) {
      framing += 1;
      continue;
    }
    const params = entry.params.map((p, i) =>
      entry.sql.startsWith('UPDATE tool_invocations') && i === 6 && typeof p === 'number' ? '<ms>' : p);
    data.push({ sql: entry.sql, params: JSON.parse(label(JSON.stringify(params))) });
  }
  return { data, framing };
}

let queue: BookkeepingQueue;

/** Runs a call's bookkeeping and waits until the queue has written all of it. */
async function record(work: () => Promise<unknown>) {
  await work();
  expect(await queue.flush()).toBe('drained');
  return normalized();
}

beforeEach(() => {
  g.log.length = 0;
  queue = new BookkeepingQueue();
});

describe('bookkeeping golden (statements recorded on 31996d53, inline writes)', () => {
  it('contract tool, success: invocation row, TOOL_EXECUTION + tool_start, completion, ACTIVE_CONVERSATION + tool_end, one meter', async () => {
    const { data, framing } = await record(() => runContractTool(bridge(async () => actionOk([])), call('scheduling_list_services'), undefined, queue));
    expect(data).toMatchSnapshot();
    // 31996d53: 6 transactions (insert, state, event, complete, state, event) × 3 framing statements = 18.
    // Now each state + event pair is one transaction: insert, state+event, complete, state+event.
    expect(framing).toBe(4 * 3);
  });

  it('contract tool, failed: a failed completion, has_tool_failure, one observability error', async () => {
    const { data } = await record(() => runContractTool(bridge(async () => actionFail('CONFLICT', 'slot taken')), call('scheduling_book_prepare'), undefined, queue));
    expect(data).toMatchSnapshot();
  });

  it('contract tool, timeout: a timeout completion, has_tool_failure, one observability error', async () => {
    const { data } = await record(() => runContractTool(bridge(() => new Promise<ActionResult>(() => {})), call('scheduling_book_commit'), undefined, queue));
    expect(data).toMatchSnapshot();
  });

  it('contract tool, rate-limited: the single failed row, no call events, no meter', async () => {
    const { data } = await record(() =>
      runContractTool(bridge(async () => actionOk([]), { checkRateLimit: () => false }), call('scheduling_list_services'), undefined, queue));
    expect(data).toMatchSnapshot();
  });

  it('contract tool on a workflow trial call: workflow_execution_start first, the trial check after the meter', async () => {
    const { data } = await record(() =>
      runContractTool(bridge(async () => actionOk([])), call('scheduling_list_staff', { workflow: true, isTrial: true }), undefined, queue));
    expect(data).toMatchSnapshot();
  });

  it('legacy tool path (beginToolRun → finishToolRun), success then failed, in that order', async () => {
    const { data } = await record(async () => {
      const ok = call('get_current_tenant_time', { args: {} });
      const okRun = beginToolRun(ok, queue);
      finishToolRun(ok, { run: okRun, startTime: Date.now(), result: { success: true }, status: 'success' }, queue);
      const bad = call('lookup_customer', { args: { phone: 'x' } });
      const badRun = beginToolRun(bad, queue);
      finishToolRun(bad, { run: badRun, startTime: Date.now(), result: { success: false }, status: 'failed', errorMessage: 'not found', recoveryAction: 'ask again' }, queue);
    });
    expect(data).toMatchSnapshot();
  });
});
