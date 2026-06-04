/**
 * Test fixtures for the reasoning engine. Excluded from coverage via the
 * `**​/__fixtures__/**` glob in vitest.config.ts.
 *
 * `makeReasoningContext` builds a complete, valid `ReasoningContext` with
 * neutral defaults; pass a partial to override any top-level field. Nested
 * objects (slotTracker, recoveryState, callerContext) are replaced wholesale
 * when provided, so use the `makeSlotTrackerState` / `makeRecoveryState`
 * helpers to build them.
 */
import type {
  ReasoningContext,
  SlotTrackerState,
  SlotManifest,
  SlotManifestEntry,
  SlotState,
  ConversationRecoveryState,
  CallerContext,
} from '../types';

export function makeSlotManifestEntry(
  overrides: Partial<SlotManifestEntry> = {},
): SlotManifestEntry {
  return {
    name: 'caller_name',
    label: 'Caller name',
    required: true,
    prompt: 'May I have your name?',
    ...overrides,
  };
}

/** Build a SlotManifest from a compact list of [name, required] pairs. */
export function makeSlotManifest(
  slots: Array<Partial<SlotManifestEntry>> = [{ name: 'caller_name', required: true }],
  meta: Partial<Pick<SlotManifest, 'vertical' | 'intent'>> = {},
): SlotManifest {
  return {
    vertical: meta.vertical ?? 'hvac',
    intent: meta.intent ?? 'service_request',
    slots: slots.map((s) => makeSlotManifestEntry(s)),
  };
}

/**
 * Build a SlotTrackerState directly (without the SlotTracker class), so tests
 * can assert against a known slot map. `filled` maps slot name -> value.
 */
export function makeSlotTrackerState(
  manifest: SlotManifest = makeSlotManifest(),
  filled: Record<string, string> = {},
  currentTurn = 0,
): SlotTrackerState {
  const slots = new Map<string, SlotState>();
  for (const entry of manifest.slots) {
    const value = filled[entry.name] ?? null;
    slots.set(entry.name, {
      name: entry.name,
      value,
      required: entry.required,
      filledAtTurn: value !== null ? currentTurn : null,
      attempts: value !== null ? 1 : 0,
    });
  }
  return { manifest, slots, currentTurn };
}

export function makeRecoveryState(
  overrides: Partial<ConversationRecoveryState> = {},
): ConversationRecoveryState {
  return {
    priorIntent: null,
    priorSlots: {},
    topicSwitchCount: 0,
    lastActivityTimestamp: new Date('2026-01-01T00:00:00Z'),
    partialAnswerBuffer: [],
    toolFailureCount: 0,
    ...overrides,
  };
}

export function makeCallerContext(
  overrides: Partial<CallerContext> = {},
): CallerContext {
  return {
    memory: null,
    isReturningCaller: false,
    hasOpenTickets: false,
    openTicketIds: [],
    ...overrides,
  };
}

export function makeReasoningContext(
  overrides: Partial<ReasoningContext> = {},
): ReasoningContext {
  return {
    tenantId: 'tenant-1',
    callSessionId: 'session-1',
    callSid: 'CA123',
    agentSlug: 'agent-1',
    vertical: 'hvac',
    callerNumber: '+15551234567',
    currentUtterance: 'I need my furnace fixed',
    currentIntent: 'service_request',
    intentConfidence: 'high',
    slotTracker: makeSlotTrackerState(),
    workflowPlan: null,
    fallbackState: null,
    recoveryState: makeRecoveryState(),
    callerContext: makeCallerContext(),
    turnCount: 1,
    transcript: [],
    toolsAvailable: [],
    tenantPolicies: [],
    escalationAttempts: 0,
    ...overrides,
  };
}
