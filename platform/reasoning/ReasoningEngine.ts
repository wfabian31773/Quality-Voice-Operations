import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';
import { SlotTracker } from './SlotTracker';
import { DecisionEngine } from './DecisionEngine';
import { WorkflowPlanner } from './WorkflowPlanner';
import { FallbackManager } from './FallbackManager';
import { SafetyGate } from './SafetyGate';
import { MemoryManager, type MemoryStorage } from './MemoryManager';
import { getIndustryPack } from './industry-packs';
import type {
  ReasoningContext,
  DecisionResult,
  CallerContext,
  SlotManifest,
  WorkflowPlan,
  ConversationRecoveryState,
  SafetyCheckResult,
  TenantPolicy,
  IndustryVertical,
  ConfidenceLevel,
} from './types';

const logger = createLogger('REASONING_ENGINE');

export interface ReasoningEngineConfig {
  tenantId: TenantId;
  callSessionId: string;
  callSid: string;
  agentSlug: string;
  vertical: string;
  callerNumber: string;
  toolsAvailable: string[];
  tenantPolicies?: TenantPolicy[];
  memoryStorage?: MemoryStorage | null;
  confidenceProceedThreshold?: number;
  confidenceClarifyThreshold?: number;
}

export class ReasoningEngine {
  private config: ReasoningEngineConfig;
  private decisionEngine: DecisionEngine;
  private readonly workflowPlanner: WorkflowPlanner;
  private readonly fallbackManager: FallbackManager;
  private readonly memoryManager: MemoryManager;
  private slotTracker: SlotTracker;
  private workflowPlan: WorkflowPlan | null = null;
  private callerContext: CallerContext;
  private turnCount = 0;
  private transcript: string[] = [];
  private currentIntent = 'unknown';
  private intentConfidence: ConfidenceLevel = 'low';
  private escalationAttempts = 0;
  private preservedSlots: Map<string, Record<string, string>> = new Map();
  private lastDecisionResult: DecisionResult | null = null;
  private toolArgSlots: Set<string> = new Set();

  setCallSessionId(callSessionId: string): void {
    this.config = { ...this.config, callSessionId };
    this.decisionEngine = new DecisionEngine(callSessionId, {
      confidenceProceedThreshold: this.config.confidenceProceedThreshold,
      confidenceClarifyThreshold: this.config.confidenceClarifyThreshold,
      tenantPolicies: this.config.tenantPolicies,
      vertical: this.config.vertical,
      fallbackManager: this.fallbackManager,
    });
  }

  constructor(config: ReasoningEngineConfig) {
    this.config = config;

    this.fallbackManager = new FallbackManager();

    this.decisionEngine = new DecisionEngine(config.callSessionId, {
      confidenceProceedThreshold: config.confidenceProceedThreshold,
      confidenceClarifyThreshold: config.confidenceClarifyThreshold,
      tenantPolicies: config.tenantPolicies,
      vertical: config.vertical,
      fallbackManager: this.fallbackManager,
    });

    const pack = getIndustryPack(config.vertical);
    const additionalTemplates = pack
      ? Object.entries(pack.slotManifests).map(([intent, manifest]) => ({
          vertical: config.vertical,
          intent,
          steps: manifest.slots
            .filter((s) => s.required)
            .map((s, i) => ({
              id: `collect_${s.name}`,
              name: `Collect ${s.label}`,
              description: s.prompt,
              requiredSlots: [s.name],
            })),
        }))
      : [];

    this.workflowPlanner = new WorkflowPlanner(additionalTemplates);
    this.memoryManager = new MemoryManager(config.memoryStorage ?? null);

    const defaultManifest = this.getDefaultSlotManifest();
    this.slotTracker = new SlotTracker(defaultManifest);

    this.callerContext = {
      memory: null,
      isReturningCaller: false,
      hasOpenTickets: false,
      openTicketIds: [],
    };
  }

  async initialize(): Promise<CallerContext> {
    this.callerContext = await this.memoryManager.buildCallerContext(
      this.config.tenantId,
      this.config.callerNumber,
    );

    logger.info('Reasoning engine initialized', {
      callId: this.config.callSessionId,
      vertical: this.config.vertical,
      isReturningCaller: this.callerContext.isReturningCaller,
      openTickets: this.callerContext.openTicketIds.length,
    });

    return this.callerContext;
  }

  getCallerContextPrompt(): string {
    return this.memoryManager.buildCallerContextPrompt(this.callerContext);
  }

  classifyIntent(utterance: string): { intent: string; confidence: ConfidenceLevel } {
    const lower = utterance.toLowerCase();

    const patterns: { intent: string; keywords: string[]; confidence: ConfidenceLevel }[] = [
      { intent: 'schedule_appointment', keywords: ['appointment', 'schedule', 'book', 'booking', 'available', 'opening', 'slot', 'come in'], confidence: 'high' },
      { intent: 'billing_inquiry', keywords: ['bill', 'billing', 'invoice', 'charge', 'payment', 'pay', 'cost', 'price', 'fee', 'refund'], confidence: 'high' },
      { intent: 'urgent_medical', keywords: ['emergency', 'chest pain', 'breathing', 'blood', 'unconscious', 'severe pain', 'can\'t breathe', 'heart attack'], confidence: 'high' },
      { intent: 'general_inquiry', keywords: ['question', 'wondering', 'information', 'hours', 'location', 'address', 'directions', 'how do', 'what is', 'do you'], confidence: 'medium' },
      { intent: 'cancel', keywords: ['cancel', 'cancellation', 'reschedule'], confidence: 'high' },
      { intent: 'complaint', keywords: ['complaint', 'unhappy', 'dissatisfied', 'frustrated', 'terrible', 'awful'], confidence: 'medium' },
      { intent: 'transfer_human', keywords: ['speak to someone', 'talk to a person', 'human', 'real person', 'manager', 'supervisor', 'representative'], confidence: 'high' },
      { intent: 'service_request', keywords: ['repair', 'fix', 'broken', 'not working', 'leak', 'leaking', 'drain', 'clogged', 'furnace', 'ac', 'air conditioning', 'heater', 'heating', 'cooling', 'plumber', 'technician', 'service call'], confidence: 'high' },
      { intent: 'maintenance_request', keywords: ['maintenance', 'broken', 'not working', 'tenant', 'unit', 'apartment', 'landlord', 'property'], confidence: 'high' },
      { intent: 'make_reservation', keywords: ['reservation', 'reserve', 'table', 'dinner', 'lunch', 'party size', 'guests', 'dining'], confidence: 'high' },
      { intent: 'schedule_viewing', keywords: ['viewing', 'showing', 'tour', 'open house', 'property', 'house', 'condo', 'listing', 'real estate'], confidence: 'high' },
      { intent: 'schedule_consultation', keywords: ['consultation', 'consult', 'lawyer', 'attorney', 'legal', 'case', 'represent'], confidence: 'high' },
      { intent: 'file_claim', keywords: ['claim', 'file a claim', 'accident', 'damage', 'insurance', 'policy', 'coverage', 'deductible'], confidence: 'high' },
    ];

    let bestMatch: { intent: string; confidence: ConfidenceLevel; score: number } | null = null;

    for (const pattern of patterns) {
      let matchCount = 0;
      for (const keyword of pattern.keywords) {
        if (lower.includes(keyword)) matchCount++;
      }
      if (matchCount > 0 && (!bestMatch || matchCount > bestMatch.score)) {
        bestMatch = { intent: pattern.intent, confidence: pattern.confidence, score: matchCount };
      }
    }

    if (bestMatch) {
      return { intent: bestMatch.intent, confidence: bestMatch.confidence };
    }

    return { intent: 'unknown', confidence: 'low' };
  }

  getSafetyPolicyPrompt(): string {
    const lines: string[] = [
      '===== SAFETY POLICY =====',
      'CRITICAL: You must NEVER provide the following types of advice:',
    ];
    const vertical = this.config.vertical;
    if (['medical-after-hours', 'dental'].includes(vertical)) {
      lines.push('- Do NOT diagnose conditions, prescribe medications, or suggest changing dosages.');
      lines.push('- Do NOT tell the caller what condition they have or suggest they stop taking medication.');
      lines.push('- Instead, advise the caller to consult with a medical professional.');
    }
    if (vertical === 'legal') {
      lines.push('- Do NOT provide legal advice, recommend filing lawsuits, or advise on pleas.');
      lines.push('- Do NOT tell the caller they are or are not liable.');
      lines.push('- Instead, advise the caller to consult with an attorney.');
    }
    if (vertical === 'insurance') {
      lines.push('- Do NOT provide financial advice, recommend investments, or estimate tax liability.');
      lines.push('- Do NOT tell the caller how much they owe or advise on settlements.');
      lines.push('- Instead, refer the caller to their agent or a qualified financial advisor.');
    }
    lines.push('If a caller asks for advice in these prohibited categories, politely decline and recommend they speak with a qualified professional.');
    lines.push('');
    lines.push('REQUIRED RESPONSE PATTERN for prohibited topics:');
    lines.push('1. Acknowledge the caller\'s concern empathetically.');
    lines.push('2. State clearly that you cannot provide that type of advice.');
    lines.push('3. Recommend the caller speak with a qualified professional.');
    lines.push('4. Offer to help with something within your scope (scheduling, messages, tickets).');
    lines.push('===== END SAFETY POLICY =====');
    return lines.join('\n');
  }

  processUtterance(
    utterance: string,
    intent: string,
    intentConfidence: ConfidenceLevel,
  ): DecisionResult {
    this.turnCount++;
    this.transcript.push(utterance);
    this.slotTracker.advanceTurn();

    const previousIntent = this.currentIntent;

    if (previousIntent !== 'unknown' && intent !== previousIntent && intent !== 'unknown') {
      const priorContext = this.buildContext(utterance);
      priorContext.currentIntent = previousIntent;
      this.fallbackManager.handleTopicSwitch(priorContext);
      this.preservedSlots.set(previousIntent, this.slotTracker.getFilledSlots());
      logger.info('Topic switch detected', {
        callId: this.config.callSessionId,
        from: previousIntent,
        to: intent,
      });
    }

    this.currentIntent = intent;
    this.intentConfidence = intentConfidence;

    if (intent !== 'unknown' && intent !== previousIntent) {
      this.updateSlotManifest(intent);

      const restoredSlots = this.preservedSlots.get(intent);
      if (restoredSlots) {
        for (const [name, value] of Object.entries(restoredSlots)) {
          this.slotTracker.fillSlot(name, value);
        }
      }

      if (!this.workflowPlan || this.workflowPlan.status !== 'active') {
        const context = this.buildContext(utterance);
        this.workflowPlan = this.workflowPlanner.createPlan(context);
      }
    }

    this.extractSlotsFromUtterance(utterance);

    this.autoAdvanceNonToolSteps();

    const context = this.buildContext(utterance);
    const result = this.decisionEngine.evaluate(context);

    if (result.action === 'escalate_to_human') {
      this.escalationAttempts++;
    }

    this.lastDecisionResult = result;

    logger.debug('Utterance processed', {
      callId: this.config.callSessionId,
      turn: this.turnCount,
      intent,
      decision: result.action,
      confidence: result.confidence.overall,
    });

    return result;
  }

  fillSlot(name: string, value: string, source: 'caller' | 'tool_args' = 'caller'): boolean {
    if (source === 'tool_args') {
      this.toolArgSlots.add(name);
    } else {
      this.toolArgSlots.delete(name);
    }
    return this.slotTracker.fillSlot(name, value);
  }

  isSlotCallerProvided(name: string): boolean {
    return this.slotTracker.isSlotFilled(name) && !this.toolArgSlots.has(name);
  }

  advanceWorkflowStep(): void {
    if (this.workflowPlan) {
      this.workflowPlanner.advanceStep(this.workflowPlan);
    }
  }

  private autoAdvanceNonToolSteps(): void {
    if (!this.workflowPlan || this.workflowPlan.status !== 'active') return;

    let advanced = true;
    while (advanced) {
      advanced = false;
      const step = this.workflowPlan.steps[this.workflowPlan.currentStepIndex];
      if (!step || step.toolToExecute) break;

      const missingRequired = step.requiredSlots.filter((slotName) => {
        return !this.slotTracker.isSlotFilled(slotName);
      });

      if (missingRequired.length === 0) {
        this.workflowPlanner.advanceStep(this.workflowPlan);
        advanced = true;
        logger.debug('Auto-advanced non-tool workflow step', {
          callId: this.config.callSessionId,
          step: step.name,
          newIndex: this.workflowPlan.currentStepIndex,
        });
      }
    }
  }

  checkToolSafety(toolName: string, toolArgs: Record<string, unknown>): import('./types').SafetyCheckResult {
    const gate = new SafetyGate(this.config.vertical, this.config.tenantPolicies);
    const context = this.buildContext('');
    const confidence = this.decisionEngine.getTrace().getLatestEntry()?.confidence ?? {
      overall: 'medium' as const,
      numericScore: 0.6,
      factors: { intentCertainty: 'medium' as const, slotCompleteness: this.slotTracker.getCompleteness(), toolResultCertainty: 'high' as const, conversationAmbiguity: 'low' as const, turnsWithoutProgress: 0 },
      timestamp: new Date(),
    };
    return gate.checkPreExecution(context, toolName, toolArgs, confidence, this.toolArgSlots);
  }

  getToolArgSlots(): Set<string> {
    return this.toolArgSlots;
  }

  getLatestDecision(): DecisionResult | null {
    return this.lastDecisionResult;
  }

  handleToolSuccess(toolName: string): void {
    if (this.workflowPlan && this.workflowPlan.status === 'active') {
      const currentStep = this.workflowPlan.steps[this.workflowPlan.currentStepIndex];
      if (currentStep && currentStep.toolToExecute === toolName) {
        this.workflowPlanner.advanceStep(this.workflowPlan);
      }
    }
    this.fallbackManager.resetFallback();
    this.decisionEngine.getEscalationManager().resetCounters();
  }

  handleToolFailure(): void {
    this.fallbackManager.handleToolFailure();
  }

  handleSilence(): ConversationRecoveryState {
    return this.fallbackManager.handleSilence();
  }

  handlePartialAnswer(utterance: string): ConversationRecoveryState {
    return this.fallbackManager.handlePartialAnswer(utterance);
  }

  checkResponseSafety(responseText: string): SafetyCheckResult {
    const gate = new SafetyGate(this.config.vertical);
    const context = this.buildContext('');
    return gate.checkResponseSafety(responseText, context);
  }

  getTraceEntries(): Record<string, unknown>[] {
    return this.decisionEngine.getTrace().toSerializable();
  }

  getCallSummary(): Record<string, unknown> {
    return {
      ...this.decisionEngine.getTrace().getCallSummary(),
      workflowPlan: this.workflowPlan
        ? this.workflowPlanner.getPlanSummary(this.workflowPlan)
        : null,
      slots: this.slotTracker.toSerializable(),
      callerContext: {
        isReturning: this.callerContext.isReturningCaller,
        openTickets: this.callerContext.openTicketIds.length,
      },
      escalationAttempts: this.escalationAttempts,
    };
  }

  getCallerContext(): CallerContext {
    return this.callerContext;
  }

  getWorkflowPlan(): WorkflowPlan | null {
    return this.workflowPlan;
  }

  getCurrentWorkflowStepTool(): string | null {
    if (!this.workflowPlan || this.workflowPlan.status !== 'active') return null;
    const step = this.workflowPlan.steps[this.workflowPlan.currentStepIndex];
    return step?.toolToExecute ?? null;
  }

  private buildContext(utterance: string): ReasoningContext {
    return {
      tenantId: this.config.tenantId,
      callSessionId: this.config.callSessionId,
      callSid: this.config.callSid,
      agentSlug: this.config.agentSlug,
      vertical: this.config.vertical,
      callerNumber: this.config.callerNumber,
      currentUtterance: utterance,
      currentIntent: this.currentIntent,
      intentConfidence: this.intentConfidence,
      slotTracker: this.slotTracker.getState(),
      workflowPlan: this.workflowPlan,
      fallbackState: this.fallbackManager.getFallbackState(),
      recoveryState: this.fallbackManager.getRecoveryState(),
      callerContext: this.callerContext,
      turnCount: this.turnCount,
      transcript: this.transcript,
      toolsAvailable: this.config.toolsAvailable,
      tenantPolicies: this.config.tenantPolicies ?? [],
      escalationAttempts: this.escalationAttempts,
    };
  }

  private updateSlotManifest(intent: string): void {
    const pack = getIndustryPack(this.config.vertical);
    if (pack) {
      const manifest = pack.slotManifests[intent];
      if (manifest) {
        this.slotTracker = new SlotTracker(manifest);
        return;
      }
    }

    const defaultManifest = this.getManifestForIntent(intent);
    this.slotTracker = new SlotTracker(defaultManifest);
  }

  private getDefaultSlotManifest(): SlotManifest {
    const pack = getIndustryPack(this.config.vertical);
    if (pack) {
      const firstManifest = Object.values(pack.slotManifests)[0];
      if (firstManifest) return firstManifest;
    }

    return {
      vertical: this.config.vertical,
      intent: 'default',
      slots: [
        { name: 'caller_name', label: 'Name', required: true, prompt: 'May I have your name?' },
        { name: 'callback_number', label: 'Phone', required: true, prompt: 'What is the best number to reach you?' },
        { name: 'reason_for_call', label: 'Reason', required: true, prompt: 'How can I help you today?' },
      ],
    };
  }

  private getManifestForIntent(intent: string): SlotManifest {
    const intentManifests: Record<string, SlotManifest> = {
      schedule_appointment: {
        vertical: this.config.vertical,
        intent: 'schedule_appointment',
        slots: [
          { name: 'caller_name', label: 'Name', required: true, prompt: 'May I have your name?' },
          { name: 'callback_number', label: 'Phone', required: true, prompt: 'What is the best number to reach you?' },
          { name: 'reason_for_call', label: 'Reason', required: true, prompt: 'What is the reason for the appointment?' },
          { name: 'preferred_date', label: 'Date', required: false, prompt: 'Do you have a preferred date?' },
          { name: 'preferred_time', label: 'Time', required: false, prompt: 'Morning or afternoon?' },
        ],
      },
      billing_inquiry: {
        vertical: this.config.vertical,
        intent: 'billing_inquiry',
        slots: [
          { name: 'caller_name', label: 'Name', required: true, prompt: 'May I have your name?' },
          { name: 'callback_number', label: 'Phone', required: true, prompt: 'What is the best number to reach you?' },
          { name: 'reason_for_call', label: 'Billing Issue', required: true, prompt: 'What is your billing question?' },
        ],
      },
      general_inquiry: {
        vertical: this.config.vertical,
        intent: 'general_inquiry',
        slots: [
          { name: 'caller_name', label: 'Name', required: false, prompt: 'May I have your name?' },
          { name: 'reason_for_call', label: 'Question', required: true, prompt: 'What would you like to know?' },
        ],
      },
    };

    return intentManifests[intent] ?? this.getDefaultSlotManifest();
  }

  private extractSlotsFromUtterance(utterance: string): void {
    const lower = utterance.toLowerCase();
    const manifest = this.slotTracker.getState().manifest;

    for (const slotDef of manifest.slots) {
      if (this.slotTracker.isSlotFilled(slotDef.name)) continue;

      const extracted = this.tryExtractSlotValue(slotDef.name, lower, utterance);
      if (extracted) {
        this.slotTracker.fillSlot(slotDef.name, extracted);
        this.toolArgSlots.delete(slotDef.name);
        logger.debug('Slot extracted from utterance', {
          callId: this.config.callSessionId,
          slot: slotDef.name,
        });
      }
    }
  }

  private tryExtractSlotValue(slotName: string, lowerUtterance: string, originalUtterance: string): string | null {
    switch (slotName) {
      case 'caller_name': {
        const namePatterns = [
          /my name is ([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i,
          /this is ([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i,
          /i'm ([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i,
          /it's ([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i,
        ];
        for (const pattern of namePatterns) {
          const match = originalUtterance.match(pattern);
          if (match && match[1]) return match[1].trim();
        }
        return null;
      }
      case 'callback_number': {
        const phoneMatch = originalUtterance.match(/(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
        return phoneMatch ? phoneMatch[1] : null;
      }
      case 'reason_for_call': {
        const reasonPatterns = [
          /(?:i need|i want|i'd like|i would like|calling about|calling for|calling to|i'm calling about|i'm calling for|need help with)\s+(.+)/i,
        ];
        for (const pattern of reasonPatterns) {
          const match = originalUtterance.match(pattern);
          if (match && match[1] && match[1].length > 3) return match[1].trim();
        }
        return null;
      }
      case 'preferred_date':
      case 'appointment_date': {
        const datePatterns = [
          /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
          /\b(tomorrow|today|next week)\b/i,
          /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/,
          /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i,
        ];
        for (const pattern of datePatterns) {
          const match = originalUtterance.match(pattern);
          if (match) return match[0].trim();
        }
        return null;
      }
      case 'preferred_time':
      case 'appointment_time': {
        const timePatterns = [
          /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))\b/i,
          /\b(morning|afternoon|evening)\b/i,
        ];
        for (const pattern of timePatterns) {
          const match = originalUtterance.match(pattern);
          if (match) return match[0].trim();
        }
        return null;
      }
      case 'symptom_description':
      case 'problem_description':
      case 'issue_description': {
        if (lowerUtterance.length > 10) return originalUtterance.trim();
        return null;
      }
      default:
        return null;
    }
  }

  reEvaluateDecision(): DecisionResult {
    const context = this.buildContext(this.transcript[this.transcript.length - 1] ?? '');
    const result = this.decisionEngine.evaluate(context);
    this.lastDecisionResult = result;
    return result;
  }
}
