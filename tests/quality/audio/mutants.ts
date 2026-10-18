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
 * - S17: VAD speech marking the caller heard.
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
};

async function main(argv: string[]): Promise<number> {
  const names = (argv.find((a) => a.startsWith('--mutants='))?.slice('--mutants='.length) ?? '').split(',').filter(Boolean);
  if (names.length === 0) throw new Error(`--mutants=<name>[,...] from: ${Object.keys(MUTANTS).join(', ')}`);
  for (const name of names) {
    const apply = MUTANTS[name];
    if (!apply) throw new Error(`unknown mutant ${name}`);
    let restore: Restore = () => {};
    process.stdout.write(`\n=== mutant ${name}\n`);
    try {
      const { code, report } = await runAudioCli(['--pass-k=5'], { beforeRun: (rt) => { restore = apply(rt); } });
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
