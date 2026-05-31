import { describe, it, expect } from 'vitest';
import { ConfidenceScorer } from './ConfidenceScorer';
import type { ConfidenceScore } from './types';
import {
  makeReasoningContext,
  makeSlotManifest,
  makeSlotTrackerState,
  makeRecoveryState,
} from './__fixtures__/reasoningContext';

describe('ConfidenceScorer.score', () => {
  it('computes the weighted score for a high-intent, no-slots-filled context', () => {
    // intent high (1.0)*0.3 + slot 0*0.25 + tool high (1.0)*0.2 + ambiguity low (1.0)*0.15
    const score = new ConfidenceScorer().score(makeReasoningContext());
    expect(score.numericScore).toBeCloseTo(0.65, 5);
    expect(score.overall).toBe('medium');
    expect(score.factors.intentCertainty).toBe('high');
    expect(score.factors.slotCompleteness).toBe(0);
    expect(score.factors.toolResultCertainty).toBe('high');
    expect(score.factors.conversationAmbiguity).toBe('low');
    expect(score.timestamp).toBeInstanceOf(Date);
  });

  it('reaches the maximum 0.9 when every factor is ideal and all required slots are filled', () => {
    const ctx = makeReasoningContext({
      slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
    });
    const score = new ConfidenceScorer().score(ctx);
    expect(score.numericScore).toBeCloseTo(0.9, 5);
    expect(score.overall).toBe('high');
  });

  it('treats a manifest with no required slots as fully complete (1.0)', () => {
    const ctx = makeReasoningContext({
      slotTracker: makeSlotTrackerState(
        makeSlotManifest([{ name: 'preferred_time', required: false }]),
      ),
    });
    const score = new ConfidenceScorer().score(ctx);
    expect(score.factors.slotCompleteness).toBe(1);
    expect(score.numericScore).toBeCloseTo(0.9, 5);
  });

  it('scores low across the board (unknown intent, tool failures) and floors at the low band', () => {
    const ctx = makeReasoningContext({
      intentConfidence: 'low',
      currentIntent: 'unknown',
      recoveryState: makeRecoveryState({ toolFailureCount: 3 }),
    });
    const score = new ConfidenceScorer().score(ctx);
    // 0.2*0.3 + 0 + 0.3*0.2 + 0.2*0.15 = 0.15
    expect(score.numericScore).toBeCloseTo(0.15, 5);
    expect(score.overall).toBe('low');
    expect(score.factors.toolResultCertainty).toBe('low');
    expect(score.factors.conversationAmbiguity).toBe('high');
  });

  it('applies a per-turn progress penalty capped at 0.4', () => {
    const ideal = {
      slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
    };
    // 5 buffered partial answers -> penalty min(0.5, 0.4) = 0.4, off the 0.9 ideal.
    const score = new ConfidenceScorer().score(
      makeReasoningContext({
        ...ideal,
        recoveryState: makeRecoveryState({ partialAnswerBuffer: ['a', 'b', 'c', 'd', 'e'] }),
      }),
    );
    expect(score.factors.turnsWithoutProgress).toBe(5);
    expect(score.numericScore).toBeCloseTo(0.5, 5);
  });

  it('clamps the final score to [0, 1]', () => {
    const ctx = makeReasoningContext({
      intentConfidence: 'low',
      currentIntent: 'unknown',
      recoveryState: makeRecoveryState({
        toolFailureCount: 3,
        partialAnswerBuffer: ['a', 'b', 'c', 'd'],
      }),
    });
    // 0.15 - 0.4 = -0.25 -> clamped to 0
    expect(new ConfidenceScorer().score(ctx).numericScore).toBe(0);
  });

  it('escalates ambiguity to high after more than two topic switches', () => {
    const score = new ConfidenceScorer().score(
      makeReasoningContext({ recoveryState: makeRecoveryState({ topicSwitchCount: 3 }) }),
    );
    expect(score.factors.conversationAmbiguity).toBe('high');
  });

  it('treats slotTracker absence defensively as zero completeness', () => {
    const ctx = makeReasoningContext({
      // Exercises the `context.slotTracker ? ... : 0` guard.
      slotTracker: undefined as unknown as ReturnType<typeof makeSlotTrackerState>,
    });
    expect(new ConfidenceScorer().score(ctx).factors.slotCompleteness).toBe(0);
  });
});

describe('ConfidenceScorer thresholds', () => {
  const make = (numericScore: number): ConfidenceScore => ({
    overall: 'medium',
    numericScore,
    factors: {
      intentCertainty: 'medium',
      slotCompleteness: 0.5,
      toolResultCertainty: 'medium',
      conversationAmbiguity: 'medium',
      turnsWithoutProgress: 0,
    },
    timestamp: new Date(),
  });

  it('proceeds at or above the proceed threshold', () => {
    const scorer = new ConfidenceScorer();
    expect(scorer.shouldProceed(make(0.7))).toBe(true);
    expect(scorer.shouldProceed(make(0.69))).toBe(false);
  });

  it('clarifies in the band between the clarify and proceed thresholds', () => {
    const scorer = new ConfidenceScorer();
    expect(scorer.shouldClarify(make(0.4))).toBe(true);
    expect(scorer.shouldClarify(make(0.69))).toBe(true);
    expect(scorer.shouldClarify(make(0.7))).toBe(false);
    expect(scorer.shouldClarify(make(0.39))).toBe(false);
  });

  it('escalates below the clarify threshold', () => {
    const scorer = new ConfidenceScorer();
    expect(scorer.shouldEscalate(make(0.39))).toBe(true);
    expect(scorer.shouldEscalate(make(0.4))).toBe(false);
  });

  it('honors custom thresholds passed to the constructor', () => {
    const scorer = new ConfidenceScorer(0.9, 0.6);
    expect(scorer.shouldProceed(make(0.85))).toBe(false);
    expect(scorer.shouldClarify(make(0.85))).toBe(true);
    expect(scorer.shouldEscalate(make(0.55))).toBe(true);
  });
});
