import { describe, it, expect, vi } from 'vitest';
import { ReasoningEngine, type ReasoningEngineConfig } from './ReasoningEngine';
import type { MemoryStorage } from './MemoryManager';
import type { CallerMemory } from '../infra/memory/types';

function makeEngine(overrides: Partial<ReasoningEngineConfig> = {}): ReasoningEngine {
  return new ReasoningEngine({
    tenantId: 'tenant-1',
    callSessionId: 'session-1',
    callSid: 'CA1',
    agentSlug: 'agent-1',
    vertical: 'hvac',
    callerNumber: '+15551234567',
    toolsAvailable: ['createServiceTicket'],
    memoryStorage: null,
    ...overrides,
  });
}

function slotsOf(engine: ReasoningEngine): Record<string, { value: string | null }> {
  return (engine.getCallSummary().slots as { slots: Record<string, { value: string | null }> }).slots;
}

describe('ReasoningEngine.classifyIntent', () => {
  it.each([
    ['I would like to schedule an appointment', 'schedule_appointment', 'high'],
    ['I have a question about my bill and a charge', 'billing_inquiry', 'high'],
    ['I want to talk to a person, a real human', 'transfer_human', 'high'],
    ['my furnace is broken and leaking', 'service_request', 'high'],
    ['I have a general question about your hours', 'general_inquiry', 'medium'],
  ])('classifies %j as %s/%s', (utterance, intent, confidence) => {
    expect(makeEngine().classifyIntent(utterance)).toEqual({ intent, confidence });
  });

  it('falls back to unknown/low when nothing matches', () => {
    expect(makeEngine().classifyIntent('zxcvbnm qwerty')).toEqual({ intent: 'unknown', confidence: 'low' });
  });
});

describe('ReasoningEngine.getSafetyPolicyPrompt', () => {
  it('adds medical prohibitions for medical-after-hours and dental', () => {
    for (const vertical of ['medical-after-hours', 'dental']) {
      expect(makeEngine({ vertical }).getSafetyPolicyPrompt()).toContain('diagnose');
    }
  });

  it('adds legal prohibitions for the legal vertical', () => {
    expect(makeEngine({ vertical: 'legal' }).getSafetyPolicyPrompt()).toContain('legal advice');
  });

  it('adds financial prohibitions for the insurance vertical', () => {
    expect(makeEngine({ vertical: 'insurance' }).getSafetyPolicyPrompt()).toContain('financial advice');
  });

  it('always includes the base safety policy framing', () => {
    const prompt = makeEngine({ vertical: 'hvac' }).getSafetyPolicyPrompt();
    expect(prompt).toContain('SAFETY POLICY');
    expect(prompt).toContain('qualified professional');
  });
});

describe('ReasoningEngine.initialize', () => {
  it('returns an empty caller context when there is no memory storage', async () => {
    const ctx = await makeEngine().initialize();
    expect(ctx.isReturningCaller).toBe(false);
    expect(makeEngine().getCallerContextPrompt()).toBe('');
  });

  it('builds a returning-caller context from storage', async () => {
    const memory: CallerMemory = {
      tenantId: 'tenant-1',
      phoneNumber: '+15551234567',
      totalCalls: 3,
      recentCalls: [{ date: '2026-05-01', reason: 'no heat', outcome: 'resolved' }],
      openTickets: ['T-1'],
      notes: '',
    };
    const storage: MemoryStorage = { getCallerMemory: vi.fn().mockResolvedValue(memory) };
    const engine = makeEngine({ memoryStorage: storage });
    const ctx = await engine.initialize();
    expect(ctx.isReturningCaller).toBe(true);
    expect(engine.getCallerContext().openTicketIds).toEqual(['T-1']);
    expect(engine.getCallerContextPrompt()).toContain('CALLER HISTORY');
  });
});

describe('ReasoningEngine.processUtterance', () => {
  it('advances the turn, records the transcript, and returns a decision', () => {
    const engine = makeEngine();
    const result = engine.processUtterance('my furnace is broken', 'service_request', 'high');
    expect(result.action).toBeTruthy();
    expect(engine.getCallSummary().totalTurns).toBe(1);
    expect(engine.getWorkflowPlan()).not.toBeNull();
  });

  it('extracts a caller name and a phone number from natural language', () => {
    const engine = makeEngine();
    engine.processUtterance(
      'my name is Ada, you can reach me at 555-123-4567',
      'service_request',
      'high',
    );
    const slots = slotsOf(engine);
    expect(slots.caller_name?.value).toBe('Ada');
    expect(slots.callback_number?.value).toBe('555-123-4567');
  });

  it('extracts date and time slots for an appointment intent', () => {
    const engine = makeEngine({ vertical: 'generic' });
    engine.processUtterance('I would like to schedule for monday at 2pm', 'schedule_appointment', 'high');
    const slots = slotsOf(engine);
    expect(slots.preferred_date?.value?.toLowerCase()).toBe('monday');
    expect(slots.preferred_time?.value?.toLowerCase()).toContain('2pm');
  });

  it('detects a topic switch and preserves the prior intent slots', () => {
    const engine = makeEngine();
    engine.processUtterance('my name is Ada Lovelace, furnace broken', 'service_request', 'high');
    const result = engine.processUtterance('actually I have a billing question', 'billing_inquiry', 'high');
    expect(result.action).toBeTruthy();
    // The recovery state should reflect at least one topic switch.
    const recovery = engine.handlePartialAnswer('');
    expect(recovery.topicSwitchCount).toBeGreaterThanOrEqual(1);
  });

  it('counts escalations triggered by an emergency utterance', () => {
    const engine = makeEngine();
    const result = engine.processUtterance('there is a gas leak right now', 'service_request', 'high');
    expect(result.action).toBe('escalate_to_human');
    expect(engine.getCallSummary().escalationAttempts).toBe(1);
  });
});

describe('ReasoningEngine slot sourcing & safety', () => {
  it('tracks whether a slot was caller-provided vs filled from tool args', () => {
    const engine = makeEngine();
    expect(engine.fillSlot('caller_name', 'Ada', 'caller')).toBe(true);
    expect(engine.isSlotCallerProvided('caller_name')).toBe(true);

    engine.fillSlot('callback_number', '5551234567', 'tool_args');
    expect(engine.isSlotCallerProvided('callback_number')).toBe(false);
    expect(engine.getToolArgSlots().has('callback_number')).toBe(true);
  });

  it('blocks an unauthorized tool through checkToolSafety', () => {
    const engine = makeEngine({ toolsAvailable: [] });
    const result = engine.checkToolSafety('createServiceTicket', {});
    expect(result.allowed).toBe(false);
  });

  it('blocks prohibited advice through checkResponseSafety', () => {
    const engine = makeEngine({ vertical: 'legal' });
    expect(engine.checkResponseSafety('you should sue them').allowed).toBe(false);
    expect(engine.checkResponseSafety('let me take a message for the attorney').allowed).toBe(true);
  });
});

describe('ReasoningEngine lifecycle helpers', () => {
  it('advances the workflow when the active tool step succeeds', () => {
    // A non-pack vertical uses the wildcard service_request template, which has
    // a create_ticket step bound to the createServiceTicket tool.
    const engine = makeEngine({ vertical: 'generic' });
    engine.processUtterance('my furnace is broken', 'service_request', 'high');
    const plan = engine.getWorkflowPlan();
    expect(plan).not.toBeNull();
    const toolIdx = plan!.steps.findIndex((s) => s.toolToExecute === 'createServiceTicket');
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    plan!.currentStepIndex = toolIdx;
    engine.handleToolSuccess('createServiceTicket');
    expect(engine.getWorkflowPlan()?.currentStepIndex).toBe(toolIdx + 1);
  });

  it('records tool failures and surfaces silence/partial-answer recovery', () => {
    const engine = makeEngine();
    engine.handleToolFailure();
    expect(engine.handleSilence()).toHaveProperty('toolFailureCount', 1);
    expect(engine.handlePartialAnswer('uh')).toHaveProperty('partialAnswerBuffer');
  });

  it('reports the current workflow step tool', () => {
    const engine = makeEngine();
    expect(engine.getCurrentWorkflowStepTool()).toBeNull(); // no plan yet
    engine.processUtterance('my furnace is broken', 'service_request', 'high');
    // After processing, the step tool is either a string or null depending on
    // auto-advance — but the accessor must not throw and returns the right type.
    const tool = engine.getCurrentWorkflowStepTool();
    expect(tool === null || typeof tool === 'string').toBe(true);
  });

  it('re-evaluates the latest decision and exposes trace entries', () => {
    const engine = makeEngine();
    engine.processUtterance('my furnace is broken', 'service_request', 'high');
    expect(engine.reEvaluateDecision().action).toBeTruthy();
    expect(engine.getLatestDecision()).not.toBeNull();
    expect(engine.getTraceEntries().length).toBeGreaterThan(0);
  });

  it('rebinds the session id and keeps processing', () => {
    const engine = makeEngine();
    engine.setCallSessionId('session-2');
    expect(engine.processUtterance('my furnace is broken', 'service_request', 'high').action).toBeTruthy();
  });

  it('advanceWorkflowStep is a no-op safe call before and after a plan exists', () => {
    const engine = makeEngine();
    expect(() => engine.advanceWorkflowStep()).not.toThrow();
    engine.processUtterance('my furnace is broken', 'service_request', 'high');
    expect(() => engine.advanceWorkflowStep()).not.toThrow();
  });
});
