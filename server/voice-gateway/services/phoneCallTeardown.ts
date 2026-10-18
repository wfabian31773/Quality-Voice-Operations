/**
 * First step of the Twilio phone-call teardown (routes/stream.ts
 * finalizeStream). Every phone path ends here: caller hangup ("stop" / ws
 * close), and the realtime session closing first (silence watchdog, max
 * duration, budget cap, provider/transport error), which closes the Twilio
 * stream and so runs finalizeStream too.
 *
 * Records the default call outcome (the first writer wins, so a watchdog or
 * budget outcome stands), closes the realtime session so no more transcripts
 * or tool calls arrive, then starts the hangup floor. The floor promise is
 * returned rather than awaited: finalizeStream does its own bookkeeping and
 * awaits it at the end. It is bounded and never rejects, and the session
 * evaluates it at most once, so a second teardown can't file twice.
 */
import type { CallOutcome } from './callOutcome';
import type { FloorOutcome } from './callInvariants';

export interface PhoneTeardownSession {
  recordCallOutcome(outcome: CallOutcome): boolean;
  session: { close(): void | Promise<void> };
  evaluateFloor(): Promise<FloorOutcome>;
}

export interface PhoneTeardownLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export interface PhoneTeardownOptions {
  /**
   * Holds a deploy drain open until the floor settles; returns the release.
   * The socket and the session are both gone by then, so without it the
   * last call to end during a drain could lose its floor to process exit.
   */
  holdDrain?: () => () => void;
  /**
   * The floor protects a caller's lost request, so an outbound call (a
   * campaign callee who answered) skips it: evaluateFloor is never called
   * and the floor resolves to 'skipped_outbound'. Defaults to inbound, the
   * same default finalizeStream's callDirection starts from.
   */
  direction?: 'inbound' | 'outbound';
}

export async function closeRealtimeForPhoneTeardown(
  realtime: PhoneTeardownSession,
  defaultOutcome: CallOutcome,
  log: PhoneTeardownLogger,
  opts: PhoneTeardownOptions = {},
): Promise<{ floor: Promise<FloorOutcome> }> {
  const release = opts.holdDrain?.() ?? (() => {});
  realtime.recordCallOutcome(defaultOutcome);
  try {
    await realtime.session.close();
    log.info('OpenAI realtime session closed');
  } catch (err) {
    log.error('Error closing OpenAI session', { error: String(err) });
  }
  if (opts.direction === 'outbound') {
    const skipped: FloorOutcome = 'skipped_outbound';
    log.info('floor_evaluated', { outcome: skipped });
    return { floor: Promise.resolve(skipped).finally(release) };
  }
  let floor: Promise<FloorOutcome>;
  try {
    floor = realtime.evaluateFloor().catch((): FloorOutcome => 'error');
  } catch {
    floor = Promise.resolve('error');
  }
  return { floor: floor.finally(release) };
}
