import { createLogger } from '../core/logger';
import { ConfidenceScorer } from './ConfidenceScorer';
import { EscalationManager } from './EscalationManager';
import { SafetyGate } from './SafetyGate';
import { FallbackManager } from './FallbackManager';
import { ReasoningTrace } from './ReasoningTrace';
import { getIndustryPack } from './industry-packs';
import type {
  ReasoningContext,
  DecisionResult,
  DecisionAction,
  ConfidenceScore,
  WorkflowPlanStep,
  IndustryRuleResult,
  TenantPolicy,
} from './types';

const logger = createLogger('DECISION_ENGINE');

export interface DecisionEngineConfig {
  confidenceProceedThreshold?: number;
  confidenceClarifyThreshold?: number;
  tenantPolicies?: TenantPolicy[];
  vertical?: string;
  fallbackManager?: FallbackManager;
  escalationManager?: EscalationManager;
}

export class DecisionEngine {
  private readonly scorer: ConfidenceScorer;
  private readonly escalationManager: EscalationManager;
  private readonly safetyGate: SafetyGate;
  private readonly fallbackManager: FallbackManager;
  private readonly trace: ReasoningTrace;
  private readonly vertical?: string;

  constructor(
    callSessionId: string,
    config: DecisionEngineConfig = {},
  ) {
    this.scorer = new ConfidenceScorer(
      config.confidenceProceedThreshold,
      config.confidenceClarifyThreshold,
    );
    this.escalationManager = config.escalationManager ?? new EscalationManager();
    this.safetyGate = new SafetyGate(config.vertical, config.tenantPolicies);
    this.fallbackManager = config.fallbackManager ?? new FallbackManager();
    this.trace = new ReasoningTrace(callSessionId);
    this.vertical = config.vertical;
  }

  evaluate(context: ReasoningContext): DecisionResult {
    const confidence = this.scorer.score(context);

    const industryResult = this.evaluateIndustryRules(context);
    if (industryResult && industryResult.action === 'escalate_to_human') {
      return this.buildResult(
        'escalate_to_human',
        confidence,
        `Industry rule triggered escalation: ${industryResult.additionalContext ?? 'unknown'}`,
        context,
        { industryRuleTriggered: industryResult.additionalContext },
      );
    }

    const escalation = this.escalationManager.evaluate(context, confidence);
    if (escalation) {
      if (context.workflowPlan) {
        context.workflowPlan.status = 'escalated';
        context.workflowPlan.completedAt = new Date();
      }
      return this.buildResult(
        'escalate_to_human',
        confidence,
        escalation.reason,
        context,
        { escalation },
      );
    }

    if (context.workflowPlan) {
      if (context.workflowPlan.status === 'completed') {
        return this.buildResult(
          'complete_interaction',
          confidence,
          'Workflow plan completed successfully',
          context,
          {},
        );
      }
      const currentStep = context.workflowPlan.steps[context.workflowPlan.currentStepIndex];
      if (currentStep) {
        return this.evaluateWorkflowStep(context, confidence, currentStep, industryResult);
      }
      return this.buildResult(
        'complete_interaction',
        confidence,
        'All workflow steps processed',
        context,
        {},
      );
    }

    if (this.scorer.shouldProceed(confidence)) {
      const missingRequired = this.getMissingRequiredSlots(context);
      if (missingRequired.length === 0) {
        return this.evaluateToolExecution(context, confidence, industryResult);
      }

      return this.buildResult(
        'ask_clarifying_question',
        confidence,
        `Missing required slots: ${missingRequired.join(', ')}`,
        context,
        { clarifyingQuestion: this.getSlotPrompt(context, missingRequired[0]) },
      );
    }

    if (this.scorer.shouldClarify(confidence)) {
      this.escalationManager.recordConfusion();
      const fallback = this.fallbackManager.initiateFallback('low_confidence');

      if (this.fallbackManager.requiresEscalation()) {
        this.fallbackManager.initiateFallback('escalation_pending');
        if (this.fallbackManager.requiresTicketFallback()) {
          return this.buildResult(
            'execute_tool',
            confidence,
            'Human routing reached — creating fallback ticket for follow-up',
            context,
            { fallbackStep: 'create_ticket', toolToExecute: 'createServiceTicket' },
          );
        }
        return this.buildResult(
          'escalate_to_human',
          confidence,
          'Fallback chain exhausted, escalating',
          context,
          { fallbackStep: fallback.currentStep },
        );
      }

      return this.buildResult(
        'ask_clarifying_question',
        confidence,
        `Confidence too low to proceed (${confidence.numericScore.toFixed(2)}), requesting clarification`,
        context,
        {
          clarifyingQuestion: this.fallbackManager.getFallbackPrompt(),
          fallbackStep: fallback.currentStep,
        },
      );
    }

    this.escalationManager.recordLowConfidence();
    const fallback = this.fallbackManager.initiateFallback('very_low_confidence');

    if (this.fallbackManager.requiresEscalation()) {
      this.fallbackManager.initiateFallback('escalation_pending');
      if (this.fallbackManager.requiresTicketFallback()) {
        return this.buildResult(
          'execute_tool',
          confidence,
          'Human routing reached — creating fallback ticket for follow-up',
          context,
          { fallbackStep: 'create_ticket', toolToExecute: 'createServiceTicket' },
        );
      }
      return this.buildResult(
        'escalate_to_human',
        confidence,
        'Very low confidence and fallback chain exhausted',
        context,
        { fallbackStep: fallback.currentStep },
      );
    }

    return this.buildResult(
      'ask_clarifying_question',
      confidence,
      'Very low confidence, falling back',
      context,
      {
        clarifyingQuestion: this.fallbackManager.getFallbackPrompt(),
        fallbackStep: fallback.currentStep,
      },
    );
  }

  getTrace(): ReasoningTrace {
    return this.trace;
  }

  getFallbackManager(): FallbackManager {
    return this.fallbackManager;
  }

  getEscalationManager(): EscalationManager {
    return this.escalationManager;
  }

  private evaluateWorkflowStep(
    context: ReasoningContext,
    confidence: ConfidenceScore,
    step: WorkflowPlanStep,
    industryResult: IndustryRuleResult | null,
  ): DecisionResult {
    if (this.scorer.shouldEscalate(confidence)) {
      this.escalationManager.recordConfusion();
      return this.buildResult(
        'ask_clarifying_question',
        confidence,
        `Low confidence during workflow step "${step.name}" — clarification needed before proceeding`,
        context,
        {
          clarifyingQuestion: `I want to make sure I'm helping you correctly. Could you tell me more about what you need regarding ${step.name.replace(/_/g, ' ')}?`,
          activeWorkflowStep: step.name,
        },
      );
    }

    const missingForStep = step.requiredSlots.filter((slotName) => {
      const slot = context.slotTracker.slots.get(slotName);
      return !slot || slot.value === null;
    });

    if (missingForStep.length > 0) {
      return this.buildResult(
        'ask_clarifying_question',
        confidence,
        `Workflow step "${step.name}" requires: ${missingForStep.join(', ')}`,
        context,
        {
          clarifyingQuestion: this.getSlotPrompt(context, missingForStep[0]),
          activeWorkflowStep: step.name,
        },
      );
    }

    if (step.toolToExecute) {
      return this.evaluateToolExecution(
        context,
        confidence,
        industryResult,
        step.toolToExecute,
        step.name,
      );
    }

    return this.buildResult(
      'continue_workflow',
      confidence,
      `Workflow step "${step.name}" ready to proceed`,
      context,
      { activeWorkflowStep: step.name },
    );
  }

  private evaluateToolExecution(
    context: ReasoningContext,
    confidence: ConfidenceScore,
    industryResult: IndustryRuleResult | null,
    toolName?: string,
    stepName?: string,
  ): DecisionResult {
    const tool = toolName ?? this.inferTool(context);
    if (!tool) {
      return this.buildResult(
        'continue_workflow',
        confidence,
        'No tool to execute at this stage',
        context,
        { activeWorkflowStep: stepName },
      );
    }

    const safetyCheck = this.safetyGate.checkPreExecution(
      context,
      tool,
      this.buildToolArgs(context),
      confidence,
    );

    if (!safetyCheck.allowed) {
      const criticalViolations = safetyCheck.violations.filter((v) => v.severity === 'critical');
      return this.buildResult(
        'ask_clarifying_question',
        confidence,
        `Safety gate blocked tool "${tool}": ${criticalViolations.map((v) => v.description).join('; ')}`,
        context,
        {
          safetyViolations: safetyCheck.violations,
          activeWorkflowStep: stepName,
        },
      );
    }

    return this.buildResult(
      'execute_tool',
      confidence,
      `Executing tool "${tool}"`,
      context,
      {
        toolToExecute: tool,
        activeWorkflowStep: stepName,
        industryRuleTriggered: industryResult?.additionalContext,
      },
    );
  }

  private evaluateIndustryRules(context: ReasoningContext): IndustryRuleResult | null {
    const pack = getIndustryPack(context.vertical);
    if (!pack) return null;

    const urgencyPriority: Record<string, number> = {
      emergency: 3,
      urgent: 2,
      normal: 1,
    };

    let bestResult: IndustryRuleResult | null = null;
    let bestPriority = -1;

    for (const rule of pack.rules) {
      const result = rule.evaluate(context);
      if (result.triggered) {
        const priority = urgencyPriority[result.urgencyOverride ?? 'normal'] ?? 0;
        const isEscalation = result.action === 'escalate_to_human';

        const effectivePriority = isEscalation ? priority + 10 : priority;

        logger.debug('Industry rule triggered', {
          callId: context.callSessionId,
          rule: rule.id,
          action: result.action,
          urgency: result.urgencyOverride,
          effectivePriority,
        });

        if (effectivePriority > bestPriority) {
          bestResult = result;
          bestPriority = effectivePriority;
        }
      }
    }

    return bestResult;
  }

  private getMissingRequiredSlots(context: ReasoningContext): string[] {
    const missing: string[] = [];
    for (const [name, slot] of context.slotTracker.slots) {
      if (slot.required && slot.value === null) {
        missing.push(name);
      }
    }
    return missing;
  }

  private getSlotPrompt(context: ReasoningContext, slotName: string): string {
    const entry = context.slotTracker.manifest.slots.find((s) => s.name === slotName);
    return entry?.prompt ?? `Could you provide your ${slotName.replace(/_/g, ' ')}?`;
  }

  private inferTool(context: ReasoningContext): string | undefined {
    const intentToolMap: Record<string, string> = {
      schedule_appointment: 'createServiceTicket',
      urgent_medical: 'triageEscalate',
      general_inquiry: 'retrieve_knowledge',
      billing_inquiry: 'createServiceTicket',
      after_hours_medical: 'createAfterHoursTicket',
      service_request: 'createServiceTicket',
      maintenance_request: 'createServiceTicket',
      make_reservation: 'createServiceTicket',
      schedule_viewing: 'createServiceTicket',
      schedule_consultation: 'createServiceTicket',
      file_claim: 'createServiceTicket',
    };

    return intentToolMap[context.currentIntent];
  }

  private buildToolArgs(context: ReasoningContext): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const [name, slot] of context.slotTracker.slots) {
      if (slot.value !== null) {
        args[name] = slot.value;
      }
    }
    return args;
  }

  private buildResult(
    action: DecisionAction,
    confidence: ConfidenceScore,
    reasoning: string,
    context: ReasoningContext,
    extras: {
      toolToExecute?: string;
      clarifyingQuestion?: string;
      escalation?: import('./types').EscalationEvent;
      fallbackStep?: import('./types').FallbackStep;
      activeWorkflowStep?: string;
      safetyViolations?: import('./types').SafetyViolation[];
      industryRuleTriggered?: string;
    } = {},
  ): DecisionResult {
    const traceEntry = this.trace.emit({
      context,
      confidence,
      decision: action,
      chosenTool: extras.toolToExecute,
      fallbackReason: extras.fallbackStep,
      escalationTrigger: extras.escalation?.trigger,
      industryRuleTriggered: extras.industryRuleTriggered,
      safetyViolations: extras.safetyViolations,
      metadata: { reasoning, activeWorkflowStep: extras.activeWorkflowStep },
    });

    return {
      action,
      confidence,
      reasoning,
      toolToExecute: extras.toolToExecute,
      clarifyingQuestion: extras.clarifyingQuestion,
      escalation: extras.escalation,
      fallbackStep: extras.fallbackStep,
      traceEntry,
    };
  }
}
