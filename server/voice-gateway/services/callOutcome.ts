/**
 * One call end outcome per call (VA-15). The first writer wins; later attempts
 * are ignored, so the watchdog's `never_heard` beats the stream finalizer's
 * default that runs when the hang-up closes the stream. Persisted as
 * `call_sessions.context.callEndOutcome` (a string) plus a `call_end_outcome`
 * call event. `context.callOutcome` belongs to the record_call_outcome tool
 * (a disposition object read by analytics) and is never touched here.
 *
 * Recorded today:
 * - `never_heard`      silence watchdog, caller never transcribed (recorded
 *                      at the hang-up, so a call that continues never has it)
 * - `max_duration`     silence watchdog, 10-minute cap
 * - `agent_ended`      runtime ended the call (budget cap, demo hard cap)
 * - `provider_failure` the realtime session closed (or failed to connect)
 *                      before the caller's stream ended
 * - `caller_hangup`    default at finalize: the caller side closed first
 * Reserved, not produced yet: `completed` (no agent end-call tool exists),
 * `dead_air` (heard callers are never cut for silence).
 */

export const CALL_OUTCOMES = [
  'caller_hangup',
  'agent_ended',
  'completed',
  'dead_air',
  'never_heard',
  'max_duration',
  'provider_failure',
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export class CallOutcomeRecorder {
  private recorded: CallOutcome | null = null;

  constructor(private readonly onRecorded: (outcome: CallOutcome) => void) {}

  /** Returns true if this call recorded the outcome, false if one already was. */
  record(outcome: CallOutcome): boolean {
    if (this.recorded !== null) return false;
    this.recorded = outcome;
    this.onRecorded(outcome);
    return true;
  }

  get outcome(): CallOutcome | null {
    return this.recorded;
  }
}
