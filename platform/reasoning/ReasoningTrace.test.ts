import { describe, it, expect } from 'vitest';
import { ReasoningTrace } from './ReasoningTrace';
import type { ConfidenceScore, WorkflowPlan } from './types';
import {
  makeReasoningContext,
  makeSlotManifest,
  makeSlotTrackerState,
  makeCallerContext,
} from './__fixtures__/reasoningContext';

function confidence(overall: ConfidenceScore['overall'] = 'high'): ConfidenceScore {
  return {
    overall,
    numericScore: overall === 'high' ? 0.9 : overall === 'medium' ? 0.55 : 0.2,
    factors: {
      intentCertainty: overall,
      slotCompleteness: 1,
      toolResultCertainty: 'high',
      conversationAmbiguity: 'low',
      turnsWithoutProgress: 0,
    },
    timestamp: new Date(),
  };
}

describe('ReasoningTrace.emit', () => {
  it('captures the decision, missing required slots, and defaults', () => {
    const trace = new ReasoningTrace('session-1');
    const entry = trace.emit({
      context: makeReasoningContext({
        turnCount: 2,
        currentIntent: 'service_request',
        slotTracker: makeSlotTrackerState(
          makeSlotManifest([
            { name: 'caller_name', required: true },
            { name: 'callback_number', required: true },
          ]),
          { caller_name: 'Ada' },
        ),
      }),
      confidence: confidence('high'),
      decision: 'continue_workflow',
    });
    expect(entry.turn).toBe(2);
    expect(entry.selectedIntent).toBe('service_request');
    expect(entry.missingSlots).toEqual(['callback_number']);
    expect(entry.decision).toBe('continue_workflow');
    expect(entry.safetyViolations).toEqual([]);
    expect(entry.metadata).toEqual({});
    expect(entry.timestamp).toBeInstanceOf(Date);
  });

  it('records the active workflow step name when a plan is present', () => {
    const plan: WorkflowPlan = {
      id: 'p1',
      vertical: 'hvac',
      intent: 'service_request',
      steps: [
        { id: 's1', name: 'Identify Caller', description: 'd', requiredSlots: [], completed: false, skipped: false },
        { id: 's2', name: 'Understand Problem', description: 'd', requiredSlots: [], completed: false, skipped: false },
      ],
      currentStepIndex: 1,
      startedAt: new Date(),
      status: 'active',
    };
    const entry = new ReasoningTrace('s').emit({
      context: makeReasoningContext({ workflowPlan: plan }),
      confidence: confidence(),
      decision: 'continue_workflow',
    });
    expect(entry.activeWorkflowStep).toBe('Understand Problem');
  });

  it('maps caller context into a compact returning/open-tickets summary', () => {
    const entry = new ReasoningTrace('s').emit({
      context: makeReasoningContext({
        callerContext: makeCallerContext({
          isReturningCaller: true,
          hasOpenTickets: true,
          openTicketIds: ['t1', 't2'],
        }),
      }),
      confidence: confidence(),
      decision: 'execute_tool',
      chosenTool: 'createServiceTicket',
    });
    expect(entry.callerContext).toEqual({ isReturning: true, openTickets: 2 });
    expect(entry.chosenTool).toBe('createServiceTicket');
  });
});

describe('ReasoningTrace aggregation', () => {
  function seed(): ReasoningTrace {
    const trace = new ReasoningTrace('session-1');
    trace.emit({
      context: makeReasoningContext({ turnCount: 1, currentIntent: 'service_request' }),
      confidence: confidence('high'),
      decision: 'continue_workflow',
    });
    trace.emit({
      context: makeReasoningContext({ turnCount: 2, currentIntent: 'service_request' }),
      confidence: confidence('low'),
      decision: 'execute_tool',
      chosenTool: 'createServiceTicket',
      escalationTrigger: 'emergency_keyword',
      safetyViolations: [{ type: 'unauthorized_tool', description: 'x', severity: 'critical' }],
    });
    return trace;
  }

  it('returns a defensive copy of entries and the latest entry', () => {
    const trace = seed();
    const entries = trace.getEntries();
    expect(entries).toHaveLength(2);
    entries.pop();
    expect(trace.getEntries()).toHaveLength(2);
    expect(trace.getLatestEntry()?.turn).toBe(2);
  });

  it('reports null latest entry before anything is emitted', () => {
    expect(new ReasoningTrace('s').getLatestEntry()).toBeNull();
  });

  it('summarizes turns, escalations, safety issues and tool calls', () => {
    const summary = seed().getCallSummary();
    expect(summary).toMatchObject({
      callSessionId: 'session-1',
      totalTurns: 2,
      currentIntent: 'service_request',
      currentConfidence: 'low',
      escalationCount: 1,
      safetyIssueCount: 1,
      toolCallCount: 1,
    });
    expect((summary.decisions as unknown[])).toHaveLength(2);
  });

  it('reports unknown intent/confidence for an empty summary', () => {
    const summary = new ReasoningTrace('s').getCallSummary();
    expect(summary.totalTurns).toBe(0);
    expect(summary.currentIntent).toBe('unknown');
    expect(summary.currentConfidence).toBe('unknown');
  });

  it('serializes entries with ISO timestamps and nested confidence', () => {
    const out = seed().toSerializable();
    expect(out).toHaveLength(2);
    expect(typeof out[0].timestamp).toBe('string');
    expect(() => new Date(out[0].timestamp as string).toISOString()).not.toThrow();
    expect((out[1].confidence as { overall: string }).overall).toBe('low');
  });
});
