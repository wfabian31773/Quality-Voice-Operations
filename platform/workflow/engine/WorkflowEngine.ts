import { BASE_INTENT_KEYWORDS, mergeIntentKeywords } from '../definitions/intentKeywords';
import { BASE_ESCALATION_KEYWORDS } from '../definitions/escalationKeywords';
import { BASE_SLOT_DEFINITIONS } from '../definitions/slotDefinitions';
import { recordTrace } from '../../core/observability/traceLogger';
import type {
  IntentType,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowDirective,
  WorkflowTransition,
  ClassificationResult,
  SlotType,
  ConversationSlots,
} from '../types';

export interface WorkflowEngineConfig {
  intentKeywords?: Partial<Record<IntentType, string[]>>;
  escalationKeywords?: string[];
  workflows: WorkflowDefinition[];
  tenantId?: string;
  callSessionId?: string;
}

/**
 * Stateless conversational workflow engine.
 *
 * The engine classifies intent, tracks slot collection state, and emits
 * typed directives that tell the agent runtime what to do next.
 *
 * Agent templates provide their own keyword/workflow definitions via config;
 * the engine itself has no vertical-specific knowledge.
 */
export class WorkflowEngine {
  private readonly intentKeywords: Record<IntentType, string[]>;
  private readonly escalationKeywords: string[];
  private readonly workflows: Map<string, WorkflowDefinition>;
  private transitionLog: WorkflowTransition[] = [];
  private tenantId?: string;
  private callSessionId?: string;

  constructor(config: WorkflowEngineConfig) {
    this.intentKeywords = mergeIntentKeywords(config.intentKeywords ?? {});
    this.escalationKeywords = [
      ...BASE_ESCALATION_KEYWORDS,
      ...(config.escalationKeywords ?? []),
    ];
    this.workflows = new Map(config.workflows.map((w) => [w.id, w]));
    this.tenantId = config.tenantId;
    this.callSessionId = config.callSessionId;
  }

  setTraceContext(tenantId: string, callSessionId: string): void {
    this.tenantId = tenantId;
    this.callSessionId = callSessionId;
  }

  private emitTrace(
    traceType: 'intent_classified' | 'slot_collected' | 'workflow_started' | 'workflow_step' | 'escalation_check' | 'confirmation_requested',
    stepName: string,
    inputData?: Record<string, unknown>,
    outputData?: Record<string, unknown>,
    durationMs?: number,
  ): void {
    if (!this.tenantId || !this.callSessionId) return;
    recordTrace({
      tenantId: this.tenantId,
      callSessionId: this.callSessionId,
      traceType,
      stepName,
      startedAt: new Date(),
      endedAt: durationMs != null ? new Date() : undefined,
      durationMs,
      inputData,
      outputData,
    }).catch(() => {});
  }

  classifyIntent(utterance: string): ClassificationResult {
    const startTime = Date.now();
    const normalized = utterance.toLowerCase();

    for (const keyword of this.escalationKeywords) {
      if (normalized.includes(keyword.toLowerCase())) {
        const result: ClassificationResult = {
          intent: 'urgent_medical',
          confidence: 'high',
          matchedKeywords: [keyword],
          requiresEscalation: true,
          escalationReason: `Urgent keyword detected: "${keyword}"`,
        };
        this.emitTrace('intent_classified', 'classify_intent', { utterance: normalized }, { ...result }, Date.now() - startTime);
        return result;
      }
    }

    const scores: Partial<Record<IntentType, number>> = {};
    const allMatched: string[] = [];

    for (const [intentStr, keywords] of Object.entries(this.intentKeywords)) {
      const intent = intentStr as IntentType;
      if (intent === 'unknown') continue;
      let score = 0;
      for (const kw of keywords) {
        if (normalized.includes(kw.toLowerCase())) {
          score += kw.split(' ').length;
          allMatched.push(kw);
        }
      }
      if (score > 0) scores[intent] = score;
    }

    const topIntent = Object.entries(scores).sort(([, a], [, b]) => b - a)[0];

    if (!topIntent) {
      const result: ClassificationResult = {
        intent: 'unknown',
        confidence: 'low',
        matchedKeywords: [],
        requiresEscalation: false,
      };
      this.emitTrace('intent_classified', 'classify_intent', { utterance: normalized }, { ...result }, Date.now() - startTime);
      return result;
    }

    const [intent, score] = topIntent as [IntentType, number];
    const confidence = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';

    const result: ClassificationResult = {
      intent,
      confidence,
      matchedKeywords: allMatched,
      requiresEscalation: false,
    };
    this.emitTrace('intent_classified', 'classify_intent', { utterance: normalized }, { ...result }, Date.now() - startTime);
    return result;
  }

  getNextDirective(context: WorkflowContext): WorkflowDirective {
    const workflow = this.getWorkflowForIntent(context.intent);

    if (!workflow) {
      const directive: WorkflowDirective = {
        action: 'escalate',
        escalationReason: `No workflow found for intent: ${context.intent}`,
        workflow: this.fallbackWorkflow(),
        context,
      };
      this.emitTrace('escalation_check', 'no_workflow_escalation', { intent: context.intent }, { action: 'escalate' });
      return directive;
    }

    this.emitTrace('workflow_step', `workflow_${workflow.id}`, { intent: context.intent, state: context.state }, { workflowName: workflow.name });

    const missing = this.getMissingRequiredSlots(workflow, context.slots);

    if (missing.length > 0) {
      this.emitTrace('slot_collected', `collect_${missing[0]}`, { missingSlots: missing, currentSlots: context.slots as Record<string, unknown> }, { slotToCollect: missing[0] });
      return {
        action: 'collect_slot',
        slotToCollect: missing[0],
        missingSlots: missing,
        prompt: BASE_SLOT_DEFINITIONS[missing[0]]?.prompt,
        workflow,
        context,
      };
    }

    if (workflow.confirmationRequired && context.state !== 'confirmation') {
      this.emitTrace('confirmation_requested', `confirm_${workflow.id}`, { slots: context.slots as Record<string, unknown> }, { action: 'confirm_summary' });
      return {
        action: 'confirm_summary',
        summary: this.buildSummary(workflow, context.slots),
        workflow,
        context,
      };
    }

    this.emitTrace('workflow_step', `execute_${workflow.id}`, { slots: context.slots as Record<string, unknown> }, { action: 'execute' });
    return {
      action: 'execute',
      workflow,
      context,
    };
  }

  recordTransition(
    from: WorkflowContext['state'],
    to: WorkflowContext['state'],
    triggeredBy: string,
    slots: ConversationSlots,
  ): void {
    this.transitionLog.push({
      fromState: from,
      toState: to,
      triggeredBy,
      timestamp: new Date(),
      slots,
    });
  }

  getTransitionLog(): WorkflowTransition[] {
    return [...this.transitionLog];
  }

  private getWorkflowForIntent(intent: IntentType): WorkflowDefinition | undefined {
    return this.workflows.get(intent);
  }

  private getMissingRequiredSlots(
    workflow: WorkflowDefinition,
    slots: ConversationSlots,
  ): SlotType[] {
    return workflow.requiredSlots.filter((s) => !slots[s]);
  }

  private buildSummary(workflow: WorkflowDefinition, slots: ConversationSlots): string {
    const lines = [`I'd like to confirm the following for ${workflow.name}:`];
    for (const [slotType, value] of Object.entries(slots)) {
      const def = BASE_SLOT_DEFINITIONS[slotType as SlotType];
      if (def && value) {
        lines.push(`  ${def.label}: ${value}`);
      }
    }
    lines.push('Is that correct?');
    return lines.join('\n');
  }

  private fallbackWorkflow(): WorkflowDefinition {
    return {
      id: 'fallback',
      name: 'Escalation',
      requiredSlots: [],
      confirmationRequired: false,
    };
  }
}
