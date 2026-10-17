/**
 * Live-call plumbing for the text simulation: the ReasoningEngine gate
 * (enforce / shadow, resolved like openaiSession), the repeated-tool stop
 * from platform/tools, and scripted tool faults.
 *
 * Every tool call goes through executeWithRetry with a per-scenario
 * ToolStopGuard, so a tool that fails 3 times in a call answers TOOL_STOPPED
 * without running, as on the voice path. Each sim call is one attempt
 * (maxRetries 0): the script, not the orchestrator, decides when to retry.
 */
import { ReasoningEngine } from '../../platform/reasoning/ReasoningEngine';
import { isSalonVerticalAgent, resolveReasoningMode } from '../../platform/reasoning/reasoningMode';
import { ReasoningCallGate, toolBlockReason } from '../../platform/reasoning/reasoningShadow';
import { executeWithRetry } from '../../platform/tools/RetryOrchestrator';
import { ToolStopGuard, TOOL_STOPPED_CODE } from '../../platform/tools/ToolStopGuard';
import type {
  AgentToolSchema,
  ReasoningObservation,
  ReasoningSetup,
  ToolCallContext,
  ToolFault,
  ToolProvider,
  ToolResult,
} from './types';

export type ScenarioReasoning = {
  gate?: ReasoningCallGate;
  observation: ReasoningObservation;
};

export function createScenarioReasoning(
  setup: ReasoningSetup,
  opts: { callId: string; tenantId: string; callerNumber: string | null | undefined; toolNames: string[]; modeOverride?: ReasoningObservation['mode'] },
): ScenarioReasoning {
  const mode = opts.modeOverride ?? resolveReasoningMode(setup).mode;
  const observation: ReasoningObservation = { mode, shadowLines: [], injections: [], blocked: [] };
  if (mode === 'off') return { observation };
  // openaiSession passes the template key as the vertical: salon / barbershop → salon.
  const vertical = isSalonVerticalAgent(setup) ? 'salon' : setup.agentType;
  const engine = new ReasoningEngine({
    tenantId: opts.tenantId,
    callSessionId: opts.callId,
    callSid: `sim-${opts.callId}`,
    agentSlug: 'quality-sim',
    vertical,
    callerNumber: opts.callerNumber ?? '',
    toolsAvailable: opts.toolNames,
    memoryStorage: null,
    humanTransferAvailable: false,
  });
  const gate = new ReasoningCallGate({
    engine,
    mode,
    callId: opts.callId,
    toolsAvailable: opts.toolNames,
    log: (line) => observation.shadowLines.push({ ...line }),
  });
  return { gate, observation };
}

/** One caller turn through the gate; enforce-mode guidance is recorded as injected. */
export function observeCallerTurn(reasoning: ScenarioReasoning, turn: { text?: string; silence?: boolean | number }): void {
  const { gate, observation } = reasoning;
  if (!gate) return;
  if (turn.text) {
    const { effects } = gate.processTurn(turn.text);
    if (gate.enforcing) observation.injections.push(...effects.injectTemplates);
  } else if (turn.silence) {
    if (gate.handleSilence()) observation.injections.push('silence_recovery');
  }
}

function failure(code: string, message: string, callerSafeMessage: string, retryable: boolean): ToolResult {
  return { ok: false, error: { code, message, callerSafeMessage, retryable } };
}

export class GuardedToolProvider implements ToolProvider {
  /** Executed attempts per tool (a blocked or stopped call is not one). */
  readonly attempts: Record<string, number> = {};
  readonly stopGuard: ToolStopGuard;
  private readonly faultsLeft: Record<string, number> = {};

  constructor(
    private readonly inner: ToolProvider,
    private readonly opts: {
      reasoning?: ScenarioReasoning;
      faults?: Record<string, ToolFault>;
      stopGuard?: ToolStopGuard;
    } = {},
  ) {
    this.stopGuard = opts.stopGuard ?? new ToolStopGuard();
    for (const [name, fault] of Object.entries(opts.faults ?? {})) this.faultsLeft[name] = fault.failTimes;
  }

  listTools(): AgentToolSchema[] {
    return this.inner.listTools();
  }

  async invoke(name: string, input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const gate = this.opts.reasoning?.gate;
    if (gate) {
      const decision = gate.authorizeTool(name, input);
      if (!decision.allowed) {
        const reason = toolBlockReason(decision) ?? 'blocked';
        this.opts.reasoning?.observation.blocked.push({ tool: name, reason });
        return failure('SAFETY_BLOCKED', `This action was blocked by policy (${reason})`, "I can't do that right now.", false);
      }
    }

    let lastFailure: ToolResult | undefined;
    const run = await executeWithRetry<ToolResult>(
      async () => {
        this.attempts[name] = (this.attempts[name] ?? 0) + 1;
        const left = this.faultsLeft[name] ?? 0;
        let result: ToolResult;
        if (left > 0) {
          this.faultsLeft[name] = left - 1;
          const fault = this.opts.faults?.[name];
          result = failure(fault?.code ?? 'INTERNAL', `injected fault for ${name}`, 'Something went wrong on our side.', fault?.retryable ?? true);
        } else {
          result = await this.inner.invoke(name, input, ctx);
        }
        if (result.ok) return result;
        lastFailure = result;
        throw Object.assign(new Error(`ToolExecutionFailed: ${result.error.code}`), { retryable: result.error.retryable });
      },
      {
        tenantId: ctx.tenantId,
        toolName: name,
        callSessionId: ctx.callId,
        retryConfig: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 10_000 },
        stopGuard: this.stopGuard,
      },
    );
    if (run.success && run.result) return run.result;
    if (run.stopped) {
      const stop = this.stopGuard.result(ctx.callId, name);
      return failure(TOOL_STOPPED_CODE, stop.message, stop.message_for_caller_hint, false);
    }
    return lastFailure ?? failure('INTERNAL', run.error ?? 'tool failed', 'Something went wrong on our side.', true);
  }
}
