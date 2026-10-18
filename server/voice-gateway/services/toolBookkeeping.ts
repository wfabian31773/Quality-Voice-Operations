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
 * runContractTool wraps a ContractToolBridge call in both. A call the rate
 * limit refused gets what the legacy path gives it: one failed row, no call
 * events and no metering.
 */
import { createLogger } from '../../../platform/core/logger';
import type { TenantId } from '../../../platform/core/types';
import { completeToolExecution, createToolExecution } from '../../../platform/tools/ToolExecutionService';
import { unifiedToolRegistry } from '../../../platform/tools/ToolRegistry';
import { updateCallState, writeCallEvent } from './callPersistence';
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

export interface ToolRunEnd {
  executionId: string;
  startTime: number;
  result: unknown;
  status: 'success' | 'failed' | 'timeout';
  errorMessage?: string;
  recoveryAction?: string;
}

/** Opens the run: tool_invocations row, TOOL_EXECUTION state, tool_start. Returns the execution id. */
export async function beginToolRun(call: ToolRunCall): Promise<string> {
  const { tenantId, callSessionId, agentId, toolName, args } = call;
  const executionId = await createToolExecution({ tenantId, callSessionId, agentId, agentSlug: agentId, toolName, parameters: args });

  if (call.workflow) {
    await updateCallState(tenantId, callSessionId, 'WORKFLOW_EXECUTION');
    await writeCallEvent(tenantId, callSessionId, 'workflow_execution_start', 'ACTIVE_CONVERSATION', 'WORKFLOW_EXECUTION', {
      tool: toolName,
    });
  }

  await updateCallState(tenantId, callSessionId, 'TOOL_EXECUTION');
  await writeCallEvent(tenantId, callSessionId, 'tool_start', 'WORKFLOW_EXECUTION', 'TOOL_EXECUTION', {
    tool: toolName,
    executionId,
  });
  return executionId;
}

/** Closes the run: completes the row, logs a failure, tool_end, one meter increment, the trial check. */
export async function finishToolRun(call: ToolRunCall, end: ToolRunEnd): Promise<void> {
  const { tenantId, callSessionId, toolName } = call;
  const { executionId, status, errorMessage } = end;
  const durationMs = Date.now() - end.startTime;

  await completeToolExecution({
    tenantId,
    executionId,
    callSessionId,
    result: end.result,
    status,
    errorMessage,
    recoveryAction: end.recoveryAction,
    durationMs,
  });

  if (status !== 'success') {
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
  }

  await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
  await writeCallEvent(tenantId, callSessionId, 'tool_end', 'TOOL_EXECUTION', 'ACTIVE_CONVERSATION', {
    tool: toolName,
    executionId,
    durationMs,
    status,
  });

  try {
    const { recordToolExecution } = await import('../../../platform/billing/usage/UsageRecorder');
    await recordToolExecution(tenantId, 1);
  } catch (meterErr) {
    logger.error('Failed to record tool execution', { tenantId, callId: callSessionId, error: String(meterErr) });
  }

  if (call.isTrial) {
    try {
      const { checkTrialLimits } = await import('../../../platform/billing/guardrails/TrialGuard');
      const trialCheck = await checkTrialLimits(tenantId);
      if (trialCheck.isTrial && !trialCheck.allowed && trialCheck.usage.toolExecutions >= trialCheck.usage.maxToolExecutions) {
        logger.warn('Trial tool execution limit reached mid-session', { tenantId, callId: callSessionId, toolExecutions: trialCheck.usage.toolExecutions });
      }
    } catch (trialErr) {
      logger.error('Failed to check trial tool limits', { tenantId, error: String(trialErr) });
    }
  }
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
 * notifications), before the bookkeeping writes.
 */
export async function runContractTool(
  bridge: Pick<ContractToolBridge, 'execute'>,
  call: ToolRunCall,
  onRun?: (run: ContractToolRun) => void,
): Promise<string> {
  const startTime = Date.now();
  let executionId: string | undefined;
  const run = await bridge.execute(call.toolName, call.args, {
    beforeRun: async () => {
      executionId = await beginToolRun(call);
    },
  });
  onRun?.(run);

  if (run.rateLimited) {
    logger.warn('Tool rate limit exceeded', { tenantId: call.tenantId, callId: call.callSessionId, tool: call.toolName });
    const rlId = await createToolExecution({
      tenantId: call.tenantId, callSessionId: call.callSessionId, agentId: call.agentId, agentSlug: call.agentId, toolName: call.toolName, parameters: call.args,
    });
    await completeToolExecution({
      tenantId: call.tenantId,
      executionId: rlId,
      callSessionId: call.callSessionId,
      result: { success: false, reason: 'rate_limited' },
      status: 'failed',
      errorMessage: 'Rate limit exceeded',
      durationMs: Date.now() - startTime,
    });
    return run.output;
  }

  executionId ??= await beginToolRun(call);
  await finishToolRun(call, {
    executionId,
    startTime,
    result: parseResult(run.output),
    status: run.status,
    errorMessage: run.errorMessage,
    recoveryAction: run.status === 'failed' ? unifiedToolRegistry.getRecoveryInstructions(call.toolName) : undefined,
  });
  return run.output;
}
