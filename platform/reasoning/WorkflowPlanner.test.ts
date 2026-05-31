import { describe, it, expect } from 'vitest';
import { WorkflowPlanner, type WorkflowPlanTemplate } from './WorkflowPlanner';
import type { WorkflowPlan } from './types';
import { makeReasoningContext } from './__fixtures__/reasoningContext';

function planFor(intent: string, vertical = 'hvac'): WorkflowPlan {
  const plan = new WorkflowPlanner().createPlan(
    makeReasoningContext({ currentIntent: intent, vertical }),
  );
  if (!plan) throw new Error(`expected a plan for ${intent}`);
  return plan;
}

describe('WorkflowPlanner.createPlan', () => {
  it('builds an active plan from the matching template with fresh step flags', () => {
    const plan = planFor('service_request');
    expect(plan.status).toBe('active');
    expect(plan.currentStepIndex).toBe(0);
    expect(plan.intent).toBe('service_request');
    expect(plan.steps.map((s) => s.id)).toEqual([
      'identify',
      'problem',
      'create_ticket',
      'confirm',
    ]);
    expect(plan.steps.every((s) => !s.completed && !s.skipped)).toBe(true);
    expect(plan.id).toContain('plan_');
  });

  it('matches a wildcard (*) template regardless of vertical', () => {
    expect(planFor('general_inquiry', 'restaurant').intent).toBe('general_inquiry');
  });

  it('returns null when no template matches the intent', () => {
    expect(
      new WorkflowPlanner().createPlan(makeReasoningContext({ currentIntent: 'order_pizza' })),
    ).toBeNull();
  });

  it('prefers a vertical-specific template over the wildcard', () => {
    const specific: WorkflowPlanTemplate = {
      vertical: 'hvac',
      intent: 'service_request',
      steps: [{ id: 'custom', name: 'Custom Step', description: 'd', requiredSlots: [] }],
    };
    const plan = new WorkflowPlanner([specific]).createPlan(
      makeReasoningContext({ vertical: 'hvac', currentIntent: 'service_request' }),
    );
    expect(plan?.steps.map((s) => s.id)).toEqual(['custom']);
  });
});

describe('WorkflowPlanner step transitions', () => {
  it('advances through steps, completing each, then marks the plan completed', () => {
    const plan = planFor('service_request'); // 4 steps
    expect(new WorkflowPlanner().advanceStep(plan)?.id).toBe('problem');
    expect(plan.steps[0].completed).toBe(true);
    const planner = new WorkflowPlanner();
    planner.advanceStep(plan); // -> create_ticket
    planner.advanceStep(plan); // -> confirm
    expect(planner.advanceStep(plan)).toBeNull(); // completes
    expect(plan.status).toBe('completed');
    expect(plan.completedAt).toBeInstanceOf(Date);
  });

  it('skips the current step, flagging it skipped and advancing', () => {
    const plan = planFor('service_request');
    const next = new WorkflowPlanner().skipStep(plan, 'caller already known');
    expect(plan.steps[0].skipped).toBe(true);
    expect(plan.steps[0].completed).toBe(false);
    expect(next?.id).toBe('problem');
  });

  it('returns the current step only while the plan is active', () => {
    const planner = new WorkflowPlanner();
    const plan = planFor('service_request');
    expect(planner.getCurrentStep(plan)?.id).toBe('identify');
    planner.markEscalated(plan);
    expect(planner.getCurrentStep(plan)).toBeNull();
    expect(planner.advanceStep(plan)).toBeNull();
    expect(planner.skipStep(plan)).toBeNull();
  });

  it('marks a plan escalated or abandoned with a completion timestamp', () => {
    const planner = new WorkflowPlanner();
    const escalated = planFor('service_request');
    planner.markEscalated(escalated);
    expect(escalated.status).toBe('escalated');
    expect(escalated.completedAt).toBeInstanceOf(Date);

    const abandoned = planFor('service_request');
    planner.markAbandoned(abandoned);
    expect(abandoned.status).toBe('abandoned');
  });
});

describe('WorkflowPlanner.getPlanSummary', () => {
  it('aggregates completed/skipped counts and the current step', () => {
    const planner = new WorkflowPlanner();
    const plan = planFor('service_request');
    planner.advanceStep(plan); // complete identify -> problem
    planner.skipStep(plan); // skip problem -> create_ticket
    const summary = planner.getPlanSummary(plan);
    expect(summary).toMatchObject({
      intent: 'service_request',
      status: 'active',
      totalSteps: 4,
      completedSteps: 1,
      skippedSteps: 1,
      currentStep: 'Create Service Ticket',
    });
    const steps = summary.steps as Array<{ name: string; tool: string | null }>;
    expect(steps.find((s) => s.name === 'Create Service Ticket')?.tool).toBe('createServiceTicket');
    expect(steps.find((s) => s.name === 'Identify Caller')?.tool).toBeNull();
  });
});
