import { createLogger } from '../core/logger';
import type {
  ReasoningTraceEntry,
  ConfidenceScore,
  DecisionAction,
  SafetyViolation,
  EscalationTrigger,
  ReasoningContext,
} from './types';

const logger = createLogger('REASONING_TRACE');

export interface TraceEmitOptions {
  context: ReasoningContext;
  confidence: ConfidenceScore;
  decision: DecisionAction;
  chosenTool?: string;
  fallbackReason?: string;
  escalationTrigger?: EscalationTrigger;
  industryRuleTriggered?: string;
  safetyViolations?: SafetyViolation[];
  metadata?: Record<string, unknown>;
}

export class ReasoningTrace {
  private readonly callSessionId: string;
  private readonly entries: ReasoningTraceEntry[] = [];

  constructor(callSessionId: string) {
    this.callSessionId = callSessionId;
  }

  emit(options: TraceEmitOptions): ReasoningTraceEntry {
    const { context, confidence, decision } = options;

    const missingSlots: string[] = [];
    for (const [name, slot] of context.slotTracker.slots) {
      if (slot.required && slot.value === null) {
        missingSlots.push(name);
      }
    }

    const entry: ReasoningTraceEntry = {
      timestamp: new Date(),
      turn: context.turnCount,
      selectedIntent: context.currentIntent,
      confidence,
      activeWorkflowStep: context.workflowPlan
        ? context.workflowPlan.steps[context.workflowPlan.currentStepIndex]?.name
        : undefined,
      missingSlots,
      chosenTool: options.chosenTool,
      decision,
      fallbackReason: options.fallbackReason,
      escalationTrigger: options.escalationTrigger,
      industryRuleTriggered: options.industryRuleTriggered,
      safetyViolations: options.safetyViolations ?? [],
      callerContext: context.callerContext
        ? {
            isReturning: context.callerContext.isReturningCaller,
            openTickets: context.callerContext.openTicketIds.length,
          }
        : undefined,
      metadata: options.metadata ?? {},
    };

    this.entries.push(entry);

    logger.info('Reasoning trace entry', {
      callId: this.callSessionId,
      turn: entry.turn,
      intent: entry.selectedIntent,
      confidence: confidence.overall,
      confidenceScore: confidence.numericScore.toFixed(3),
      decision,
      tool: options.chosenTool ?? 'none',
      missingSlots: missingSlots.length,
      escalation: options.escalationTrigger ?? 'none',
    });

    return entry;
  }

  getEntries(): ReasoningTraceEntry[] {
    return [...this.entries];
  }

  getLatestEntry(): ReasoningTraceEntry | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
  }

  getCallSummary(): Record<string, unknown> {
    const latestEntry = this.getLatestEntry();
    const escalations = this.entries.filter((e) => e.escalationTrigger);
    const safetyIssues = this.entries.filter((e) => e.safetyViolations.length > 0);
    const toolCalls = this.entries.filter((e) => e.chosenTool);

    return {
      callSessionId: this.callSessionId,
      totalTurns: this.entries.length,
      currentIntent: latestEntry?.selectedIntent ?? 'unknown',
      currentConfidence: latestEntry?.confidence.overall ?? 'unknown',
      escalationCount: escalations.length,
      safetyIssueCount: safetyIssues.length,
      toolCallCount: toolCalls.length,
      decisions: this.entries.map((e) => ({
        turn: e.turn,
        intent: e.selectedIntent,
        confidence: e.confidence.overall,
        decision: e.decision,
        tool: e.chosenTool,
        escalation: e.escalationTrigger,
      })),
    };
  }

  toSerializable(): Record<string, unknown>[] {
    return this.entries.map((e) => ({
      timestamp: e.timestamp.toISOString(),
      turn: e.turn,
      selectedIntent: e.selectedIntent,
      confidence: {
        overall: e.confidence.overall,
        numericScore: e.confidence.numericScore,
        factors: e.confidence.factors,
      },
      activeWorkflowStep: e.activeWorkflowStep,
      missingSlots: e.missingSlots,
      chosenTool: e.chosenTool,
      decision: e.decision,
      fallbackReason: e.fallbackReason,
      escalationTrigger: e.escalationTrigger,
      industryRuleTriggered: e.industryRuleTriggered,
      safetyViolations: e.safetyViolations,
      callerContext: e.callerContext,
      metadata: e.metadata,
    }));
  }
}
