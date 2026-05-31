import { describe, it, expect, vi, afterEach } from 'vitest';
import { FallbackManager } from './FallbackManager';
import {
  makeReasoningContext,
  makeSlotManifest,
  makeSlotTrackerState,
} from './__fixtures__/reasoningContext';

afterEach(() => {
  vi.useRealTimers();
});

describe('FallbackManager fallback chain', () => {
  it('initiates at the first step with the chain length as maxAttempts', () => {
    const state = new FallbackManager().initiateFallback('low_confidence');
    expect(state.currentStep).toBe('rephrase_request');
    expect(state.stepIndex).toBe(0);
    expect(state.attempts).toBe(1);
    expect(state.maxAttempts).toBe(5);
    expect(state.reason).toBe('low_confidence');
  });

  it('advances through the chain and clamps at the final step', () => {
    const fm = new FallbackManager();
    fm.initiateFallback('r');
    const order = ['narrow_question', 'collect_callback', 'route_to_human', 'create_ticket'];
    for (const step of order) {
      expect(fm.advanceFallback().currentStep).toBe(step);
    }
    // Already at the last step — advancing again stays put (index clamped).
    const clamped = fm.advanceFallback();
    expect(clamped.currentStep).toBe('create_ticket');
    expect(clamped.stepIndex).toBe(4);
  });

  it('treats a second initiate as an advance', () => {
    const fm = new FallbackManager();
    fm.initiateFallback('r');
    const second = fm.initiateFallback('r-again');
    expect(second.currentStep).toBe('narrow_question');
    expect(second.attempts).toBe(2);
  });

  it('auto-initiates if advanceFallback is called before initiation', () => {
    expect(new FallbackManager().advanceFallback().currentStep).toBe('rephrase_request');
  });

  it('exposes step-specific prompts, defaulting to the rephrase prompt pre-init', () => {
    const fm = new FallbackManager();
    expect(fm.getFallbackPrompt()).toBe(
      "I want to make sure I understand you correctly. Could you rephrase what you're looking for?",
    );
    fm.initiateFallback('r');
    fm.advanceFallback(); // narrow_question
    fm.advanceFallback(); // collect_callback
    expect(fm.getFallbackPrompt()).toContain('callback number');
  });

  it('reports final-step, escalation and ticket conditions correctly', () => {
    const fm = new FallbackManager();
    fm.initiateFallback('r');
    expect(fm.isAtFinalFallback()).toBe(false);
    expect(fm.requiresEscalation()).toBe(false);
    fm.advanceFallback(); // narrow_question
    fm.advanceFallback(); // collect_callback
    fm.advanceFallback(); // route_to_human
    expect(fm.requiresEscalation()).toBe(true);
    fm.advanceFallback(); // create_ticket
    expect(fm.requiresTicketFallback()).toBe(true);
    expect(fm.isAtFinalFallback()).toBe(true);
  });

  it('resets fallback state and returns a defensive copy from getFallbackState', () => {
    const fm = new FallbackManager();
    expect(fm.getFallbackState()).toBeNull();
    const state = fm.initiateFallback('r');
    const snapshot = fm.getFallbackState();
    expect(snapshot).not.toBe(state);
    expect(snapshot?.currentStep).toBe('rephrase_request');
    fm.resetFallback();
    expect(fm.getFallbackState()).toBeNull();
    expect(fm.requiresEscalation()).toBe(false);
  });
});

describe('FallbackManager conversation recovery', () => {
  it('captures prior intent and filled slots on a topic switch', () => {
    const fm = new FallbackManager();
    const ctx = makeReasoningContext({
      currentIntent: 'billing_inquiry',
      slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
    });
    const state = fm.handleTopicSwitch(ctx);
    expect(state.priorIntent).toBe('billing_inquiry');
    expect(state.priorSlots).toEqual({ caller_name: 'Ada' });
    expect(state.topicSwitchCount).toBe(1);
  });

  it('recovers and then clears prior context', () => {
    const fm = new FallbackManager();
    expect(fm.canRecoverPriorContext()).toBe(false);
    fm.handleTopicSwitch(
      makeReasoningContext({
        currentIntent: 'billing_inquiry',
        slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
      }),
    );
    expect(fm.canRecoverPriorContext()).toBe(true);
    const recovered = fm.recoverPriorContext();
    expect(recovered).toEqual({ intent: 'billing_inquiry', slots: { caller_name: 'Ada' } });
    // Recovery is one-shot.
    expect(fm.canRecoverPriorContext()).toBe(false);
    expect(fm.recoverPriorContext()).toBeNull();
  });

  it('buffers partial answers, caps the buffer at five, and escalates the prompt', () => {
    const fm = new FallbackManager();
    const first = fm.handlePartialAnswer('uh');
    // No prior intent, small buffer -> generic clarify prompt.
    expect(first.recoveryPrompt).toContain('clarify what they need help');
    fm.handlePartialAnswer('um');
    const third = fm.handlePartialAnswer('hmm');
    expect(third.partialAnswerBuffer).toHaveLength(3);
    expect(third.recoveryPrompt).toContain('several unclear responses');
    // Push past the cap of 5.
    fm.handlePartialAnswer('a');
    fm.handlePartialAnswer('b');
    const sixth = fm.handlePartialAnswer('c');
    expect(sixth.partialAnswerBuffer).toHaveLength(5);
  });

  it('guides back to a prior intent when one exists and the buffer is small', () => {
    const fm = new FallbackManager();
    fm.handleTopicSwitch(makeReasoningContext({ currentIntent: 'service_request' }));
    const state = fm.handlePartialAnswer('what was I saying');
    expect(state.recoveryPrompt).toContain('service request');
  });

  it('counts tool failures', () => {
    const fm = new FallbackManager();
    expect(fm.handleToolFailure().toolFailureCount).toBe(1);
    expect(fm.handleToolFailure().toolFailureCount).toBe(2);
  });

  it('prompts a check-in after extended silence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fm = new FallbackManager();
    expect(fm.handleSilence().recoveryPrompt).toBeUndefined();
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z')); // +11s
    expect(fm.handleSilence().recoveryPrompt).toContain('silent for a while');
  });
});
