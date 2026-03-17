import { createLogger } from '../core/logger';
import type {
  ConfidenceLevel,
  ConfidenceScore,
  ConfidenceFactors,
  ReasoningContext,
} from './types';

const logger = createLogger('CONFIDENCE_SCORER');

const INTENT_CERTAINTY_WEIGHTS: Record<ConfidenceLevel, number> = {
  high: 1.0,
  medium: 0.6,
  low: 0.2,
};

const AMBIGUITY_WEIGHTS: Record<ConfidenceLevel, number> = {
  high: 0.2,
  medium: 0.6,
  low: 1.0,
};

const TOOL_CERTAINTY_WEIGHTS: Record<ConfidenceLevel, number> = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
};

export class ConfidenceScorer {
  private readonly proceedThreshold: number;
  private readonly clarifyThreshold: number;

  constructor(
    proceedThreshold = 0.7,
    clarifyThreshold = 0.4,
  ) {
    this.proceedThreshold = proceedThreshold;
    this.clarifyThreshold = clarifyThreshold;
  }

  score(context: ReasoningContext): ConfidenceScore {
    const factors = this.computeFactors(context);
    const numericScore = this.computeNumericScore(factors);
    const overall = this.numericToLevel(numericScore);

    const result: ConfidenceScore = {
      overall,
      numericScore,
      factors,
      timestamp: new Date(),
    };

    logger.debug('Confidence scored', {
      callId: context.callSessionId,
      overall,
      numericScore: numericScore.toFixed(3),
      slotCompleteness: factors.slotCompleteness.toFixed(2),
    });

    return result;
  }

  shouldProceed(score: ConfidenceScore): boolean {
    return score.numericScore >= this.proceedThreshold;
  }

  shouldClarify(score: ConfidenceScore): boolean {
    return (
      score.numericScore >= this.clarifyThreshold &&
      score.numericScore < this.proceedThreshold
    );
  }

  shouldEscalate(score: ConfidenceScore): boolean {
    return score.numericScore < this.clarifyThreshold;
  }

  private computeFactors(context: ReasoningContext): ConfidenceFactors {
    const intentCertainty = context.intentConfidence;
    const slotCompleteness = context.slotTracker
      ? this.computeSlotCompleteness(context)
      : 0;
    const toolResultCertainty = this.assessToolResultCertainty(context);
    const conversationAmbiguity = this.assessAmbiguity(context);
    const turnsWithoutProgress = this.countTurnsWithoutProgress(context);

    return {
      intentCertainty,
      slotCompleteness,
      toolResultCertainty,
      conversationAmbiguity,
      turnsWithoutProgress,
    };
  }

  private computeNumericScore(factors: ConfidenceFactors): number {
    const intentScore = INTENT_CERTAINTY_WEIGHTS[factors.intentCertainty];
    const slotScore = factors.slotCompleteness;
    const toolScore = TOOL_CERTAINTY_WEIGHTS[factors.toolResultCertainty];
    const ambiguityScore = AMBIGUITY_WEIGHTS[factors.conversationAmbiguity];
    const progressPenalty = Math.min(factors.turnsWithoutProgress * 0.1, 0.4);

    const weighted =
      intentScore * 0.3 +
      slotScore * 0.25 +
      toolScore * 0.2 +
      ambiguityScore * 0.15 -
      progressPenalty;

    return Math.max(0, Math.min(1, weighted));
  }

  private numericToLevel(score: number): ConfidenceLevel {
    if (score >= this.proceedThreshold) return 'high';
    if (score >= this.clarifyThreshold) return 'medium';
    return 'low';
  }

  private computeSlotCompleteness(context: ReasoningContext): number {
    const { slots } = context.slotTracker;
    let totalRequired = 0;
    let filledRequired = 0;
    for (const [, slot] of slots) {
      if (slot.required) {
        totalRequired++;
        if (slot.value !== null) filledRequired++;
      }
    }
    return totalRequired === 0 ? 1.0 : filledRequired / totalRequired;
  }

  private assessToolResultCertainty(context: ReasoningContext): ConfidenceLevel {
    if (context.recoveryState.toolFailureCount > 2) return 'low';
    if (context.recoveryState.toolFailureCount > 0) return 'medium';
    return 'high';
  }

  private assessAmbiguity(context: ReasoningContext): ConfidenceLevel {
    if (context.currentIntent === 'unknown') return 'high';
    if (context.recoveryState.topicSwitchCount > 2) return 'high';
    if (context.recoveryState.topicSwitchCount > 0) return 'medium';
    if (context.intentConfidence === 'low') return 'high';
    return 'low';
  }

  private countTurnsWithoutProgress(context: ReasoningContext): number {
    return context.recoveryState.partialAnswerBuffer.length;
  }
}
