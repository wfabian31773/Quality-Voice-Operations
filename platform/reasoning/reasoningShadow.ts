/**
 * ReasoningEngine call gate (VA-01 shadow mode).
 *
 * Wraps one call's ReasoningEngine. In `enforce` mode it returns what the
 * engine decided so the voice path applies it exactly as before. In `shadow`
 * mode the engine still processes every turn and tool request, but nothing
 * it decides reaches the model or the tool layer: each decision is logged as
 * one `reasoning_shadow` line instead. Only the deterministic agent tool
 * allowlist still blocks in shadow (it is not keyword- or intent-based).
 *
 * A shadow line carries ids, enums, counts and tool names only: never an
 * utterance, a name, a phone number or a slot value.
 */
import { createLogger } from '../core/logger';
import { checkAgentToolAllowlist } from '../tools/agentToolAllowlist';
import type { ReasoningEngine } from './ReasoningEngine';
import type { ReasoningMode } from './reasoningMode';
import type { ConfidenceLevel, DecisionResult, SafetyCheckResult, SafetyViolation } from './types';

const logger = createLogger('REASONING_SHADOW');

export const REASONING_SHADOW_EVENT = 'reasoning_shadow';

/** Ids of the guidance openaiSession injects in enforce mode. */
export type InjectTemplateId =
  | 'escalation_route'
  | 'message_fallback'
  | 'slot_clarification'
  | 'workflow_guidance'
  | 'partial_answer_recovery'
  | 'silence_recovery'
  | 'response_safety_override';

export type ShadowLineKind = 'turn' | 'tool' | 'silence' | 'response';

export interface ReasoningShadowLine {
  event: typeof REASONING_SHADOW_EVENT;
  mode: 'shadow';
  kind: ShadowLineKind;
  callId: string;
  /** Engine turn index (caller utterances processed so far). */
  turn: number;
  intent: string;
  intent_confidence: ConfidenceLevel | null;
  /** DecisionResult numeric confidence (0-1), rounded to 3 places. */
  confidence: number | null;
  decision: string | null;
  would_inject: boolean;
  /** Template id(s), joined with '+'. Never the injected text. */
  inject_template: string | null;
  would_block_tool: { tool: string; reason: string } | null;
  would_reset_state: boolean;
  would_escalate: boolean;
  escalation_trigger: string | null;
}

export interface TurnEffects {
  injectTemplates: InjectTemplateId[];
  wouldEscalate: boolean;
  escalationTrigger: string | null;
}

/**
 * What openaiSession does with a decision in enforce mode, as ids. Mirrors
 * the effect branches of its `history_added` handler.
 */
export function describeTurnEffects(result: DecisionResult, partialRecovery: boolean): TurnEffects {
  const injectTemplates: InjectTemplateId[] = [];
  if (result.action === 'escalate_to_human') injectTemplates.push('escalation_route');
  if (result.action === 'execute_tool' && result.fallbackStep === 'create_ticket' && result.escalation?.output === 'take_message') {
    injectTemplates.push('message_fallback');
  }
  if (result.action === 'ask_clarifying_question' && result.clarifyingQuestion) injectTemplates.push('slot_clarification');
  if (result.action === 'continue_workflow' && result.reasoning) injectTemplates.push('workflow_guidance');
  if (partialRecovery) injectTemplates.push('partial_answer_recovery');
  return {
    injectTemplates,
    wouldEscalate: result.action === 'escalate_to_human' || Boolean(result.escalation),
    escalationTrigger: result.escalation?.trigger ?? null,
  };
}

function violationReason(violation: SafetyViolation): string {
  const text = violation.description;
  if (text.includes('conflicts with the active reasoning decision')) return 'decision_conflict';
  if (text.startsWith('Cancel and reschedule must update')) return 'reschedule_requires_update';
  if (text.includes('supplied only in model tool arguments')) return 'caller_provenance';
  if (text.startsWith('Tenant policy')) return 'tenant_policy';
  if (violation.type === 'policy_violation') return 'session_binding';
  return violation.type;
}

/** Reason code for the first critical violation, or null when allowed. */
export function toolBlockReason(safety: SafetyCheckResult): string | null {
  if (safety.allowed) return null;
  const critical = safety.violations.find((v) => v.severity === 'critical') ?? safety.violations[0];
  return critical ? violationReason(critical) : 'blocked';
}

interface EngineState {
  manifestIntent: string | null;
  plan: unknown;
}

export interface ReasoningTurnOutcome {
  result: DecisionResult;
  effects: TurnEffects;
  /** Partial-answer recovery text, for the enforce path only. Never logged. */
  partialRecoveryPrompt?: string;
}

export interface ReasoningToolDecision extends SafetyCheckResult {
  /** The engine's own verdict, enforced only in enforce mode. */
  engine: SafetyCheckResult | null;
}

export interface ReasoningCallGateOptions {
  engine: ReasoningEngine;
  mode: ReasoningMode;
  callId: string;
  /** Agent tool allowlist (names the model was given). */
  toolsAvailable: string[];
  /** Tools that skip the allowlist (internal orchestration). */
  exemptTools?: string[];
  /** Log sink; defaults to the REASONING_SHADOW logger. */
  log?: (line: ReasoningShadowLine) => void;
}

export class ReasoningCallGate {
  readonly engine: ReasoningEngine;
  readonly mode: ReasoningMode;
  private readonly callId: string;
  private readonly toolsAvailable: string[];
  private readonly exemptTools: string[];
  private readonly log: (line: ReasoningShadowLine) => void;

  constructor(opts: ReasoningCallGateOptions) {
    this.engine = opts.engine;
    this.mode = opts.mode;
    this.callId = opts.callId;
    this.toolsAvailable = opts.toolsAvailable;
    this.exemptTools = opts.exemptTools ?? [];
    this.log = opts.log ?? ((line) => logger.info(REASONING_SHADOW_EVENT, { ...line }));
  }

  get enforcing(): boolean {
    return this.mode === 'enforce';
  }

  /** Classify (unless the caller already did) and process one caller turn. */
  processTurn(text: string, intent?: string, intentConfidence?: ConfidenceLevel): ReasoningTurnOutcome {
    const classified = intent && intentConfidence
      ? { intent, confidence: intentConfidence }
      : this.engine.classifyIntent(text);
    const before = this.enforcing ? null : this.state();
    const result = this.engine.processUtterance(text, classified.intent, classified.confidence);

    let partialRecoveryPrompt: string | undefined;
    if (classified.intent === 'unknown' && classified.confidence === 'low' && result.action !== 'escalate_to_human') {
      try {
        partialRecoveryPrompt = this.engine.handlePartialAnswer(text).recoveryPrompt ?? undefined;
      } catch (err) {
        logger.warn('Partial answer recovery failed', { callId: this.callId, error: String(err) });
      }
    }
    const effects = describeTurnEffects(result, Boolean(partialRecoveryPrompt));

    if (before) {
      const after = this.state();
      this.emit('turn', {
        intent: result.traceEntry.selectedIntent,
        intent_confidence: classified.confidence,
        confidence: result.confidence.numericScore,
        decision: result.action,
        templates: effects.injectTemplates,
        block: null,
        would_reset_state: before.manifestIntent !== after.manifestIntent || (before.plan !== null && before.plan !== after.plan),
        would_escalate: effects.wouldEscalate,
        escalation_trigger: effects.escalationTrigger,
      });
    }
    return { result, effects, partialRecoveryPrompt };
  }

  /**
   * Authorize a tool request. Records string args as tool-arg slots first,
   * like the voice path always has. Enforce: the engine's verdict (which
   * already includes the allowlist). Shadow: only the allowlist blocks; the
   * engine's verdict is logged, and an engine error never blocks.
   */
  authorizeTool(
    toolName: string,
    args: Record<string, unknown>,
    /** The current agent's tool names (they change on a role handoff). */
    toolsAvailable: string[] = this.toolsAvailable,
  ): ReasoningToolDecision {
    try {
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && value.length > 0) this.engine.fillSlot(key, value, 'tool_args');
      }
    } catch (err) {
      logger.warn('Failed to fill slots from tool args (pre-safety)', { callId: this.callId, tool: toolName, error: String(err) });
    }
    if (this.enforcing) {
      const engine = this.engine.authorizeToolRequest(toolName, args);
      return { ...engine, engine };
    }

    let engine: SafetyCheckResult | null = null;
    let engineReason: string | null;
    try {
      engine = this.engine.authorizeToolRequest(toolName, args);
      engineReason = toolBlockReason(engine);
    } catch {
      engineReason = 'engine_error';
    }
    const allowlist = checkAgentToolAllowlist(toolName, toolsAvailable, this.exemptTools);
    const latest = this.engine.getLatestDecision();
    this.emit('tool', {
      intent: latest?.traceEntry.selectedIntent ?? 'unknown',
      intent_confidence: null,
      confidence: latest?.confidence.numericScore ?? null,
      decision: latest?.action ?? null,
      templates: [],
      block: engineReason ? { tool: toolName, reason: engineReason } : null,
      would_reset_state: false,
      would_escalate: false,
      escalation_trigger: null,
    });
    if (allowlist.allowed) return { allowed: true, violations: [], engine };
    return {
      allowed: false,
      engine,
      violations: [{
        type: 'unauthorized_tool',
        description: `Tool "${toolName}" is not available for this agent configuration`,
        blockedAction: toolName,
        severity: 'critical',
      }],
    };
  }

  /** Silence recovery prompt to inject, or null (always null in shadow). */
  handleSilence(): string | null {
    const prompt = this.engine.handleSilence().recoveryPrompt ?? null;
    if (this.enforcing) return prompt;
    if (prompt) this.emitSimple('silence', 'silence_recovery');
    return null;
  }

  /** Whether to cancel and correct an assistant response (never in shadow). */
  checkResponse(text: string): SafetyCheckResult {
    const safety = this.engine.checkResponseSafety(text);
    if (this.enforcing) return safety;
    if (!safety.allowed) this.emitSimple('response', 'response_safety_override');
    return { allowed: true, violations: [] };
  }

  private emitSimple(kind: ShadowLineKind, template: InjectTemplateId): void {
    const latest = this.engine.getLatestDecision();
    this.emit(kind, {
      intent: latest?.traceEntry.selectedIntent ?? 'unknown',
      intent_confidence: null,
      confidence: latest?.confidence.numericScore ?? null,
      decision: latest?.action ?? null,
      templates: [template],
      block: null,
      would_reset_state: false,
      would_escalate: false,
      escalation_trigger: null,
    });
  }

  private emit(
    kind: ShadowLineKind,
    fields: {
      intent: string;
      intent_confidence: ConfidenceLevel | null;
      confidence: number | null;
      decision: string | null;
      templates: InjectTemplateId[];
      block: { tool: string; reason: string } | null;
      would_reset_state: boolean;
      would_escalate: boolean;
      escalation_trigger: string | null;
    },
  ): void {
    const line: ReasoningShadowLine = {
      event: REASONING_SHADOW_EVENT,
      mode: 'shadow',
      kind,
      callId: this.callId,
      turn: this.engine.getTranscript().length,
      intent: fields.intent,
      intent_confidence: fields.intent_confidence,
      confidence: typeof fields.confidence === 'number' ? Math.round(fields.confidence * 1000) / 1000 : null,
      decision: fields.decision,
      would_inject: fields.templates.length > 0,
      inject_template: fields.templates.length > 0 ? fields.templates.join('+') : null,
      would_block_tool: fields.block,
      would_reset_state: fields.would_reset_state,
      would_escalate: fields.would_escalate,
      escalation_trigger: fields.escalation_trigger,
    };
    try {
      this.log(line);
    } catch {
      // Logging must never affect the call.
    }
  }

  private state(): EngineState {
    const slots = this.engine.getCallSummary().slots as { intent?: string } | undefined;
    return { manifestIntent: slots?.intent ?? null, plan: this.engine.getWorkflowPlan() };
  }
}
