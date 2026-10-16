import { describe, expect, it } from 'vitest';
import { ReasoningEngine } from './ReasoningEngine';
import type { ReasoningEngineConfig } from './ReasoningEngine';

const SALON_TOOLS = [
  'create_booking',
  'update_booking',
  'create_ticket',
  'send_sms',
  'escalate_to_human',
  'get_current_tenant_time',
  'retrieve_knowledge',
];

function makeSalonEngine(overrides: Partial<ReasoningEngineConfig> = {}): ReasoningEngine {
  return new ReasoningEngine({
    tenantId: 'demo',
    callSessionId: 'salon-session',
    callSid: 'CA-salon',
    agentSlug: '3784a2d1-def3-4ace-9747-656275b638ca',
    vertical: 'salon',
    callerNumber: '+15555550199',
    toolsAvailable: SALON_TOOLS,
    humanTransferAvailable: false,
    memoryStorage: null,
    ...overrides,
  });
}

describe('salon booking conversation', () => {
  it('classifies a booking, fills library slots, and lets create_booking through the safety gate', () => {
    const engine = makeSalonEngine();
    const classified = engine.classifyIntent(
      'Hi, I want to book a haircut tomorrow at 2pm. My name is Jordan Lee, you can reach me at 555-201-3344.',
    );
    expect(classified.intent).toBe('book_appointment');

    const decision = engine.processUtterance(
      'Hi, I want to book a haircut tomorrow at 2pm. My name is Jordan Lee, you can reach me at 555-201-3344.',
      classified.intent,
      classified.confidence,
    );
    expect(decision.action).not.toBe('escalate_to_human');

    const slots = (engine.getCallSummary().slots as { slots: Record<string, { value: string | null }> }).slots;
    expect(slots.contactName?.value).toBe('Jordan Lee');
    expect(slots.contactPhone?.value).toBe('555-201-3344');
    expect(slots.startTime?.value?.toLowerCase()).toContain('2pm');

    engine.fillSlot('title', 'Haircut', 'tool_args');
    engine.fillSlot('startTime', '2026-10-17T14:00:00-07:00', 'tool_args');
    engine.fillSlot('contactName', 'Jordan Lee', 'tool_args');
    engine.fillSlot('contactPhone', '555-201-3344', 'tool_args');

    const bookingArgs = {
      title: 'Haircut',
      startTime: '2026-10-17T14:00:00-07:00',
      contactName: 'Jordan Lee',
      contactPhone: '555-201-3344',
      notes: 'Fade, not too short',
    };
    const safety = engine.checkToolSafety('create_booking', bookingArgs);
    expect(safety.allowed).toBe(true);
    expect(safety.violations).toEqual([]);

    const authorized = engine.authorizeToolRequest('create_booking', bookingArgs);
    expect(authorized.allowed).toBe(true);
  });

  it('lets create_ticket through the gate when the caller leaves a message', () => {
    const engine = makeSalonEngine();
    const classified = engine.classifyIntent('Please leave a message for the owner, this is Sam, 555-888-1212');
    expect(classified.intent).toBe('leave_message');

    engine.processUtterance(
      'Please leave a message for the owner that I need to move Thursday. This is Sam, 555-888-1212.',
      classified.intent,
      classified.confidence,
    );

    const ticketArgs = {
      subject: 'Move Thursday appointment',
      description: 'Caller wants to move Thursday appointment',
      contactName: 'Sam',
      contactPhone: '555-888-1212',
      category: 'booking',
      priority: 'medium',
    };
    expect(engine.checkToolSafety('create_ticket', ticketArgs).allowed).toBe(true);
    expect(engine.authorizeToolRequest('create_ticket', ticketArgs).allowed).toBe(true);
  });

  it('falls back to create_ticket once when escalation has no on-call number', () => {
    const engine = makeSalonEngine({ humanTransferAvailable: false });

    const unclear = 'um I am not sure';
    const first = engine.processUtterance(unclear, 'unknown', 'low');
    const second = engine.processUtterance(unclear, 'unknown', 'low');
    const third = engine.processUtterance(unclear, 'unknown', 'low');

    expect([first.action, second.action]).not.toContain('escalate_to_human');
    expect(third.action).toBe('execute_tool');
    expect(third.toolToExecute).toBe('create_ticket');
    expect(third.fallbackStep).toBe('create_ticket');
    expect(third.escalation?.output).toBe('take_message');

    const fourth = engine.processUtterance(unclear, 'unknown', 'low');
    expect(fourth.action).not.toBe('escalate_to_human');
    expect(fourth.escalation).toBeUndefined();

    engine.processUtterance(
      'This is Guest. Please tell the shop I could not complete the request.',
      'leave_message',
      'high',
    );
    const ticketArgs = {
      subject: 'Could not complete the request',
      description: 'Please tell the shop I could not complete the request',
      contactName: 'Guest',
      contactPhone: '+15555550199',
    };
    expect(engine.authorizeToolRequest('create_ticket', ticketArgs).allowed).toBe(true);
  });

  it('does not use leftover healthcare slot names to block a valid booking', () => {
    const engine = makeSalonEngine();
    engine.processUtterance(
      'Book me a fade Friday at 3pm, I am Chris, 555-444-0909',
      'book_appointment',
      'high',
    );
    const safety = engine.checkToolSafety('create_booking', {
      title: 'Fade',
      startTime: '2026-10-17T15:00:00-07:00',
      contactName: 'Chris',
      contactPhone: '555-444-0909',
    });
    expect(safety.allowed).toBe(true);
    expect(safety.violations.map((v) => v.description).join(' ')).not.toContain('reason_for_call');
  });

  it('rejects tool args that try to override the session tenant or caller', () => {
    const engine = makeSalonEngine();
    engine.processUtterance(
      'Book me a fade Friday at 3pm, I am Chris',
      'book_appointment',
      'high',
    );

    const tenantOverride = engine.checkToolSafety('create_booking', {
      title: 'Fade',
      startTime: '2026-10-17T15:00:00-07:00',
      contactName: 'Chris',
      contactPhone: '+15555550199',
      tenantId: 'other-tenant',
    });
    expect(tenantOverride.allowed).toBe(false);
    expect(tenantOverride.violations.map((v) => v.type)).toContain('policy_violation');
    expect(tenantOverride.violations.map((v) => v.description).join(' ')).toMatch(/tenant/);

    const phoneOverride = engine.checkToolSafety('create_booking', {
      title: 'Fade',
      startTime: '2026-10-17T15:00:00-07:00',
      contactName: 'Chris',
      contactPhone: '+15559990000',
    });
    expect(phoneOverride.allowed).toBe(false);
    expect(phoneOverride.violations.map((v) => v.description).join(' ')).toMatch(/not spoken/);
  });

  it('classifies cancel-my-haircut as reschedule_cancel, not a new booking', () => {
    const engine = makeSalonEngine();
    expect(engine.classifyIntent('Cancel my haircut appointment').intent).toBe('reschedule_cancel');
    expect(engine.classifyIntent('Quiero cancelar mi cita').intent).toBe('reschedule_cancel');
    expect(engine.classifyIntent('Puedo cambiar la cita').intent).toBe('reschedule_cancel');
    expect(engine.classifyIntent('Necesito mover la cita').intent).toBe('reschedule_cancel');
  });

  it('does not classify policy questions or cancel-negations as reschedule_cancel', () => {
    const engine = makeSalonEngine();
    expect(engine.classifyIntent('what is your cancellation policy?').intent).not.toBe('reschedule_cancel');
    expect(engine.classifyIntent('do not cancel my appointment').intent).not.toBe('reschedule_cancel');
    expect(engine.classifyIntent('no cancele mi cita').intent).not.toBe('reschedule_cancel');
    expect(engine.classifyIntent('cancel my haircut appointment').intent).toBe('reschedule_cancel');
  });

  it('asks for a new time before calling update_booking on a reschedule', () => {
    const engine = makeSalonEngine();
    const decision = engine.processUtterance(
      'I need to reschedule my appointment, this is Jordan',
      'reschedule_cancel',
      'high',
    );
    expect(decision.action).toBe('ask_clarifying_question');
    expect(decision.toolToExecute).toBeUndefined();
    expect(engine.authorizeToolRequest('update_booking', {
      action: 'reschedule',
      contactName: 'Jordan',
    }).allowed).toBe(false);
  });

  it('routes cancel and reschedule to update_booking and never authorizes create_booking', () => {
    const engine = makeSalonEngine();
    const classified = engine.classifyIntent('I need to cancel my appointment, this is Jordan');
    expect(classified.intent).toBe('reschedule_cancel');

    const decision = engine.processUtterance(
      'I need to cancel my appointment, this is Jordan',
      classified.intent,
      classified.confidence,
    );
    expect(decision.toolToExecute).toBe('update_booking');
    expect(decision.toolToExecute).not.toBe('create_booking');

    const cancelArgs = {
      action: 'cancel',
      contactName: 'Jordan',
      notes: 'Caller cannot make it',
    };
    expect(engine.checkToolSafety('update_booking', cancelArgs).allowed).toBe(true);
    expect(engine.authorizeToolRequest('update_booking', cancelArgs).allowed).toBe(true);
    expect(engine.authorizeToolRequest('create_booking', {
      title: 'Haircut',
      startTime: '2026-10-17T14:00:00-07:00',
      contactName: 'Jordan',
      contactPhone: '+15555550199',
    }).allowed).toBe(false);

    const rescheduleEngine = makeSalonEngine();
    const reschedule = rescheduleEngine.processUtterance(
      'I need to reschedule my appointment to Friday at 3pm, this is Jordan',
      'reschedule_cancel',
      'high',
    );
    expect(reschedule.toolToExecute).toBe('update_booking');
    expect(rescheduleEngine.authorizeToolRequest('create_booking', {
      title: 'Haircut',
      startTime: '2026-10-17T15:00:00-07:00',
      contactName: 'Jordan',
      contactPhone: '+15555550199',
    }).allowed).toBe(false);
  });
});
