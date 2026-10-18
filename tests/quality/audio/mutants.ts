/**
 * Mutation proof (G6) for the audio pack. Each mutant is an in-memory
 * override of a runtime class, applied in this test process after the
 * runtime is loaded and restored afterwards. No runtime file is edited.
 *
 *   node --import tsx tests/quality/audio/mutants.ts --mutants=<name>[,<name>...]
 *
 * Prints the gate summary per mutant and one RESULT_MARKER line with
 * { mutant, code, ...report }. audio.test.ts asserts what each one turns red.
 *
 * Every mutant removes one runtime guard (it doesn't emulate one), so a
 * scenario going red proves that guard is what keeps it green:
 * - S03: the never-heard ladder and silence counted from the mark echo;
 * - S12: the Twilio `clear` on barge-in, dropping the interrupted turn's
 *   late audio deltas, no response of its own for a tool result the
 *   caller spoke over, and voicing that result once if no caller reply
 *   carried it (the backchannel);
 * - S17: VAD speech marking the caller heard;
 * - S18: the hold line's trigger (slow tool), and its knowing the result
 *   came back first (fast tool); the transport's one-response-at-a-time
 *   guard (RT-HOLD-LINE §4);
 * - RT-HOLD-LINE part 2: bookkeeping off the critical path (the timing
 *   fixture's < 1000 ms tool call → result goes red without it).
 */
import { exitWith, RESULT_MARKER, runAudioCli } from '../../../scripts/quality/audio/run';
import type { RuntimeModules } from '../../../scripts/quality/audio/edges';

type Restore = () => void;
type Proto = Record<string, unknown>;

function patch(proto: Proto, name: string, wrap: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown): Restore {
  const original = proto[name] as (...args: unknown[]) => unknown;
  if (typeof original !== 'function') throw new Error(`no method ${name} to mutate`);
  proto[name] = wrap(original);
  return () => {
    proto[name] = original;
  };
}

function watchdogProto(rt: RuntimeModules): Proto {
  return rt.silenceWatchdog.SilenceWatchdog.prototype as unknown as Proto;
}

function transportProto(rt: RuntimeModules): Proto {
  return rt.xaiRealtimeTransport.XaiRealtimeTransport.prototype as unknown as Proto;
}

function holdLineProto(rt: RuntimeModules): Proto {
  return rt.holdLine.HoldLine.prototype as unknown as Proto;
}

function bookkeepingProto(rt: RuntimeModules): Proto {
  return rt.bookkeepingQueue.BookkeepingQueue.prototype as unknown as Proto;
}

/** A tool call waits for every bookkeeping write it queued, as before the queue (31996d53's critical path). */
const bookkeepingInline = (rt: RuntimeModules): Restore =>
  patch(bookkeepingProto(rt), 'onCriticalPath', () => function (this: { settled(): Promise<void> }) {
    return this.settled();
  });

/** No call-stable read is cached (ContractToolBridge.readCacheKey): every repeat reads the database again. */
const noReadCache = (rt: RuntimeModules): Restore =>
  patch(rt.contractToolBridge.ContractToolBridge.prototype as unknown as Proto, 'readCacheKey', noop);

const all = (...restores: Restore[]): Restore => () => restores.forEach((restore) => restore());

const noop = () => function () {
  return undefined;
};

export const MUTANTS: Record<string, (rt: RuntimeModules) => Restore> = {
  /** The never-heard ladder skips its second prompt. */
  's03-ladder-skips-a-prompt': (rt) =>
    patch(watchdogProto(rt), 'onNeverHeardSilence', (original) => function (this: Proto) {
      if (this.neverHeardPrompts === 1) this.neverHeardPrompts = 2;
      return original.call(this);
    }),
  /** VA-15's mark wiring reverted: silence counted from response.done, while Twilio is still playing. */
  's03-silence-from-response-done': (rt) =>
    patch(watchdogProto(rt), 'agentTurnEnded', (original) => function (this: Proto) {
      this.playbackConfirm = 'response_done';
      return original.call(this);
    }),
  /** Barge-in never interrupts agent audio: no Twilio `clear` (SilenceWatchdog.interruptAgentAudio). */
  's12-no-clear': (rt) => patch(watchdogProto(rt), 'interruptAgentAudio', () => function () {
    return undefined;
  }),
  /** Deltas of the interrupted turn are played (XaiRealtimeTransport.dropInterruptedAudio). */
  's12-no-stale-audio-drop': (rt) => patch(transportProto(rt), 'dropInterruptedAudio', () => function () {
    return undefined;
  }),
  /** Every tool result starts its own response, even one the caller spoke over (XaiRealtimeTransport.callerSpokeSince). */
  's12-no-late-result-rule': (rt) => patch(transportProto(rt), 'callerSpokeSince', () => function () {
    return false;
  }),
  /** A withheld tool result is never voiced on its own, even when no caller reply carried it (XaiRealtimeTransport.voiceWithheldResult). */
  's12-no-deferred-voicing': (rt) => patch(transportProto(rt), 'voiceWithheldResult', () => function () {
    return undefined;
  }),
  /** "Heard" needs a transcript again: VAD speech never counts (SilenceWatchdog.isAudibleSpeech). */
  's17-no-vad-heard': (rt) => patch(watchdogProto(rt), 'isAudibleSpeech', () => function () {
    return false;
  }),
  /** The hold line's deadline does nothing (HoldLine.onDeadline): a slow tool is silence again. */
  's18-no-hold-line-trigger': (rt) => patch(holdLineProto(rt), 'onDeadline', noop),
  /**
   * The hold line no longer knows the result came back first. It learns it
   * two ways, and each alone keeps a fast tool quiet, so both go: the tool's
   * end (HoldLine.toolEnded) and the agent starting to speak the answer
   * (HoldLine.agentAudioStarted).
   */
  's18-hold-line-deaf-to-result': (rt) => {
    const restores = [patch(holdLineProto(rt), 'toolEnded', noop), patch(holdLineProto(rt), 'agentAudioStarted', noop)];
    return () => restores.forEach((restore) => restore());
  },
  /** The transport's one-response-at-a-time guard is gone (XaiRealtimeTransport.responseBusy): creates go on top of a response in flight. */
  'transport-no-in-flight-guard': (rt) => patch(transportProto(rt), 'responseBusy', () => function () {
    return false;
  }),
  /**
   * RT-HOLD-LINE part 2: the bookkeeping queue removed from the critical path's
   * point of view (BookkeepingQueue.onCriticalPath awaits the writes, as the
   * inline path did): tool call → result is the bookkeeping again.
   */
  'bookkeeping-inline': bookkeepingInline,
  /** The call cache of call-stable reads removed: the catalog fixture reads the database twice. */
  'no-read-cache': noReadCache,
  /** 31996d53's path for the timing table (part 1): bookkeeping inline, no read cache, the hold line on. */
  'part1-path': (rt) => all(bookkeepingInline(rt), noReadCache(rt)),
  /** a3d2a94c's path for the timing table: bookkeeping inline, no read cache, no hold line. */
  'a3d2a94c-path': (rt) => all(bookkeepingInline(rt), noReadCache(rt), patch(holdLineProto(rt), 'onDeadline', noop)),
};

async function main(argv: string[]): Promise<number> {
  const names = (argv.find((a) => a.startsWith('--mutants='))?.slice('--mutants='.length) ?? '').split(',').filter(Boolean);
  if (names.length === 0) throw new Error(`--mutants=<name>[,...] from: ${Object.keys(MUTANTS).join(', ')}`);
  // Anything else goes to the runner (e.g. --dir=<fixtures> --pass-k=1 for a timing run).
  const runnerArgs = ['--pass-k=5', ...argv.filter((a) => !a.startsWith('--mutants='))];
  for (const name of names) {
    const apply = MUTANTS[name];
    if (!apply) throw new Error(`unknown mutant ${name}`);
    let restore: Restore = () => {};
    process.stdout.write(`\n=== mutant ${name}\n`);
    try {
      const { code, report } = await runAudioCli(runnerArgs, { beforeRun: (rt) => { restore = apply(rt); } });
      process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ mutant: name, code, ...report })}\n`);
    } finally {
      restore();
    }
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => exitWith(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    exitWith(1);
  });
