import { createLogger } from '../core/logger';
import type {
  WorkflowPlan,
  WorkflowPlanStep,
  IndustryVertical,
  ReasoningContext,
} from './types';

const logger = createLogger('WORKFLOW_PLANNER');

export interface WorkflowPlanTemplate {
  vertical: IndustryVertical | string;
  intent: string;
  steps: Omit<WorkflowPlanStep, 'completed' | 'skipped' | 'result'>[];
}

const COMMON_PLAN_TEMPLATES: WorkflowPlanTemplate[] = [
  {
    vertical: '*',
    intent: 'schedule_appointment',
    steps: [
      { id: 'identify', name: 'Identify Caller', description: 'Collect caller identity and verify returning caller', requiredSlots: ['caller_name', 'callback_number'] },
      { id: 'reason', name: 'Determine Reason', description: 'Understand the purpose of the appointment', requiredSlots: ['reason_for_call'] },
      { id: 'availability', name: 'Check Availability', description: 'Verify appointment availability', requiredSlots: ['preferred_date', 'preferred_time'] },
      { id: 'schedule', name: 'Schedule Appointment', description: 'Book the appointment', requiredSlots: [], toolToExecute: 'createServiceTicket' },
      { id: 'confirm', name: 'Confirm Details', description: 'Confirm details back to the caller', requiredSlots: [] },
    ],
  },
  {
    vertical: '*',
    intent: 'general_inquiry',
    steps: [
      { id: 'identify', name: 'Identify Caller', description: 'Greet and identify the caller', requiredSlots: ['caller_name'] },
      { id: 'understand', name: 'Understand Question', description: 'Clarify the inquiry', requiredSlots: ['reason_for_call'] },
      { id: 'research', name: 'Research Answer', description: 'Look up information in knowledge base', requiredSlots: [], toolToExecute: 'retrieve_knowledge' },
      { id: 'respond', name: 'Provide Answer', description: 'Deliver the answer to the caller', requiredSlots: [] },
      { id: 'followup', name: 'Follow Up', description: 'Ask if there are additional questions', requiredSlots: [] },
    ],
  },
  {
    vertical: '*',
    intent: 'billing_inquiry',
    steps: [
      { id: 'identify', name: 'Identify Caller', description: 'Verify caller identity for billing access', requiredSlots: ['caller_name', 'callback_number'] },
      { id: 'understand', name: 'Understand Issue', description: 'Determine the billing concern', requiredSlots: ['reason_for_call'] },
      { id: 'resolve', name: 'Resolve or Escalate', description: 'Provide information or escalate to billing department', requiredSlots: [] },
      { id: 'ticket', name: 'Create Ticket', description: 'Create a follow-up ticket if needed', requiredSlots: [], toolToExecute: 'createServiceTicket' },
    ],
  },
  {
    vertical: '*',
    intent: 'service_request',
    steps: [
      { id: 'identify', name: 'Identify Caller', description: 'Collect caller identity', requiredSlots: ['caller_name', 'callback_number'] },
      { id: 'problem', name: 'Understand Problem', description: 'Determine the service issue', requiredSlots: ['reason_for_call'] },
      { id: 'create_ticket', name: 'Create Service Ticket', description: 'Create the service request', requiredSlots: [], toolToExecute: 'createServiceTicket' },
      { id: 'confirm', name: 'Confirm Details', description: 'Confirm the ticket details', requiredSlots: [] },
    ],
  },
  {
    vertical: '*',
    intent: 'maintenance_request',
    steps: [
      { id: 'identify', name: 'Identify Caller', description: 'Collect caller and unit information', requiredSlots: ['caller_name', 'callback_number'] },
      { id: 'issue', name: 'Describe Issue', description: 'Understand the maintenance issue', requiredSlots: ['reason_for_call'] },
      { id: 'create_ticket', name: 'Create Maintenance Ticket', description: 'Submit the maintenance request', requiredSlots: [], toolToExecute: 'createServiceTicket' },
      { id: 'confirm', name: 'Confirm Submission', description: 'Confirm the request was submitted', requiredSlots: [] },
    ],
  },
  {
    vertical: '*',
    intent: 'make_reservation',
    steps: [
      { id: 'identify', name: 'Identify Caller', description: 'Collect caller name', requiredSlots: ['caller_name'] },
      { id: 'details', name: 'Reservation Details', description: 'Collect reservation information', requiredSlots: ['reason_for_call'] },
      { id: 'book', name: 'Book Reservation', description: 'Create the reservation', requiredSlots: [], toolToExecute: 'createServiceTicket' },
      { id: 'confirm', name: 'Confirm Reservation', description: 'Confirm reservation details', requiredSlots: [] },
    ],
  },
  {
    vertical: '*',
    intent: 'schedule_viewing',
    steps: [
      { id: 'identify', name: 'Identify Caller', description: 'Collect caller contact information', requiredSlots: ['caller_name', 'callback_number'] },
      { id: 'property', name: 'Property Interest', description: 'Determine property of interest', requiredSlots: ['reason_for_call'] },
      { id: 'create_ticket', name: 'Schedule Viewing', description: 'Create viewing request', requiredSlots: [], toolToExecute: 'createServiceTicket' },
      { id: 'confirm', name: 'Confirm Viewing', description: 'Confirm viewing details', requiredSlots: [] },
    ],
  },
  {
    vertical: '*',
    intent: 'schedule_consultation',
    steps: [
      { id: 'identify', name: 'Identify Caller', description: 'Collect caller information', requiredSlots: ['caller_name', 'callback_number'] },
      { id: 'case', name: 'Case Details', description: 'Understand the consultation topic', requiredSlots: ['reason_for_call'] },
      { id: 'create_ticket', name: 'Schedule Consultation', description: 'Create consultation request', requiredSlots: [], toolToExecute: 'createServiceTicket' },
      { id: 'confirm', name: 'Confirm Consultation', description: 'Confirm consultation details', requiredSlots: [] },
    ],
  },
  {
    vertical: '*',
    intent: 'file_claim',
    steps: [
      { id: 'identify', name: 'Identify Caller', description: 'Collect caller and policy information', requiredSlots: ['caller_name', 'callback_number'] },
      { id: 'claim', name: 'Claim Details', description: 'Collect claim information', requiredSlots: ['reason_for_call'] },
      { id: 'create_ticket', name: 'File Claim', description: 'Submit the insurance claim', requiredSlots: [], toolToExecute: 'createServiceTicket' },
      { id: 'confirm', name: 'Confirm Filing', description: 'Confirm claim submission', requiredSlots: [] },
    ],
  },
];

export class WorkflowPlanner {
  private readonly templates: Map<string, WorkflowPlanTemplate[]>;

  constructor(additionalTemplates: WorkflowPlanTemplate[] = []) {
    this.templates = new Map();

    for (const tmpl of [...COMMON_PLAN_TEMPLATES, ...additionalTemplates]) {
      const key = this.templateKey(tmpl.vertical, tmpl.intent);
      const existing = this.templates.get(key) ?? [];
      existing.push(tmpl);
      this.templates.set(key, existing);
    }
  }

  createPlan(context: ReasoningContext): WorkflowPlan | null {
    const template = this.findTemplate(context.vertical, context.currentIntent);
    if (!template) {
      logger.debug('No workflow plan template found', {
        vertical: context.vertical,
        intent: context.currentIntent,
      });
      return null;
    }

    const plan: WorkflowPlan = {
      id: `plan_${context.callSessionId}_${Date.now()}`,
      vertical: context.vertical,
      intent: context.currentIntent,
      steps: template.steps.map((s) => ({
        ...s,
        completed: false,
        skipped: false,
      })),
      currentStepIndex: 0,
      startedAt: new Date(),
      status: 'active',
    };

    logger.info('Workflow plan created', {
      callId: context.callSessionId,
      planId: plan.id,
      steps: plan.steps.length,
      intent: context.currentIntent,
    });

    return plan;
  }

  advanceStep(plan: WorkflowPlan): WorkflowPlanStep | null {
    if (plan.status !== 'active') return null;

    const currentStep = plan.steps[plan.currentStepIndex];
    if (!currentStep) return null;

    currentStep.completed = true;
    plan.currentStepIndex++;

    if (plan.currentStepIndex >= plan.steps.length) {
      plan.status = 'completed';
      plan.completedAt = new Date();
      logger.info('Workflow plan completed', { planId: plan.id });
      return null;
    }

    const nextStep = plan.steps[plan.currentStepIndex];
    logger.debug('Advanced to next step', {
      planId: plan.id,
      step: nextStep.name,
      index: plan.currentStepIndex,
    });

    return nextStep;
  }

  skipStep(plan: WorkflowPlan, reason?: string): WorkflowPlanStep | null {
    if (plan.status !== 'active') return null;

    const currentStep = plan.steps[plan.currentStepIndex];
    if (currentStep) {
      currentStep.skipped = true;
      logger.debug('Step skipped', { planId: plan.id, step: currentStep.name, reason });
    }

    plan.currentStepIndex++;
    if (plan.currentStepIndex >= plan.steps.length) {
      plan.status = 'completed';
      plan.completedAt = new Date();
      return null;
    }

    return plan.steps[plan.currentStepIndex];
  }

  getCurrentStep(plan: WorkflowPlan): WorkflowPlanStep | null {
    if (plan.status !== 'active') return null;
    return plan.steps[plan.currentStepIndex] ?? null;
  }

  markEscalated(plan: WorkflowPlan): void {
    plan.status = 'escalated';
    plan.completedAt = new Date();
  }

  markAbandoned(plan: WorkflowPlan): void {
    plan.status = 'abandoned';
    plan.completedAt = new Date();
  }

  getPlanSummary(plan: WorkflowPlan): Record<string, unknown> {
    return {
      id: plan.id,
      vertical: plan.vertical,
      intent: plan.intent,
      status: plan.status,
      totalSteps: plan.steps.length,
      completedSteps: plan.steps.filter((s) => s.completed).length,
      skippedSteps: plan.steps.filter((s) => s.skipped).length,
      currentStep: plan.steps[plan.currentStepIndex]?.name ?? null,
      steps: plan.steps.map((s) => ({
        name: s.name,
        completed: s.completed,
        skipped: s.skipped,
        tool: s.toolToExecute ?? null,
      })),
    };
  }

  private findTemplate(vertical: string, intent: string): WorkflowPlanTemplate | undefined {
    const specificKey = this.templateKey(vertical, intent);
    const specificTemplates = this.templates.get(specificKey);
    if (specificTemplates && specificTemplates.length > 0) {
      return specificTemplates[0];
    }

    const wildcardKey = this.templateKey('*', intent);
    const wildcardTemplates = this.templates.get(wildcardKey);
    if (wildcardTemplates && wildcardTemplates.length > 0) {
      return wildcardTemplates[0];
    }

    return undefined;
  }

  private templateKey(vertical: string, intent: string): string {
    return `${vertical}::${intent}`;
  }
}
