/**
 * The bookkeeping every voice tool call gets (RT-14 prereq), shared by
 * openaiSession's legacy tool path and the RT-09 contract tool path so call
 * debug, the RT-13 metric and billing see both the same way:
 *
 * - beginToolRun: the tool_invocations row (running), the workflow event when
 *   a workflow engine runs, TOOL_EXECUTION state and the tool_start event;
 * - finishToolRun: the row's completion (status, duration, result), the
 *   observability error for a failure, ACTIVE_CONVERSATION state, the
 *   tool_end event, one tool-execution meter increment and the trial check.
 *
 * RT-HOLD-LINE part 2: none of it is awaited before the tool output goes
 * back to the model. Every write goes through the call's BookkeepingQueue
 * (one write at a time, in enqueue order), so the rows, their values and
 * their order are what the inline path wrote (toolBookkeeping.golden.test.ts).
 * Values are taken when the write is enqueued (durations included); the row
 * id createToolExecution returns is resolved inside the queue, by the writes
 * behind it. Each state + event pair is one transaction
 * (updateCallStateWithEvent). Nothing the queue writes gates a tool: the rate
 * limit, the stop guard and RUN are in memory and decided before the action.
 *
 * runContractTool wraps a ContractToolBridge call in both. A call the rate
 * limit refused gets what the legacy path gives it: one failed row, no call
 * events and no metering.
 */
import { createLogger } from '../../../platform/core/logger';
import type { TenantId } from '../../../platform/core/types';
import { completeToolExecution, createToolExecution } from '../../../platform/tools/ToolExecutionService';
import { unifiedToolRegistry } from '../../../platform/tools/ToolRegistry';
import type { BookkeepingQueue } from './bookkeepingQueue';
import { updateCallStateWithEvent } from './callPersistence';
import type { ContractToolBridge, ContractToolRun } from './contractToolBridge';

const logger = createLogger('OPENAI_SESSION');

export interface ToolRunCall {
  tenantId: TenantId;
  callSessionId: string;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** A workflow engine runs on the call (legacy writes workflow_execution_start first). */
  workflow?: boolean;
  isTrial?: boolean;
}

/** A run whose opening writes are queued. */
export interface OpenedToolRun {
  /** The tool_invocations id, once its insert has run (resolved inside the queue). */
  executionId: Promise<string>;
  /** When its first write was enqueued, and how many writes were ahead of it. */
  enqueuedAt: number;
  depthAtEnqueue: number;
}

export interface ToolRunEnd {
  run: OpenedToolRun;
  startTime: number;
  result: unknown;
  status: 'success' | 'failed' | 'timeout';
  errorMessage?: string;
  recoveryAction?: string;
}

/** A tool call refused before anything ran: one failed tool_invocations row, nothing else. */
export interface ToolRunRefusal {
  result: unknown;
  errorMessage: string;
  durationMs: number;
}

/**
 * Queues the tool_invocations insert; its id is resolved for the writes
 * behind it. If the insert throws, the writes that need the id fail at once
 * (logged by the queue) instead of waiting out their bound.
 */
function queueInvocationRow(call: ToolRunCall, queue: BookkeepingQueue): Promise<string> {
  const { tenantId, callSessionId, agentId, toolName, args } = call;
  let resolveId: (id: string) => void = () => {};
  let rejectId: (err: unknown) => void = () => {};
  const executionId = new Promise<string>((resolve, reject) => { resolveId = resolve; rejectId = reject; });
  // Settled for the writes that await it; never an unhandled rejection.
  executionId.catch(() => {});
  void queue.enqueue('tool_invocations.create', async () => {
    try {
      resolveId(await createToolExecution({ tenantId, callSessionId, agentId, agentSlug: agentId, toolName, parameters: args }));
    } catch (err) {
      rejectId(err);
      throw err;
    }
  });
  return executionId;
}

/** One line per tool run once all of its writes have run (no caller data). */
function logDrained(call: ToolRunCall, run: Pick<OpenedToolRun, 'enqueuedAt' | 'depthAtEnqueue'>, written: Promise<void>, writes: number): void {
  void written.then(() => {
    logger.info('bookkeeping_timing', {
      tenantId: call.tenantId,
      callId: call.callSessionId,
      tool: call.toolName,
      bookkeeping_queue_ms: Date.now() - run.enqueuedAt,
      queue_depth_at_enqueue: run.depthAtEnqueue,
      writes,
    });
  });
}

/** Opens the run: tool_invocations row, TOOL_EXECUTION state + tool_start, all queued. */
export function beginToolRun(call: ToolRunCall, queue: BookkeepingQueue): OpenedToolRun {
  const { tenantId, callSessionId, toolName } = call;
  const opened = { enqueuedAt: Date.now(), depthAtEnqueue: queue.depth };
  const executionId = queueInvocationRow(call, queue);

  if (call.workflow) {
    void queue.enqueue('call_state.workflow_execution_start', () => updateCallStateWithEvent(tenantId, callSessionId, 'WORKFLOW_EXECUTION', {
      type: 'workflow_execution_start', from: 'ACTIVE_CONVERSATION', to: 'WORKFLOW_EXECUTION', payload: { tool: toolName },
    }));
  }

  void queue.enqueue('call_state.tool_start', async () => updateCallStateWithEvent(tenantId, callSessionId, 'TOOL_EXECUTION', {
    type: 'tool_start', from: 'WORKFLOW_EXECUTION', to: 'TOOL_EXECUTION', payload: { tool: toolName, executionId: await executionId },
  }));
  return { ...opened, executionId };
}

/**
 * Closes the run: completes the row, logs a failure, tool_end, one meter
 * increment, the trial check, all queued. Resolves once they are written;
 * the tool call does not wait for that.
 */
export function finishToolRun(call: ToolRunCall, end: ToolRunEnd, queue: BookkeepingQueue): Promise<void> {
  const { tenantId, callSessionId, toolName } = call;
  const { run, status, errorMessage } = end;
  const durationMs = Date.now() - end.startTime;

  void queue.enqueue('tool_invocations.complete', async () => completeToolExecution({
    tenantId,
    executionId: await run.executionId,
    callSessionId,
    result: end.result,
    status,
    errorMessage,
    recoveryAction: end.recoveryAction,
    durationMs,
  }));

  if (status !== 'success') {
    void queue.enqueue('observability.tool_error', async () => {
      try {
        const { logError } = await import('../../../platform/core/observability');
        logError(tenantId, 'error', `Tool "${toolName}" failed: ${errorMessage ?? 'unknown error'}`, {
          service: 'tool_execution',
          errorCode: 'TOOL_EXEC_FAILURE',
          callSessionId: callSessionId,
        });
      } catch (obsErr) {
        logger.warn('Failed to log tool error to observability', { error: String(obsErr) });
      }
    });
  }

  void queue.enqueue('call_state.tool_end', async () => updateCallStateWithEvent(tenantId, callSessionId, 'ACTIVE_CONVERSATION', {
    type: 'tool_end', from: 'TOOL_EXECUTION', to: 'ACTIVE_CONVERSATION', payload: { tool: toolName, executionId: await run.executionId, durationMs, status },
  }));

  let written = queue.enqueue('meter.tool_execution', async () => {
    try {
      const { recordToolExecution } = await import('../../../platform/billing/usage/UsageRecorder');
      await recordToolExecution(tenantId, 1);
    } catch (meterErr) {
      logger.error('Failed to record tool execution', { tenantId, callId: callSessionId, error: String(meterErr) });
    }
  });

  if (call.isTrial) {
    written = queue.enqueue('trial.tool_limit_check', async () => {
      try {
        const { checkTrialLimits } = await import('../../../platform/billing/guardrails/TrialGuard');
        const trialCheck = await checkTrialLimits(tenantId);
        if (trialCheck.isTrial && !trialCheck.allowed && trialCheck.usage.toolExecutions >= trialCheck.usage.maxToolExecutions) {
          logger.warn('Trial tool execution limit reached mid-session', { tenantId, callId: callSessionId, toolExecutions: trialCheck.usage.toolExecutions });
        }
      } catch (trialErr) {
        logger.error('Failed to check trial tool limits', { tenantId, error: String(trialErr) });
      }
    });
  }

  const writes = 3 + (status !== 'success' ? 1 : 0) + (call.isTrial ? 1 : 0) + (call.workflow ? 3 : 2);
  logDrained(call, run, written, writes);
  return written;
}

/**
 * A call refused before anything ran (denied, not allowed, invalid, rate
 * limited, a session-binding or safety-gate refusal): one failed
 * tool_invocations row, queued like every other write.
 */
export function recordRefusedToolRun(call: ToolRunCall, refusal: ToolRunRefusal, queue: BookkeepingQueue): Promise<void> {
  const opened = { enqueuedAt: Date.now(), depthAtEnqueue: queue.depth };
  const executionId = queueInvocationRow(call, queue);
  const written = queue.enqueue('tool_invocations.complete', async () => completeToolExecution({
    tenantId: call.tenantId,
    executionId: await executionId,
    callSessionId: call.callSessionId,
    result: refusal.result,
    status: 'failed',
    errorMessage: refusal.errorMessage,
    durationMs: refusal.durationMs,
  }));
  logDrained(call, opened, written, 2);
  return written;
}

function parseResult(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return { raw: output };
  }
}

/**
 * A contract tool call with the same bookkeeping as every other tool. The row
 * stores what the model got (internal ids already swapped for handles).
 * `onRun` sees how the run ended (openaiSession's reasoning-engine
 * notifications, the cache-hit timing mark), before the bookkeeping writes.
 * A cache hit (a call-stable read served from the call's cache) gets the same
 * success row, events and meter as the read it repeats.
 */
export async function runContractTool(
  bridge: Pick<ContractToolBridge, 'execute'>,
  call: ToolRunCall,
  onRun: ((run: ContractToolRun) => void) | undefined,
  queue: BookkeepingQueue,
): Promise<string> {
  const startTime = Date.now();
  let opened: OpenedToolRun | undefined;
  const run = await bridge.execute(call.toolName, call.args, {
    beforeRun: async () => {
      opened = beginToolRun(call, queue);
      await queue.onCriticalPath();
    },
  });
  onRun?.(run);

  if (run.rateLimited) {
    logger.warn('Tool rate limit exceeded', { tenantId: call.tenantId, callId: call.callSessionId, tool: call.toolName });
    recordRefusedToolRun(call, {
      result: { success: false, reason: 'rate_limited' },
      errorMessage: 'Rate limit exceeded',
      durationMs: Date.now() - startTime,
    }, queue);
    await queue.onCriticalPath();
    return run.output;
  }

  opened ??= beginToolRun(call, queue);
  finishToolRun(call, {
    run: opened,
    startTime,
    result: parseResult(run.output),
    status: run.status,
    errorMessage: run.errorMessage,
    recoveryAction: run.status === 'failed' ? unifiedToolRegistry.getRecoveryInstructions(call.toolName) : undefined,
  }, queue);
  await queue.onCriticalPath();
  return run.output;
}
