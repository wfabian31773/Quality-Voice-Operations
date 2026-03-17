import { createLogger } from '../core/logger';
import type {
  SafetyCheckResult,
  SafetyViolation,
  SafetyViolationType,
  ReasoningContext,
  TenantPolicy,
  ConfidenceScore,
} from './types';

const logger = createLogger('SAFETY_GATE');

const PROHIBITED_ADVICE_CATEGORIES: Record<string, string[]> = {
  medical: [
    'diagnose', 'diagnosis', 'prescribe', 'prescription',
    'take this medication', 'you have', 'you are suffering from',
    'stop taking', 'increase dosage', 'decrease dosage',
  ],
  legal: [
    'you should sue', 'file a lawsuit', 'legal advice',
    'plead guilty', 'plead not guilty', 'sign this contract',
    'you are liable', 'you are not liable',
  ],
  financial: [
    'invest in', 'buy this stock', 'sell your',
    'financial advice', 'tax advice', 'you owe',
    'you should pay', 'settle for',
  ],
};

const DEFAULT_TOOLS_REQUIRING_COMPLETE_DATA: Record<string, string[]> = {
  createServiceTicket: ['caller_name', 'reason_for_call', 'callback_number'],
  createAfterHoursTicket: ['caller_name', 'symptom_description', 'callback_number'],
  triageEscalate: ['urgency_level', 'symptom_description'],
  retrieve_knowledge: [],
};

export class SafetyGate {
  private readonly verticalProhibitions: string[];
  private readonly additionalPolicies: TenantPolicy[];

  constructor(
    vertical?: string,
    additionalPolicies: TenantPolicy[] = [],
  ) {
    this.verticalProhibitions = this.getProhibitionsForVertical(vertical);
    this.additionalPolicies = additionalPolicies;
  }

  checkPreExecution(
    context: ReasoningContext,
    toolName: string,
    toolArgs: Record<string, unknown>,
    confidence: ConfidenceScore,
    toolArgSlots?: Set<string>,
  ): SafetyCheckResult {
    const violations: SafetyViolation[] = [];

    this.checkMissingRequiredData(toolName, context, violations, toolArgSlots);
    this.checkUnauthorizedTool(toolName, context, violations);
    this.checkHallucinatedConfirmation(toolArgs, confidence, violations);
    this.checkTenantPolicies(toolName, context, violations);

    const allowed = violations.filter((v) => v.severity === 'critical').length === 0;

    if (!allowed) {
      logger.warn('Safety gate blocked execution', {
        callId: context.callSessionId,
        tool: toolName,
        violations: violations.map((v) => v.type),
      });
    }

    return { allowed, violations };
  }

  checkResponseSafety(
    responseText: string,
    context: ReasoningContext,
  ): SafetyCheckResult {
    const violations: SafetyViolation[] = [];
    const lower = responseText.toLowerCase();

    this.checkProhibitedAdvice(lower, context, violations);

    const allowed = violations.filter((v) => v.severity === 'critical').length === 0;

    if (!allowed) {
      logger.warn('Safety gate blocked response', {
        callId: context.callSessionId,
        violations: violations.map((v) => v.type),
      });
    }

    return { allowed, violations };
  }

  private checkMissingRequiredData(
    toolName: string,
    context: ReasoningContext,
    violations: SafetyViolation[],
    toolArgSlots?: Set<string>,
  ): void {
    const manifestRequired = context.slotTracker.manifest.slots
      .filter((s) => s.required)
      .map((s) => s.name);
    const requiredSlots = manifestRequired.length > 0
      ? manifestRequired
      : DEFAULT_TOOLS_REQUIRING_COMPLETE_DATA[toolName];
    if (!requiredSlots) return;

    const missingSlots: string[] = [];
    const toolArgOnlySlots: string[] = [];
    for (const slotName of requiredSlots) {
      const slot = context.slotTracker.slots.get(slotName);
      if (!slot || slot.value === null) {
        missingSlots.push(slotName);
      } else if (toolArgSlots && toolArgSlots.has(slotName)) {
        toolArgOnlySlots.push(slotName);
      }
    }

    if (missingSlots.length > 0) {
      violations.push({
        type: 'missing_required_data',
        description: `Tool "${toolName}" requires data that has not been collected: ${missingSlots.join(', ')}`,
        blockedAction: toolName,
        severity: 'critical',
      });
    }

    if (toolArgOnlySlots.length > 0) {
      violations.push({
        type: 'missing_required_data',
        description: `Tool "${toolName}" has required data only from model-generated tool args (not caller-provided): ${toolArgOnlySlots.join(', ')}. Caller must provide this data directly.`,
        blockedAction: toolName,
        severity: 'critical',
      });
      logger.warn('Required slots filled only by tool args, not caller — blocking execution', {
        callId: context.callSessionId,
        tool: toolName,
        slots: toolArgOnlySlots,
      });
    }
  }

  private checkUnauthorizedTool(
    toolName: string,
    context: ReasoningContext,
    violations: SafetyViolation[],
  ): void {
    if (!context.toolsAvailable.includes(toolName)) {
      violations.push({
        type: 'unauthorized_tool',
        description: `Tool "${toolName}" is not available for this agent configuration`,
        blockedAction: toolName,
        severity: 'critical',
      });
    }
  }

  private checkHallucinatedConfirmation(
    toolArgs: Record<string, unknown>,
    confidence: ConfidenceScore,
    violations: SafetyViolation[],
  ): void {
    if (confidence.overall === 'low' && confidence.factors.slotCompleteness < 0.5) {
      const hasConfirmation = Object.values(toolArgs).some(
        (v) => typeof v === 'boolean' && v === true,
      );
      if (hasConfirmation) {
        violations.push({
          type: 'hallucinated_confirmation',
          description: 'Tool execution attempted with confirmation flags despite low confidence and incomplete data',
          severity: 'critical',
        });
      }
    }
  }

  private checkProhibitedAdvice(
    responseText: string,
    context: ReasoningContext,
    violations: SafetyViolation[],
  ): void {
    const allProhibitions = [...this.verticalProhibitions];

    for (const phrase of allProhibitions) {
      if (responseText.includes(phrase.toLowerCase())) {
        violations.push({
          type: 'prohibited_advice',
          description: `Response contains prohibited advice phrase: "${phrase}"`,
          severity: 'critical',
        });
      }
    }
  }

  private checkTenantPolicies(
    toolName: string,
    context: ReasoningContext,
    violations: SafetyViolation[],
  ): void {
    for (const policy of [...this.additionalPolicies, ...context.tenantPolicies]) {
      if (policy.type === 'block_tool' && policy.action === toolName) {
        violations.push({
          type: 'policy_violation',
          description: `Tenant policy "${policy.name}" blocks tool "${toolName}"`,
          blockedAction: toolName,
          severity: 'critical',
        });
      }

      if (policy.type === 'require_confirmation') {
        const targetTool = policy.condition.tool as string | undefined;
        if (targetTool === toolName) {
          const confirmationSlot = policy.condition.confirmationSlot as string | undefined;
          if (confirmationSlot) {
            const slot = context.slotTracker.slots.get(confirmationSlot);
            if (!slot || slot.value === null) {
              violations.push({
                type: 'missing_required_data',
                description: `Tenant policy "${policy.name}" requires confirmation via "${confirmationSlot}" before executing "${toolName}"`,
                blockedAction: toolName,
                severity: 'critical',
              });
            }
          }
        }
      }
    }
  }

  private getProhibitionsForVertical(vertical?: string): string[] {
    if (!vertical) return [];

    const prohibitions: string[] = [];

    if (['medical-after-hours', 'dental'].includes(vertical)) {
      prohibitions.push(...(PROHIBITED_ADVICE_CATEGORIES.medical ?? []));
    }

    if (vertical === 'legal') {
      prohibitions.push(...(PROHIBITED_ADVICE_CATEGORIES.legal ?? []));
    }

    if (vertical === 'insurance') {
      prohibitions.push(...(PROHIBITED_ADVICE_CATEGORIES.financial ?? []));
    }

    return prohibitions;
  }
}
