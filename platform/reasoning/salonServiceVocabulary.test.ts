// Barber vocabulary in the voice slot extractor and the salon pack
// (live call Oct 17, hiccup 3: "I'm looking for a fade" → "Which service
// would you like to book?").
import { describe, expect, it } from 'vitest';
import { ReasoningEngine } from './ReasoningEngine';
import { salonPack } from './industry-packs/salon';
import type { ReasoningContext } from './types';

function makeSalonEngine(): ReasoningEngine {
  return new ReasoningEngine({
    tenantId: 'demo',
    callSessionId: 'salon-vocab-session',
    callSid: 'CA-salon-vocab',
    agentSlug: '3784a2d1-def3-4ace-9747-656275b638ca',
    vertical: 'salon',
    callerNumber: '+15555550199',
    toolsAvailable: ['create_booking', 'update_booking', 'create_ticket', 'get_current_tenant_time', 'retrieve_knowledge'],
    humanTransferAvailable: false,
    memoryStorage: null,
  });
}

function say(engine: ReasoningEngine, utterance: string) {
  const classified = engine.classifyIntent(utterance);
  const decision = engine.processUtterance(utterance, classified.intent, classified.confidence);
  const slots = (engine.getCallSummary().slots as { slots: Record<string, { value: string | null }> }).slots;
  return { classified, decision, slots };
}

function bookingRule() {
  return salonPack.rules.find((rule) => rule.id === 'salon_booking_request')!;
}

describe('salon service vocabulary', () => {
  it('"I\'m looking for a fade" fills the service and does not ask which service', () => {
    const engine = makeSalonEngine();
    const { classified, decision, slots } = say(engine, "I'm looking for a fade");
    expect(classified.intent).toBe('book_appointment');
    expect(slots.title?.value).toBe('Fade');
    expect(decision.clarifyingQuestion ?? '').not.toMatch(/which service/i);
    expect(JSON.stringify(decision)).not.toMatch(/Which service would you like to book/);
  });

  it.each([
    ['can I get a shape up', 'Lineup'],
    ['quiero un degradado', 'Fade'],
    ['I need a haircut', 'Haircut'],
    ['just a lineup', 'Lineup'],
    ['hot towel shave on Saturday', 'Hot towel shave'],
    ['corte y barba', 'Haircut and beard'],
  ])('"%s" is a booking and fills title = %s', (utterance, title) => {
    const engine = makeSalonEngine();
    const { classified, slots } = say(engine, utterance);
    expect(classified.intent).toBe('book_appointment');
    expect(slots.title?.value).toBe(title);
  });

  it('keeps the existing patterns for text that names no service', () => {
    const engine = makeSalonEngine();
    const { slots } = say(engine, 'I want to book an appointment for Saturday');
    expect(slots.title?.value).toBe('to book an appointment for Saturday');
  });

  it('does not treat a weak context phrase as a service', () => {
    const engine = makeSalonEngine();
    expect(engine.classifyIntent('one more for my son').intent).toBe('unknown');
  });

  it('the salon booking rule triggers on lexicon-only service names', () => {
    const ctx = (currentUtterance: string) => ({ currentUtterance }) as ReasoningContext;
    expect(bookingRule().evaluate(ctx('can I get a shape-up')).triggered).toBe(true);
    expect(bookingRule().evaluate(ctx('quiero un degradado')).triggered).toBe(true);
    expect(bookingRule().evaluate(ctx('perfilado de barba')).triggered).toBe(true);
    expect(bookingRule().evaluate(ctx('what time do you close')).triggered).toBe(false);
    expect(bookingRule().evaluate(ctx('cancel my shape-up')).triggered).toBe(false);
  });
});
