/**
 * Mutation proof (G6) for the audio pack. Each mutant is an in-memory
 * override of a runtime class or the transport, applied in this test
 * process after the runtime is loaded and restored afterwards. No runtime
 * file is edited.
 *
 *   node --import tsx tests/quality/audio/mutants.ts --mutants=<name>[,<name>...]
 *
 * Prints the gate summary per mutant and one RESULT_MARKER line with
 * { mutant, code, ...report }. audio.test.ts asserts what each one turns red.
 *
 * Two kinds:
 * - breakers: break a guard that works today (S03 goes red);
 * - reference fixes: emulate the missing runtime guard the way the follow-up
 *   would add it (Twilio `clear` + dropping the interrupted turn and its late
 *   tool result; VAD speech counts as heard). They prove the S12/S17 checks
 *   pass on correct behaviour, so their expectedFail is a real gap, and that
 *   the gate notices when the gap closes (unexpected pass → red). Partial
 *   fixes prove each S12 check is independently live.
 */
import { exitWith, RESULT_MARKER, runAudioCli } from '../../../scripts/quality/audio/run';
import type { RuntimeModules } from '../../../scripts/quality/audio/edges';
import { currentWorld } from '../../../scripts/quality/audio/world';

type Restore = () => void;
type Proto = Record<string, unknown>;

function patch(proto: Proto, name: string, wrap: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown): Restore {
  const original = proto[name] as (...args: unknown[]) => unknown;
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

/** Barge-in reference fix, in the transport: clear Twilio, drop the interrupted turn's audio, optionally its late tool result. */
function referenceBargeIn(rt: RuntimeModules, opts: { clear: boolean; dropLateResult: boolean }): Restore {
  const proto = transportProto(rt);
  const undoMessage = patch(proto, 'handleMessage', (original) => function (this: Proto, raw: unknown) {
    const type = String((JSON.parse(String(raw)) as { type?: unknown }).type ?? '');
    if (type === 'input_audio_buffer.speech_started') {
      this.rt11BargeInAt = Date.now();
      this.rt11DropAudio = true;
      const world = currentWorld();
      // What the gateway would send on its Twilio socket (routes/stream.ts owns it).
      if (opts.clear && world?.twilio.socket) world.twilio.socket.send(JSON.stringify({ event: 'clear', streamSid: world.twilio.streamSid }));
    }
    if (type === 'response.created') this.rt11DropAudio = false;
    if (this.rt11DropAudio && (type === 'response.output_audio.delta' || type === 'response.audio.delta')) return undefined;
    return original.call(this, raw);
  });
  const undoCall = patch(proto, 'completeFunctionCall', (original) => async function (this: Proto, callId: unknown, name: unknown, argumentText: unknown) {
    if (!opts.dropLateResult) return original.call(this, callId, name, argumentText);
    const startedAt = Date.now();
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(argumentText || '{}')) as Record<string, unknown>;
    } catch {
      args = {};
    }
    const output = await (this.onFunctionCall as (n: unknown, a: unknown) => Promise<string>)(name, args);
    if (!(this.isOpen as () => boolean).call(this)) return undefined;
    const send = this.sendEvent as (event: Record<string, unknown>) => void;
    send.call(this, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    // The caller spoke over the turn that asked for it: the model's answer to them comes from their turn.
    if (typeof this.rt11BargeInAt === 'number' && this.rt11BargeInAt >= startedAt) return undefined;
    send.call(this, { type: 'response.create' });
    return undefined;
  });
  return () => {
    undoMessage();
    undoCall();
  };
}

/** S17 reference fix: speech the provider's VAD hears marks the caller heard. */
function referenceVadHeard(rt: RuntimeModules): Restore {
  return patch(watchdogProto(rt), 'callerSpeechStarted', (original) => function (this: Proto) {
    const result = original.call(this);
    this.heard = true;
    this.heardChecks = 0;
    return result;
  });
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
  's12-reference-fix': (rt) => referenceBargeIn(rt, { clear: true, dropLateResult: true }),
  's12-reference-fix-without-clear': (rt) => referenceBargeIn(rt, { clear: false, dropLateResult: true }),
  's12-reference-fix-without-late-result-drop': (rt) => referenceBargeIn(rt, { clear: true, dropLateResult: false }),
  's17-reference-fix': (rt) => referenceVadHeard(rt),
  'all-reference-fixes': (rt) => {
    const undo = [referenceBargeIn(rt, { clear: true, dropLateResult: true }), referenceVadHeard(rt)];
    return () => undo.forEach((fn) => fn());
  },
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
