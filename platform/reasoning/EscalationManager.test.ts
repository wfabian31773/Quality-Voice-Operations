import { describe, it, expect } from 'vitest';
import { EscalationManager } from './EscalationManager';
import type { ConfidenceScore } from './types';
import { makeReasoningContext } from './__fixtures__/reasoningContext';

function confidence(overall: ConfidenceScore['overall']): ConfidenceScore {
  return {
    overall,
    numericScore: overall === 'low' ? 0.2 : 0.8,
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

const HIGH = confidence('high');
const LOW = confidence('low');

describe('EscalationManager keyword triggers', () => {
  it('escalates an emergency keyword to a warm transfer', () => {
    const ev = new EscalationManager().evaluate(
      makeReasoningContext({ currentUtterance: 'I think my dad is having a heart attack' }),
      HIGH,
    );
    expect(ev?.trigger).toBe('emergency_keyword');
    expect(ev?.output).toBe('warm_transfer');
    expect(ev?.metadata.keyword).toBe('heart attack');
  });

  it('escalates an explicit human request to a warm transfer', () => {
    const ev = new EscalationManager().evaluate(
      makeReasoningContext({ currentUtterance: 'Can I please talk to a person' }),
      HIGH,
    );
    expect(ev?.trigger).toBe('explicit_human_request');
    expect(ev?.output).toBe('warm_transfer');
  });

  it('routes a billing dispute to an urgent ticket', () => {
    const ev = new EscalationManager().evaluate(
      makeReasoningContext({ currentUtterance: 'I was overcharged on my last bill' }),
      HIGH,
    );
    expect(ev?.trigger).toBe('billing_dispute');
    expect(ev?.output).toBe('urgent_ticket');
  });

  it('matches keywords case-insensitively', () => {
    const ev = new EscalationManager().evaluate(
      makeReasoningContext({ currentUtterance: 'THERE IS A GAS LEAK' }),
      HIGH,
    );
    expect(ev?.trigger).toBe('emergency_keyword');
  });

  it('prioritizes emergency over human-request and billing keywords', () => {
    const ev = new EscalationManager().evaluate(
      makeReasoningContext({
        currentUtterance: 'fire! I want a refund and a representative',
      }),
      HIGH,
    );
    expect(ev?.trigger).toBe('emergency_keyword');
  });

  it('returns null when no trigger applies and confidence is healthy', () => {
    const ev = new EscalationManager().evaluate(
      makeReasoningContext({ currentUtterance: 'I would like to book a tune-up please' }),
      HIGH,
    );
    expect(ev).toBeNull();
  });

  it('honors custom keyword configuration', () => {
    const mgr = new EscalationManager({ emergencyKeywords: ['kaboom'] });
    expect(
      mgr.evaluate(makeReasoningContext({ currentUtterance: 'kaboom' }), HIGH)?.trigger,
    ).toBe('emergency_keyword');
    // A default emergency keyword no longer triggers once overridden.
    expect(
      mgr.evaluate(makeReasoningContext({ currentUtterance: 'heart attack' }), HIGH),
    ).toBeNull();
  });
});

describe('EscalationManager confidence-driven triggers', () => {
  it('escalates to a callback after repeated low-confidence turns', () => {
    const mgr = new EscalationManager(); // maxConfusionTurns = 3
    const ctx = makeReasoningContext({ currentUtterance: 'um, I am not sure' });
    expect(mgr.evaluate(ctx, LOW)).toBeNull();
    expect(mgr.evaluate(ctx, LOW)).toBeNull();
    const ev = mgr.evaluate(ctx, LOW);
    expect(ev?.trigger).toBe('repeated_confusion');
    expect(ev?.output).toBe('callback');
    expect(ev?.metadata.confusionCount).toBe(3);
  });

  it('escalates to an SMS follow-up after sustained low confidence', () => {
    // Raise the confusion ceiling so the retry path is the one that fires.
    const mgr = new EscalationManager({ maxConfusionTurns: 99, maxLowConfidenceRetries: 4 });
    const ctx = makeReasoningContext({ currentUtterance: 'hmm' });
    for (let i = 0; i < 3; i++) expect(mgr.evaluate(ctx, LOW)).toBeNull();
    const ev = mgr.evaluate(ctx, LOW);
    expect(ev?.trigger).toBe('low_confidence_retries');
    expect(ev?.output).toBe('sms_followup');
  });

  it('does not accumulate confusion when confidence stays healthy', () => {
    const mgr = new EscalationManager();
    const ctx = makeReasoningContext({ currentUtterance: 'sounds good' });
    for (let i = 0; i < 5; i++) expect(mgr.evaluate(ctx, HIGH)).toBeNull();
  });
});

describe('EscalationManager history & counters', () => {
  it('records each escalation and returns a defensive copy of the history', () => {
    const mgr = new EscalationManager();
    mgr.evaluate(makeReasoningContext({ currentUtterance: 'fire' }), HIGH);
    mgr.evaluate(makeReasoningContext({ currentUtterance: 'representative' }), HIGH);
    const history = mgr.getEscalationHistory();
    expect(history).toHaveLength(2);
    history.pop();
    expect(mgr.getEscalationHistory()).toHaveLength(2); // unaffected by mutation
  });

  it('lets manual confusion counts and resets drive the threshold', () => {
    const mgr = new EscalationManager({ maxConfusionTurns: 3 });
    mgr.recordConfusion();
    mgr.recordConfusion();
    // 2 manual + this low-confidence evaluate (=3) crosses the threshold.
    expect(
      mgr.evaluate(makeReasoningContext({ currentUtterance: 'idk' }), LOW)?.trigger,
    ).toBe('repeated_confusion');

    mgr.resetCounters();
    expect(mgr.evaluate(makeReasoningContext({ currentUtterance: 'idk' }), LOW)).toBeNull();
  });
});
