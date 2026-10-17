/**
 * Replay of the Oct 17 2026 Sharp Line Barbers test call
 * (/workspace/qvo-gtm/test-calls/2026-10-17-call1.md) through the live
 * reasoning path: salon pack + legacy library tools, the same
 * classifyIntent → processUtterance → bind → authorize sequence that
 * openaiSession runs. The caller number is a fake 555 number; the
 * caller's spoken digits from the real call are left out on purpose.
 */
import { describe, expect, it } from 'vitest';
import { ReasoningEngine } from './ReasoningEngine';
import { bindSessionToolArgs } from './sessionBinding';
import { SALON_TOOLS } from '../agent-templates/salon/rolePackage';
import type { DecisionResult } from './types';

const CALLER = '+15555550100';

function makeEngine(): ReasoningEngine {
  return new ReasoningEngine({
    tenantId: 'demo',
    callSessionId: 'cs-replay',
    callSid: 'CA-replay',
    agentSlug: 'sharp-line-front-desk',
    vertical: 'salon',
    callerNumber: CALLER,
    toolsAvailable: SALON_TOOLS.map((tool) => tool.name),
    memoryStorage: null,
    humanTransferAvailable: false,
  });
}

function say(engine: ReasoningEngine, utterance: string): DecisionResult {
  const { intent, confidence } = engine.classifyIntent(utterance);
  return engine.processUtterance(utterance, intent, confidence);
}

/** What openaiSession does before running a tool: bind to the session, record slots, authorize. */
function requestTool(engine: ReasoningEngine, name: string, rawArgs: Record<string, unknown>) {
  const bound = bindSessionToolArgs(rawArgs, {
    tenantId: 'demo',
    agentId: 'sharp-line-front-desk',
    callerNumber: CALLER,
    transcript: engine.getTranscript().join(' '),
  });
  expect(bound.ok, bound.reason).toBe(true);
  for (const [key, value] of Object.entries(bound.args)) {
    if (typeof value === 'string' && value.length > 0) engine.fillSlot(key, value, 'tool_args');
  }
  return { args: bound.args, authorization: engine.authorizeToolRequest(name, bound.args) };
}

function slots(engine: ReasoningEngine): Record<string, { value: string | null }> {
  return (engine.getCallSummary().slots as { slots: Record<string, { value: string | null }> }).slots;
}

const BOOKING_ARGS = {
  title: 'Fade',
  startTime: '2026-10-24T09:00:00-04:00',
  durationMinutes: 45,
  contactName: 'Wayne',
};

describe('Oct 17 live call replay (salon pack, legacy library tools)', () => {
  it('(a) "I\'m looking for a fade" fills the service instead of asking "Which service…?"', () => {
    const engine = makeEngine();
    say(engine, 'Hi, this is Wayne.');
    expect(slots(engine).contactName?.value).toBe('Wayne');

    const decision = say(engine, "I'm looking for a fade.");
    expect(engine.getCallSummary()).toMatchObject({ slots: { intent: 'book_appointment' } });
    expect(slots(engine).title?.value).toBe('fade');
    // "looking" is not a name, so the name from turn 1 stays.
    expect(slots(engine).contactName?.value).toBe('Wayne');
    expect(decision.clarifyingQuestion ?? '').not.toMatch(/which service/i);
  });

  it('(c) "If nine is available, I\'ll take it" is no topic switch, no Identify Caller, no repeated_confusion', () => {
    const engine = makeEngine();
    const decisions: DecisionResult[] = [];
    decisions.push(say(engine, 'Hi, this is Wayne.'));
    decisions.push(say(engine, "I'm looking for a fade."));
    decisions.push(say(engine, 'I need a haircut.'));
    decisions.push(say(engine, 'Um, Saturday mornings.'));
    const planBefore = engine.getWorkflowPlan();

    decisions.push(say(engine, "Yeah, if nine is available, I'll take it."));
    expect(engine.classifyIntent("Yeah, if nine is available, I'll take it.").intent).toBe('book_appointment');
    expect(engine.getWorkflowPlan()).toBe(planBefore);
    expect(engine.getWorkflowPlan()?.intent).toBe('book_appointment');
    expect(engine.handlePartialAnswer('').topicSwitchCount).toBe(0);
    // Slots survived (no reset): service and name are still there.
    expect(slots(engine).title?.value).toBe('fade');
    expect(slots(engine).contactName?.value).toBe('Wayne');

    const time = requestTool(engine, 'get_current_tenant_time', {});
    expect(time.authorization.allowed).toBe(true);
    engine.handleToolSuccess('get_current_tenant_time');
    decisions.push(say(engine, 'Yes, that does.'));
    decisions.push(say(engine, "You can use the one I'm calling from."));
    decisions.push(say(engine, 'Yes.'));
    decisions.push(say(engine, 'You said that. Yes.'));

    for (const decision of decisions) {
      expect(decision.escalation?.trigger).not.toBe('repeated_confusion');
      expect(decision.action).not.toBe('escalate_to_human');
      expect(decision.clarifyingQuestion ?? '').not.toMatch(/identify caller/i);
      expect(decision.reasoning).not.toMatch(/identify caller/i);
    }
    expect(engine.getWorkflowPlan()?.steps.map((s) => s.name)).not.toContain('Identify Caller');
    expect(engine.getCallSummary().escalationAttempts).toBe(0);
  });

  it('(b) "use the one I\'m calling from": lookup_customer is not blocked and create_booking takes the caller ID', () => {
    const engine = makeEngine();
    say(engine, 'Hi, this is Wayne.');
    say(engine, "I'm looking for a fade.");
    say(engine, 'Um, Saturday mornings.');
    say(engine, "Yeah, if nine is available, I'll take it.");
    say(engine, 'Yes, that does.');
    const afterCallerId = say(engine, "You can use the one I'm calling from.");
    // The engine counts the caller ID as the callback number (as a token,
    // never the digits) and does not ask for the number again.
    expect(slots(engine).contactPhone?.value).toBe('caller_id');
    expect(afterCallerId.clarifyingQuestion ?? '').not.toMatch(/number/i);

    const lookup = requestTool(engine, 'lookup_customer', { phoneNumber: '' });
    expect(lookup.authorization.allowed).toBe(true);
    engine.handleToolSuccess('lookup_customer');

    // The model leaves contactPhone empty (or passes a caller-ID phrase, as on
    // Oct 16); the server fills the caller ID. No second ask for the number.
    for (const contactPhone of ['', 'calling number', 'caller_id']) {
      const booking = requestTool(engine, 'create_booking', { ...BOOKING_ARGS, contactPhone });
      expect(booking.args.contactPhone).toBe(CALLER);
      expect(booking.authorization.allowed).toBe(true);
    }
  });

  it('(b) a create_ticket decision never blocks read-only tools', () => {
    const engine = makeEngine();
    say(engine, 'Hi, this is Wayne.');
    say(engine, "I'm looking for a fade.");
    // Push the engine into the Oct 17 state: tool failures until the
    // escalation decision is "execute_tool create_ticket".
    let decision = say(engine, 'Um, Saturday mornings.');
    for (let i = 0; i < 6 && !(decision.action === 'execute_tool' && decision.toolToExecute === 'create_ticket'); i++) {
      engine.handleToolFailure();
      decision = say(engine, 'hmm');
    }
    expect(decision).toMatchObject({ action: 'execute_tool', toolToExecute: 'create_ticket' });

    for (const tool of ['lookup_customer', 'get_current_tenant_time', 'retrieve_knowledge', 'record_language_change']) {
      const args = tool === 'retrieve_knowledge' ? { query: 'fade price' } : tool === 'record_language_change' ? { language: 'es' } : {};
      expect(requestTool(engine, tool, args).authorization.allowed, tool).toBe(true);
    }
    expect(requestTool(engine, 'record_call_outcome', { outcome: 'booking_request_followup' }).authorization.allowed).toBe(true);
    // A write tool other than the ticket is still held back by the decision.
    expect(requestTool(engine, 'send_sms', { templateKey: 'confirmation', toNumber: '' }).authorization.allowed).toBe(false);
  });

  it('(d) one readback, then create_booking is authorized and completes the booking plan', () => {
    const engine = makeEngine();
    say(engine, 'Hi, this is Wayne.');
    say(engine, "I'm looking for a fade.");
    say(engine, 'Um, Saturday mornings.');
    say(engine, "Yeah, if nine is available, I'll take it.");
    say(engine, 'Yes, that does.');
    say(engine, "You can use the one I'm calling from.");
    say(engine, 'Yes.');

    const booking = requestTool(engine, 'create_booking', { ...BOOKING_ARGS, contactPhone: '' });
    expect(booking.authorization).toMatchObject({ allowed: true });
    expect(engine.getCurrentWorkflowStepTool()).toBe('create_booking');
    engine.handleToolSuccess('create_booking');
    expect(engine.getWorkflowPlan()?.status).toBe('completed');

    const outcome = requestTool(engine, 'record_call_outcome', { outcome: 'booking_request_pending' });
    expect(outcome.authorization.allowed).toBe(true);
  });

  it('(e) after a tool failure the engine offers a message; it never announces a ticket or a callback time', () => {
    const engine = makeEngine();
    say(engine, 'Hi, this is Wayne.');
    say(engine, "I'm looking for a fade.");
    say(engine, 'Um, Saturday mornings.');
    say(engine, 'Yes.');
    const spoken: string[] = [];
    for (let i = 0; i < 6; i++) {
      engine.handleToolFailure();
      const decision = say(engine, i === 5 ? "No, that's fine." : 'You said that. Yes.');
      if (decision.clarifyingQuestion) spoken.push(decision.clarifyingQuestion);
    }
    for (const line of spoken) {
      expect(line).not.toMatch(/I'll (go ahead and )?create a ticket/i);
      expect(line).not.toMatch(/within the hour|as soon as possible/i);
    }
  });
});

describe('name and service detection on the call\'s phrasing', () => {
  function firstTurnSlots(utterance: string) {
    const engine = makeEngine();
    say(engine, utterance);
    return slots(engine);
  }

  it.each([
    ["I'm looking for a fade.", 'fade'],
    ['Looking for a skin fade', 'skin fade'],
    ['Can I get a beard trim?', 'beard trim'],
    ['Could I get a lineup', 'lineup'],
    ['I want to get a taper', 'taper'],
    ["I'd like to get a haircut", 'haircut'],
    ['I need to get a kids cut', 'kids cut'],
    ["I'm trying to get a shape-up", 'shape-up'],
    ['Gimme a buzz cut', 'buzz cut'],
    ['Give me a fade', 'fade'],
    ['Book me for a haircut', 'haircut'],
    ['Book me a fade', 'fade'],
    ['Do you do a fade?', 'fade'],
    ['I need a haircut.', 'haircut'],
    ['Quiero un corte', 'corte'],
    ['Necesito un degradado', 'degradado'],
    ['Busco un arreglo de barba', 'arreglo de barba'],
    ['Me gustaría un corte de pelo', 'corte de pelo'],
    ['Quisiera una cita para un corte', 'cita para un corte'],
    ['¿Me puede hacer un desvanecido?', 'desvanecido'],
  ])('fills the service from %j', (utterance, expected) => {
    expect(firstTurnSlots(utterance).title?.value).toBe(expected);
  });

  it.each([
    "I'm looking for a fade.",
    "You can use the one I'm calling from.",
    "I'm just wondering about prices",
    "I'm Looking for a fade",
    "I'm good, thanks",
  ])('does not take %j as a name', (utterance) => {
    expect(firstTurnSlots(utterance).contactName?.value ?? null).toBeNull();
  });

  it.each([
    ["Hi, this is Wayne.", 'Wayne'],
    ["I'm Wayne", 'Wayne'],
    ['this is Maria José', 'Maria José'],
    ['My name is Ada Lovelace', 'Ada Lovelace'],
  ])('keeps the real name in %j', (utterance, expected) => {
    expect(firstTurnSlots(utterance).contactName?.value).toBe(expected);
  });
});
