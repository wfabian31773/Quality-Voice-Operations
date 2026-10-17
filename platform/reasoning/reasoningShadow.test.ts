import { describe, expect, it, vi } from 'vitest';
import { ReasoningEngine } from './ReasoningEngine';
import { ReasoningCallGate, describeTurnEffects, type ReasoningShadowLine } from './reasoningShadow';
import { SALON_TOOLS } from '../agent-templates/salon/rolePackage';
import type { DecisionResult } from './types';

const CALLER = '+15555550100';
const TOOLS = SALON_TOOLS.map((tool) => tool.name);

function makeGate(mode: 'enforce' | 'shadow', vertical = 'salon') {
  const engine = new ReasoningEngine({
    tenantId: 'demo',
    callSessionId: 'cs-shadow',
    callSid: 'CA-shadow',
    agentSlug: 'sharp-line-front-desk',
    vertical,
    callerNumber: CALLER,
    toolsAvailable: TOOLS,
    memoryStorage: null,
    humanTransferAvailable: false,
  });
  const lines: ReasoningShadowLine[] = [];
  const gate = new ReasoningCallGate({ engine, mode, callId: 'cs-shadow', toolsAvailable: TOOLS, log: (line) => lines.push(line) });
  return { engine, gate, lines };
}

/** The Oct 17 call's caller turns (the spoken digits are left out). */
const OCT17_TURNS = [
  'Hi, this is Wayne.',
  "I'm looking for a fade.",
  'I need a haircut.',
  'Um, Saturday mornings.',
  "Yeah, if nine is available, I'll take it.",
  'Yes, that does.',
  "You can use the one I'm calling from.",
  'Yes.',
  'You said that. Yes.',
];

/** Push the engine into the Oct 17 state where the decision is execute_tool create_ticket. */
function driveToTicketDecision(gate: ReasoningCallGate, engine: ReasoningEngine): DecisionResult {
  gate.processTurn('Hi, this is Wayne.');
  gate.processTurn("I'm looking for a fade.");
  let decision = gate.processTurn('Um, Saturday mornings.').result;
  for (let i = 0; i < 6 && !(decision.action === 'execute_tool' && decision.toolToExecute === 'create_ticket'); i++) {
    engine.handleToolFailure();
    decision = gate.processTurn('hmm').result;
  }
  return decision;
}

const SHADOW_KEYS = [
  'callId', 'confidence', 'decision', 'escalation_trigger', 'event', 'inject_template', 'intent', 'intent_confidence',
  'kind', 'mode', 'turn', 'would_block_tool', 'would_escalate', 'would_inject', 'would_reset_state',
].sort();

function assertNoPii(lines: ReasoningShadowLine[]) {
  const blob = JSON.stringify(lines);
  expect(blob).not.toMatch(/wayne/i);
  expect(blob).not.toMatch(/fade|haircut|saturday|calling from/i);
  expect(blob).not.toMatch(/\d{4,}/); // no phone digits
  for (const turn of OCT17_TURNS) expect(blob).not.toContain(turn);
}

describe('ReasoningCallGate: shadow', () => {
  it('processes every Oct 17 turn and logs one PII-free reasoning_shadow line per turn', () => {
    const { gate, lines } = makeGate('shadow');
    OCT17_TURNS.forEach((turn) => gate.processTurn(turn));

    expect(lines).toHaveLength(OCT17_TURNS.length);
    lines.forEach((line, index) => {
      expect(Object.keys(line).sort()).toEqual(SHADOW_KEYS);
      expect(line).toMatchObject({ event: 'reasoning_shadow', mode: 'shadow', kind: 'turn', callId: 'cs-shadow', turn: index + 1 });
      expect(typeof line.would_inject).toBe('boolean');
      expect(typeof line.would_reset_state).toBe('boolean');
      expect(typeof line.would_escalate).toBe('boolean');
      if (line.would_inject) expect(line.inject_template).toMatch(/^[a-z_+]+$/);
      else expect(line.inject_template).toBeNull();
    });
    // The engine still decides what it would have injected: "Which service…?" on the fade turn.
    expect(lines[1]).toMatchObject({ intent: 'book_appointment', would_inject: true });
    expect(lines[1].inject_template).toContain('slot_clarification');
    assertNoPii(lines);
  });

  it('logs a would-be block but lets the tool run; only the allowlist blocks', () => {
    const { gate, engine, lines } = makeGate('shadow');
    expect(driveToTicketDecision(gate, engine)).toMatchObject({ action: 'execute_tool', toolToExecute: 'create_ticket' });
    lines.length = 0;

    // escalate_to_human conflicts with the create_ticket decision (its data checks pass).
    const escalate = gate.authorizeTool('escalate_to_human', { reason: 'Saturday mornings' });
    expect(escalate.allowed).toBe(true);
    expect(escalate.engine?.allowed).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'tool', would_block_tool: { tool: 'escalate_to_human', reason: 'decision_conflict' }, would_inject: false });

    // A data / provenance block is logged with its own code, and still not enforced.
    const sms = gate.authorizeTool('send_sms', { templateKey: 'confirmation', toNumber: CALLER });
    expect(sms.allowed).toBe(true);
    expect(lines[1].would_block_tool).toEqual({ tool: 'send_sms', reason: 'missing_required_data' });

    const unknown = gate.authorizeTool('delete_everything', {});
    expect(unknown.allowed).toBe(false);
    expect(unknown.violations[0]).toMatchObject({ type: 'unauthorized_tool', severity: 'critical' });
    assertNoPii(lines);
  });

  it('an engine error never blocks in shadow (logged as engine_error)', () => {
    const { gate, engine, lines } = makeGate('shadow');
    engine.authorizeToolRequest = () => { throw new Error('boom'); };
    expect(gate.authorizeTool('lookup_customer', {}).allowed).toBe(true);
    expect(lines[0].would_block_tool).toEqual({ tool: 'lookup_customer', reason: 'engine_error' });
  });

  it('never returns a silence prompt or a response cancel', () => {
    vi.useFakeTimers();
    const { gate, lines } = makeGate('shadow', 'medical-after-hours');
    vi.setSystemTime(Date.now() + 11_000);
    expect(gate.handleSilence()).toBeNull();
    vi.useRealTimers();
    expect(gate.checkResponse('Based on that, you have an infection; stop taking the pills.').allowed).toBe(true);
    expect(lines.map((line) => line.inject_template)).toEqual(['silence_recovery', 'response_safety_override']);
    expect(JSON.stringify(lines)).not.toMatch(/infection|pills/);
  });

  it('flags a topic switch as would_reset_state', () => {
    const { gate, lines } = makeGate('shadow');
    gate.processTurn("Hi, I'd like to book a haircut on Saturday.");
    gate.processTurn('Actually I need to cancel my appointment instead.');
    expect(lines[1].would_reset_state).toBe(true);
  });
});

describe('ReasoningCallGate: enforce (non-salon and salon opt-in keep today\'s behavior)', () => {
  it('returns the injections openaiSession sends and logs nothing', () => {
    const { gate, lines } = makeGate('enforce');
    gate.processTurn('Hi, this is Wayne.');
    const fade = gate.processTurn("I'm looking for a fade.");
    expect(fade.effects.injectTemplates).toContain('slot_clarification');
    expect(fade.result.clarifyingQuestion ?? '').toMatch(/which service/i);
    expect(lines).toEqual([]);
  });

  it('blocks a tool that conflicts with the decision, exactly as the engine does', () => {
    const { gate, engine, lines } = makeGate('enforce');
    driveToTicketDecision(gate, engine);
    const escalate = gate.authorizeTool('escalate_to_human', { reason: 'Saturday mornings' });
    expect(escalate.allowed).toBe(false);
    expect(escalate.violations[0].description).toMatch(/conflicts with the active reasoning decision/);
    expect(gate.authorizeTool('lookup_customer', {}).allowed).toBe(true);
    expect(lines).toEqual([]);
  });

  it('a non-salon vertical still gets the silence prompt and the response-safety cancel', () => {
    vi.useFakeTimers();
    const { gate } = makeGate('enforce', 'medical-after-hours');
    vi.setSystemTime(Date.now() + 11_000);
    expect(gate.handleSilence()).toEqual(expect.any(String));
    vi.useRealTimers();
    expect(gate.checkResponse('Based on that, you have an infection; stop taking the pills.').allowed).toBe(false);
  });
});

describe('describeTurnEffects', () => {
  const base = { confidence: { numericScore: 0.5 }, reasoning: '', traceEntry: {} } as unknown as DecisionResult;
  it('maps each enforce-mode effect branch to a template id', () => {
    expect(describeTurnEffects({ ...base, action: 'escalate_to_human' }, false)).toMatchObject({ injectTemplates: ['escalation_route'], wouldEscalate: true });
    expect(describeTurnEffects({
      ...base,
      action: 'execute_tool',
      fallbackStep: 'create_ticket',
      escalation: { trigger: 'repeated_confusion', output: 'take_message' } as never,
    }, false)).toMatchObject({ injectTemplates: ['message_fallback'], wouldEscalate: true, escalationTrigger: 'repeated_confusion' });
    expect(describeTurnEffects({ ...base, action: 'ask_clarifying_question', clarifyingQuestion: 'x' }, true).injectTemplates)
      .toEqual(['slot_clarification', 'partial_answer_recovery']);
    expect(describeTurnEffects({ ...base, action: 'continue_workflow', reasoning: 'step' }, false).injectTemplates).toEqual(['workflow_guidance']);
    expect(describeTurnEffects({ ...base, action: 'complete_interaction' }, false)).toMatchObject({ injectTemplates: [], wouldEscalate: false });
  });
});
