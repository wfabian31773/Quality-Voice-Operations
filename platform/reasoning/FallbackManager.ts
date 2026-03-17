import { createLogger } from '../core/logger';
import type {
  FallbackStep,
  FallbackState,
  ConversationRecoveryState,
  ReasoningContext,
} from './types';

const logger = createLogger('FALLBACK_MANAGER');

const FALLBACK_CHAIN: FallbackStep[] = [
  'rephrase_request',
  'narrow_question',
  'collect_callback',
  'route_to_human',
  'create_ticket',
];

const FALLBACK_PROMPTS: Record<FallbackStep, string> = {
  rephrase_request: "I want to make sure I understand you correctly. Could you rephrase what you're looking for?",
  narrow_question: "Let me try to narrow this down. Can you tell me the most important thing you need help with right now?",
  collect_callback: "I'd like to make sure we get this resolved for you. Can I take down a callback number so someone can follow up?",
  route_to_human: "Let me connect you with someone who can help you directly.",
  create_ticket: "I'll create a ticket so our team can follow up with you as soon as possible.",
};

export class FallbackManager {
  private fallbackState: FallbackState | null = null;
  private recoveryState: ConversationRecoveryState;

  constructor() {
    this.recoveryState = this.createInitialRecoveryState();
  }

  initiateFallback(reason: string): FallbackState {
    if (this.fallbackState) {
      return this.advanceFallback();
    }

    this.fallbackState = {
      currentStep: FALLBACK_CHAIN[0],
      stepIndex: 0,
      reason,
      attempts: 1,
      maxAttempts: FALLBACK_CHAIN.length,
    };

    logger.info('Fallback initiated', {
      step: this.fallbackState.currentStep,
      reason,
    });

    return this.fallbackState;
  }

  advanceFallback(): FallbackState {
    if (!this.fallbackState) {
      return this.initiateFallback('auto_advance');
    }

    this.fallbackState.stepIndex++;
    this.fallbackState.attempts++;

    if (this.fallbackState.stepIndex >= FALLBACK_CHAIN.length) {
      this.fallbackState.stepIndex = FALLBACK_CHAIN.length - 1;
    }

    this.fallbackState.currentStep = FALLBACK_CHAIN[this.fallbackState.stepIndex];

    logger.info('Fallback advanced', {
      step: this.fallbackState.currentStep,
      index: this.fallbackState.stepIndex,
    });

    return this.fallbackState;
  }

  getFallbackPrompt(): string {
    if (!this.fallbackState) return FALLBACK_PROMPTS.rephrase_request;
    return FALLBACK_PROMPTS[this.fallbackState.currentStep];
  }

  isAtFinalFallback(): boolean {
    return this.fallbackState?.stepIndex === FALLBACK_CHAIN.length - 1;
  }

  requiresEscalation(): boolean {
    if (!this.fallbackState) return false;
    return this.fallbackState.currentStep === 'route_to_human';
  }

  requiresTicketFallback(): boolean {
    if (!this.fallbackState) return false;
    return this.fallbackState.currentStep === 'create_ticket';
  }

  resetFallback(): void {
    this.fallbackState = null;
  }

  getFallbackState(): FallbackState | null {
    return this.fallbackState ? { ...this.fallbackState } : null;
  }

  handleTopicSwitch(context: ReasoningContext): ConversationRecoveryState {
    this.recoveryState.priorIntent = context.currentIntent;
    const filledSlots: Record<string, string> = {};
    for (const [name, slot] of context.slotTracker.slots) {
      if (slot.value !== null) {
        filledSlots[name] = slot.value;
      }
    }
    this.recoveryState.priorSlots = filledSlots;
    this.recoveryState.topicSwitchCount++;
    this.recoveryState.lastActivityTimestamp = new Date();

    logger.info('Topic switch detected', {
      callId: context.callSessionId,
      priorIntent: this.recoveryState.priorIntent,
      switchCount: this.recoveryState.topicSwitchCount,
    });

    return { ...this.recoveryState };
  }

  handlePartialAnswer(utterance: string): ConversationRecoveryState {
    this.recoveryState.partialAnswerBuffer.push(utterance);
    this.recoveryState.lastActivityTimestamp = new Date();

    if (this.recoveryState.partialAnswerBuffer.length > 5) {
      this.recoveryState.partialAnswerBuffer.shift();
    }

    let recoveryPrompt: string | undefined;
    const bufferSize = this.recoveryState.partialAnswerBuffer.length;

    if (bufferSize >= 3) {
      recoveryPrompt = 'The caller has given several unclear responses. Try rephrasing your question more simply, or offer specific options for them to choose from.';
    } else if (this.recoveryState.priorIntent) {
      recoveryPrompt = `Try to gently guide the caller back to the topic of "${this.recoveryState.priorIntent.replace(/_/g, ' ')}" or ask what they need help with.`;
    } else {
      recoveryPrompt = 'Ask the caller to clarify what they need help with today.';
    }

    return { ...this.recoveryState, recoveryPrompt };
  }

  handleToolFailure(): ConversationRecoveryState {
    this.recoveryState.toolFailureCount++;
    this.recoveryState.lastActivityTimestamp = new Date();

    logger.warn('Tool failure recorded', {
      failureCount: this.recoveryState.toolFailureCount,
    });

    return { ...this.recoveryState };
  }

  handleSilence(): ConversationRecoveryState {
    const now = new Date();
    const elapsed = now.getTime() - this.recoveryState.lastActivityTimestamp.getTime();

    if (elapsed > 10000) {
      logger.info('Extended silence detected', { elapsedMs: elapsed });
    }

    const recoveryPrompt = elapsed > 10000
      ? 'The caller has been silent for a while. Check if they are still there and ask if they need help with anything.'
      : undefined;

    return { ...this.recoveryState, recoveryPrompt };
  }

  canRecoverPriorContext(): boolean {
    return this.recoveryState.priorIntent !== null;
  }

  recoverPriorContext(): { intent: string; slots: Record<string, string> } | null {
    if (!this.recoveryState.priorIntent) return null;

    const result = {
      intent: this.recoveryState.priorIntent,
      slots: { ...this.recoveryState.priorSlots },
    };

    this.recoveryState.priorIntent = null;
    this.recoveryState.priorSlots = {};

    logger.info('Prior context recovered', { intent: result.intent });

    return result;
  }

  getRecoveryState(): ConversationRecoveryState {
    return { ...this.recoveryState };
  }

  private createInitialRecoveryState(): ConversationRecoveryState {
    return {
      priorIntent: null,
      priorSlots: {},
      topicSwitchCount: 0,
      lastActivityTimestamp: new Date(),
      partialAnswerBuffer: [],
      toolFailureCount: 0,
    };
  }
}
