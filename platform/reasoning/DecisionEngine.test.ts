import { describe, it, expect } from 'vitest';
import { DecisionEngine } from './DecisionEngine';
import { FallbackManager } from './FallbackManager';
import type { ReasoningContext, WorkflowPlan, WorkflowPlanStep } from './types';
import {
  makeReasoningContext,
  makeRecoveryState,
  makeSlotManifest,
  makeSlotTrackerState,
} from './__fixtures__/reasoningContext';

const REQUIRED = [
  { name: 'caller_name', required: true },
  { name: 'callback_number', required: true },
];

/** High-confidence context (~0.9): both required slots filled, healthy signals. */
function highConfidenceCtx(overrides: Partial<ReasoningContext> = {}): ReasoningContext {
  return makeReasoningContext({
    vertical: 'restaurant', // a pack whose rules ignore the utterances we use
    currentIntent: 'service_request',
    currentUtterance: 'I would like to book a service visit',
    slotTracker: makeSlotTrackerState(makeSlotManifest(REQUIRED, { intent: 'service_request' }), {
      caller_name: 'Ada',
      callback_number: '5551234567',
    }),
    toolsAvailable: ['createServiceTicket'],
    ...overrides,
  });
}

/** Very low confidence context (~0.15): unknown intent, tool failures, no slots. */
function veryLowConfidenceCtx(overrides: Partial<ReasoningContext> = {}): ReasoningContext {
  return makeReasoningContext({
    vertical: 'restaurant',
    intentConfidence: 'low',
    currentIntent: 'unknown',
    currentUtterance: 'uhh I dunno',
    recoveryState: makeRecoveryState({ toolFailureCount: 3 }),
    ...overrides,
  });
}

function step(overrides: Partial<WorkflowPlanStep>): WorkflowPlanStep {
  return {
    id: 's',
    name: 'Step',
    description: 'd',
    requiredSlots: [],
    completed: false,
    skipped: false,
    ...overrides,
  };
}

function activePlan(steps: WorkflowPlanStep[], currentStepIndex = 0): WorkflowPlan {
  return {
    id: 'p1',
    vertical: 'restaurant',
    intent: 'service_request',
    steps,
    currentStepIndex,
    startedAt: new Date(),
    status: 'active',
  };
}

describe('DecisionEngine industry & escalation routing', () => {
  it('escalates when an industry rule classifies an emergency', () => {
    const result = new DecisionEngine('s', { vertical: 'hvac' }).evaluate(
      highConfidenceCtx({ vertical: 'hvac', currentUtterance: 'there is a gas leak in the basement' }),
    );
    expect(result.action).toBe('escalate_to_human');
    expect(result.reasoning).toContain('Industry rule');
  });

  it('escalates on an explicit human request and marks an active plan escalated', () => {
    const ctx = highConfidenceCtx({
      currentUtterance: 'can I talk to a representative please',
      workflowPlan: activePlan([step({ id: 'identify', name: 'Identify' })]),
    });
    const result = new DecisionEngine('s').evaluate(ctx);
    expect(result.action).toBe('escalate_to_human');
    expect(result.escalation?.trigger).toBe('explicit_human_request');
    expect(ctx.workflowPlan?.status).toBe('escalated');
  });
});

describe('DecisionEngine workflow handling', () => {
  it('completes the interaction when the plan is already completed', () => {
    const ctx = highConfidenceCtx({
      currentUtterance: 'great, thanks',
      workflowPlan: { ...activePlan([step({})]), status: 'completed' },
    });
    expect(new DecisionEngine('s').evaluate(ctx).action).toBe('complete_interaction');
  });

  it('asks for a missing slot required by the current workflow step', () => {
    const ctx = highConfidenceCtx({
      slotTracker: makeSlotTrackerState(makeSlotManifest(REQUIRED, { intent: 'service_request' }), {
        caller_name: 'Ada',
      }),
      workflowPlan: activePlan([step({ name: 'Collect Number', requiredSlots: ['callback_number'] })]),
    });
    const result = new DecisionEngine('s').evaluate(ctx);
    expect(result.action).toBe('ask_clarifying_question');
    expect(result.reasoning).toContain('callback_number');
  });

  it('executes a workflow step tool once data is present and the tool is safe', () => {
    const ctx = highConfidenceCtx({
      workflowPlan: activePlan([
        step({ name: 'Create Ticket', requiredSlots: ['caller_name', 'callback_number'], toolToExecute: 'createServiceTicket' }),
      ]),
    });
    const result = new DecisionEngine('s').evaluate(ctx);
    expect(result.action).toBe('execute_tool');
    expect(result.toolToExecute).toBe('createServiceTicket');
  });

  it('continues the workflow for a step that needs no tool', () => {
    const ctx = highConfidenceCtx({
      workflowPlan: activePlan([step({ name: 'Confirm', requiredSlots: ['caller_name'] })]),
    });
    expect(new DecisionEngine('s').evaluate(ctx).action).toBe('continue_workflow');
  });

  it('asks to clarify under low confidence while inside a workflow step', () => {
    const ctx = veryLowConfidenceCtx({
      workflowPlan: activePlan([step({ name: 'Identify' })]),
    });
    const result = new DecisionEngine('s').evaluate(ctx);
    expect(result.action).toBe('ask_clarifying_question');
    expect(result.reasoning).toContain('Low confidence during workflow step');
  });
});

describe('DecisionEngine free-form (no plan) handling', () => {
  it('executes an inferred tool when confident with complete data', () => {
    const result = new DecisionEngine('s').evaluate(highConfidenceCtx());
    expect(result.action).toBe('execute_tool');
    expect(result.toolToExecute).toBe('createServiceTicket');
  });

  it('asks for missing required data even when otherwise ready to proceed', () => {
    // caller_name filled, callback_number blank -> completeness 0.5 still clears
    // the proceed threshold, but the required-slot check must catch the gap.
    const ctx = highConfidenceCtx({
      slotTracker: makeSlotTrackerState(makeSlotManifest(REQUIRED, { intent: 'service_request' }), {
        caller_name: 'Ada',
      }),
      currentUtterance: 'book it',
    });
    const result = new DecisionEngine('s').evaluate(ctx);
    expect(result.action).toBe('ask_clarifying_question');
    expect(result.reasoning).toContain('Missing required slots');
  });

  it('continues when confident and complete but no tool maps to the intent', () => {
    const ctx = highConfidenceCtx({ currentIntent: 'chit_chat' });
    const result = new DecisionEngine('s').evaluate(ctx);
    expect(result.action).toBe('continue_workflow');
    expect(result.reasoning).toContain('No tool to execute');
  });

  it('blocks an unauthorized inferred tool via the safety gate', () => {
    const ctx = highConfidenceCtx({ toolsAvailable: [] });
    const result = new DecisionEngine('s').evaluate(ctx);
    expect(result.action).toBe('ask_clarifying_question');
    expect(result.reasoning).toContain('Safety gate blocked');
    expect(result.traceEntry.safetyViolations.some((v) => v.type === 'unauthorized_tool')).toBe(true);
  });

  it('initiates a fallback and asks to clarify in the mid-confidence band', () => {
    // No slots filled -> ~0.65 -> clarify band.
    const ctx = makeReasoningContext({
      vertical: 'restaurant',
      currentIntent: 'service_request',
      currentUtterance: 'um, well',
      slotTracker: makeSlotTrackerState(makeSlotManifest(REQUIRED, { intent: 'service_request' })),
    });
    const result = new DecisionEngine('s').evaluate(ctx);
    expect(result.action).toBe('ask_clarifying_question');
    expect(result.fallbackStep).toBe('rephrase_request');
  });

  it('falls back under very low confidence with no plan', () => {
    const result = new DecisionEngine('s').evaluate(veryLowConfidenceCtx());
    expect(result.action).toBe('ask_clarifying_question');
    expect(result.reasoning).toContain('Very low confidence');
  });

  it('creates a fallback ticket when the fallback chain reaches human routing', () => {
    // Inject a fallback manager already advanced to collect_callback (index 2);
    // the clarify branch then advances it to route_to_human -> create_ticket.
    const fm = new FallbackManager();
    fm.initiateFallback('seed'); // rephrase_request (0)
    fm.advanceFallback(); // narrow_question (1)
    fm.advanceFallback(); // collect_callback (2)
    const ctx = makeReasoningContext({
      vertical: 'restaurant',
      currentIntent: 'service_request',
      currentUtterance: 'um, well',
      slotTracker: makeSlotTrackerState(makeSlotManifest(REQUIRED, { intent: 'service_request' })),
    });
    const result = new DecisionEngine('s', { fallbackManager: fm }).evaluate(ctx);
    expect(result.action).toBe('execute_tool');
    expect(result.fallbackStep).toBe('create_ticket');
    expect(result.reasoning).toContain('Human routing reached');
  });
});

describe('DecisionEngine accessors & trace', () => {
  it('exposes its trace, fallback and escalation managers and records entries', () => {
    const engine = new DecisionEngine('session-xyz');
    expect(engine.getFallbackManager()).toBeInstanceOf(FallbackManager);
    expect(engine.getEscalationManager()).toBeTruthy();
    engine.evaluate(highConfidenceCtx());
    expect(engine.getTrace().getEntries()).toHaveLength(1);
  });
});
