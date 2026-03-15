export type IntentType =
  | 'schedule_appointment'
  | 'cancel_appointment'
  | 'reschedule_appointment'
  | 'billing_inquiry'
  | 'prescription_refill'
  | 'test_results'
  | 'urgent_medical'
  | 'general_inquiry'
  | 'speak_to_staff'
  | 'unknown';

export type WorkflowState =
  | 'greeting'
  | 'intent_classification'
  | 'slot_collection'
  | 'confirmation'
  | 'execution'
  | 'escalation'
  | 'completion';

export type SlotType =
  | 'patient_name'
  | 'patient_dob'
  | 'callback_number'
  | 'reason_for_call'
  | 'preferred_provider'
  | 'preferred_location'
  | 'appointment_date'
  | 'appointment_time'
  | 'urgency_level'
  | 'symptom_description';

export type ConversationSlots = Partial<Record<SlotType, string>>;

export interface WorkflowContext {
  tenantId: string;
  callId: string;
  agentSlug: string;
  intent: IntentType;
  state: WorkflowState;
  slots: ConversationSlots;
  turnCount: number;
  escalationAttempts: number;
  transcript: string[];
}

export interface ClassificationResult {
  intent: IntentType;
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
  requiresEscalation: boolean;
  escalationReason?: string;
}

export interface WorkflowTransition {
  fromState: WorkflowState;
  toState: WorkflowState;
  triggeredBy: string;
  timestamp: Date;
  slots: ConversationSlots;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  requiredSlots: SlotType[];
  optionalSlots?: SlotType[];
  confirmationRequired: boolean;
  escalationKeywords?: string[];
}

export interface WorkflowDirective {
  action: 'collect_slot' | 'confirm_summary' | 'execute' | 'escalate' | 'answer' | 'complete';
  slotToCollect?: SlotType;
  missingSlots?: SlotType[];
  prompt?: string;
  summary?: string;
  escalationReason?: string;
  workflow: WorkflowDefinition;
  context: WorkflowContext;
}
