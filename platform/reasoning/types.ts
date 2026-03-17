import type { TenantId } from '../core/types';
import type { CallerMemory } from '../infra/memory/types';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type DecisionAction =
  | 'ask_clarifying_question'
  | 'continue_workflow'
  | 'execute_tool'
  | 'escalate_to_human'
  | 'complete_interaction';

export type EscalationTrigger =
  | 'emergency_keyword'
  | 'repeated_confusion'
  | 'billing_dispute'
  | 'low_confidence_retries'
  | 'explicit_human_request'
  | 'policy_violation'
  | 'tool_failure_cascade';

export type EscalationOutput =
  | 'warm_transfer'
  | 'callback'
  | 'urgent_ticket'
  | 'sms_followup';

export type FallbackStep =
  | 'rephrase_request'
  | 'narrow_question'
  | 'collect_callback'
  | 'route_to_human'
  | 'create_ticket';

export type SafetyViolationType =
  | 'unauthorized_tool'
  | 'prohibited_advice'
  | 'hallucinated_confirmation'
  | 'missing_required_data'
  | 'phi_exposure_risk'
  | 'policy_violation';

export type IndustryVertical =
  | 'hvac'
  | 'plumbing'
  | 'dental'
  | 'medical-after-hours'
  | 'property-management'
  | 'legal'
  | 'restaurant'
  | 'real-estate'
  | 'insurance';

export interface SlotManifestEntry {
  name: string;
  label: string;
  required: boolean;
  prompt: string;
  validation?: (value: string) => boolean;
  sensitive?: boolean;
}

export interface SlotState {
  name: string;
  value: string | null;
  required: boolean;
  filledAtTurn: number | null;
  attempts: number;
}

export interface SlotManifest {
  vertical: string;
  intent: string;
  slots: SlotManifestEntry[];
}

export interface SlotTrackerState {
  manifest: SlotManifest;
  slots: Map<string, SlotState>;
  currentTurn: number;
}

export interface ConfidenceFactors {
  intentCertainty: ConfidenceLevel;
  slotCompleteness: number;
  toolResultCertainty: ConfidenceLevel;
  conversationAmbiguity: ConfidenceLevel;
  turnsWithoutProgress: number;
}

export interface ConfidenceScore {
  overall: ConfidenceLevel;
  numericScore: number;
  factors: ConfidenceFactors;
  timestamp: Date;
}

export interface WorkflowPlanStep {
  id: string;
  name: string;
  description: string;
  requiredSlots: string[];
  toolToExecute?: string;
  completed: boolean;
  skipped: boolean;
  result?: unknown;
}

export interface WorkflowPlan {
  id: string;
  vertical: string;
  intent: string;
  steps: WorkflowPlanStep[];
  currentStepIndex: number;
  startedAt: Date;
  completedAt?: Date;
  status: 'active' | 'completed' | 'escalated' | 'abandoned';
}

export interface FallbackState {
  currentStep: FallbackStep;
  stepIndex: number;
  reason: string;
  attempts: number;
  maxAttempts: number;
}

export interface ConversationRecoveryState {
  priorIntent: string | null;
  priorSlots: Record<string, string>;
  topicSwitchCount: number;
  lastActivityTimestamp: Date;
  partialAnswerBuffer: string[];
  toolFailureCount: number;
  recoveryPrompt?: string;
}

export interface EscalationEvent {
  trigger: EscalationTrigger;
  output: EscalationOutput;
  reason: string;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

export interface SafetyCheckResult {
  allowed: boolean;
  violations: SafetyViolation[];
}

export interface SafetyViolation {
  type: SafetyViolationType;
  description: string;
  blockedAction?: string;
  severity: 'critical' | 'warning';
}

export interface IndustryReasoningRule {
  id: string;
  vertical: IndustryVertical;
  name: string;
  description: string;
  evaluate: (context: ReasoningContext) => IndustryRuleResult;
}

export interface IndustryRuleResult {
  triggered: boolean;
  action?: DecisionAction;
  urgencyOverride?: 'emergency' | 'urgent' | 'normal';
  additionalContext?: string;
  modifiedConfidence?: ConfidenceLevel;
}

export interface IndustryReasoningPack {
  vertical: IndustryVertical;
  displayName: string;
  rules: IndustryReasoningRule[];
  slotManifests: Record<string, SlotManifest>;
  escalationKeywords: string[];
  prohibitedAdviceCategories: string[];
}

export interface CallerContext {
  memory: CallerMemory | null;
  isReturningCaller: boolean;
  hasOpenTickets: boolean;
  openTicketIds: string[];
  lastCallSummary?: string;
  preferredContactMethod?: string;
}

export interface ReasoningTraceEntry {
  timestamp: Date;
  turn: number;
  selectedIntent: string;
  confidence: ConfidenceScore;
  activeWorkflowStep?: string;
  missingSlots: string[];
  chosenTool?: string;
  decision: DecisionAction;
  fallbackReason?: string;
  escalationTrigger?: EscalationTrigger;
  industryRuleTriggered?: string;
  safetyViolations: SafetyViolation[];
  callerContext?: { isReturning: boolean; openTickets: number };
  metadata: Record<string, unknown>;
}

export interface ReasoningContext {
  tenantId: TenantId;
  callSessionId: string;
  callSid: string;
  agentSlug: string;
  vertical: IndustryVertical | string;
  callerNumber: string;
  currentUtterance: string;
  currentIntent: string;
  intentConfidence: ConfidenceLevel;
  slotTracker: SlotTrackerState;
  workflowPlan: WorkflowPlan | null;
  fallbackState: FallbackState | null;
  recoveryState: ConversationRecoveryState;
  callerContext: CallerContext;
  turnCount: number;
  transcript: string[];
  toolsAvailable: string[];
  tenantPolicies: TenantPolicy[];
  escalationAttempts: number;
}

export interface TenantPolicy {
  id: string;
  name: string;
  type: 'require_data' | 'block_tool' | 'block_advice' | 'require_confirmation';
  condition: Record<string, unknown>;
  action: string;
}

export interface DecisionResult {
  action: DecisionAction;
  confidence: ConfidenceScore;
  reasoning: string;
  toolToExecute?: string;
  toolArgs?: Record<string, unknown>;
  clarifyingQuestion?: string;
  escalation?: EscalationEvent;
  fallbackStep?: FallbackStep;
  traceEntry: ReasoningTraceEntry;
}
