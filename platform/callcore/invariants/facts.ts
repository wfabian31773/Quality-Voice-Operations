import { SUCCESS_RUN_CEILING } from './checks';
import { normalizeArgs } from './normalize';
import type { CallFacts, CallFactsInit, CommittedResult, RunRecord, RunRequest, ToolResultInput } from './types';

/**
 * Pure reducers. The runtime owns one CallFacts per call and replaces it with
 * the return value of each helper; nothing here mutates its input.
 */

export function createCallFacts(init: CallFactsInit): CallFacts {
  return {
    callId: init.callId,
    heard: false,
    transferNumberConfigured: init.transferNumberConfigured,
    voiceRefs: init.voiceRefs,
    smsEnabled: init.smsEnabled,
    committed: [],
    preparedTokens: new Set<string>(),
    floorEvaluated: false,
    unvoicedToolResult: false,
    allowedActions: [...init.allowedActions],
    speakableNumbers: [...(init.speakableNumbers ?? [])],
  };
}

/** A number the agent may read back from now on (e.g. the callback number the caller confirmed). */
export function onSpeakableNumber(facts: CallFacts, number: string): CallFacts {
  if (!number || facts.speakableNumbers.includes(number)) return facts;
  return { ...facts, speakableNumbers: [...facts.speakableNumbers, number] };
}

/** The caller was transcribed at least once. */
export function onCallerHeard(facts: CallFacts): CallFacts {
  return facts.heard ? facts : { ...facts, heard: true };
}

/**
 * Any tool result. Marks it unvoiced; commit, write and transfer results are
 * also recorded in `committed`. An ok commit retires its token so it can't be
 * committed twice; an ok commit with no token, or one not prepared on this
 * call, retires every prepared token and clears the yes.
 */
export function onToolResult(facts: CallFacts, result: ToolResultInput): CallFacts {
  let next: CallFacts = { ...facts, unvoicedToolResult: true };
  if (result.kind === 'commit' || result.kind === 'write' || result.kind === 'transfer') {
    const entry: CommittedResult = {
      action: result.action,
      kind: result.kind,
      ok: result.ok,
      refs: result.ok ? [...(result.refs ?? [])] : [],
    };
    next = { ...next, committed: [...facts.committed, entry] };
  }
  if (result.kind !== 'commit' || !result.ok) return next;
  const token = result.confirmationToken;
  if (!token || !facts.preparedTokens.has(token)) {
    // Fail closed: we can't tell which token was consumed, so retire them all.
    return { ...next, preparedTokens: new Set<string>(), explicitYesForToken: undefined };
  }
  const preparedTokens = new Set(facts.preparedTokens);
  preparedTokens.delete(token);
  return {
    ...next,
    preparedTokens,
    explicitYesForToken: facts.explicitYesForToken === token ? undefined : facts.explicitYesForToken,
  };
}

/**
 * A prepare returned this confirmation token. A new prepare supersedes any
 * pending yes: after a correction the caller must confirm the new readback.
 */
export function onPrepared(facts: CallFacts, token: string): CallFacts {
  if (!token || facts.preparedTokens.has(token)) return facts;
  const preparedTokens = new Set(facts.preparedTokens);
  preparedTokens.add(token);
  return { ...facts, preparedTokens, explicitYesForToken: undefined };
}

/**
 * The caller said an explicit yes to the readback for this token. Ignored for
 * a token that wasn't prepared on this call.
 */
export function onExplicitYes(facts: CallFacts, token: string): CallFacts {
  if (!facts.preparedTokens.has(token)) return facts;
  return { ...facts, explicitYesForToken: token };
}

/** The agent's audio for a turn went out: any pending tool result is now voiced. */
export function onAgentSpoke(facts: CallFacts): CallFacts {
  return facts.unvoicedToolResult ? { ...facts, unvoicedToolResult: false } : facts;
}

/** The floor check ran (whether or not it filed). */
export function onFloorEvaluated(facts: CallFacts): CallFacts {
  return facts.floorEvaluated ? facts : { ...facts, floorEvaluated: true };
}

/**
 * Run history helper for checkRun: append one finished run, keep the last
 * `max` (the ceiling only needs the last SUCCESS_RUN_CEILING - 1).
 */
export function appendRun(
  history: readonly RunRecord[],
  run: RunRequest,
  ok: boolean,
  max = SUCCESS_RUN_CEILING,
): RunRecord[] {
  const record: RunRecord = { action: run.action, kind: run.kind, ok, argsKey: normalizeArgs(run.args) };
  return [...history, record].slice(-max);
}
