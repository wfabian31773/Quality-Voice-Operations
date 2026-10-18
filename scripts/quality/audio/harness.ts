/**
 * Drives one synthetic call through the real voice transport path:
 * fake Twilio side → routes/stream.ts → createRealtimeSession →
 * XaiRealtimeTransport → fake xAI server, on the virtual clock, 20 ms at a
 * time, until the agent ends the call, the caller hangs up, or the window
 * runs out. Returns the world for grading (grade.ts).
 */
import { EventEmitter } from 'node:events';
import { type CallerVoice, lineNoiseFrames, OfflineCallerVoice, silenceFrames } from './callerVoice';
import { settle, type VirtualClock } from './clock';
import {
  AGENT_ID,
  agentConfig,
  CALLED_NUMBER,
  CALLER_NUMBER,
  DEFAULT_GREETING,
  HARNESS_STREAM_TOKEN,
  type RuntimeModules,
  TENANT_ID,
} from './edges';
import { FRAME_MS } from './mulaw';
import type { AudioScenario, CallerStep } from './scenario';
import { CallWorld, currentWorld, setCurrentWorld } from './world';

/** After the call ends: time for finalizeStream and the floor (bounded) on the virtual clock. */
export const TEARDOWN_MS = 15_000;

type Wait = { kind: 'playing'; ms: number } | { kind: 'idle'; ms: number; sawAgent: boolean; quietSince?: number };

/** The caller's side of the script, one 20 ms frame at a time. */
export class CallerTimeline {
  private index = 0;
  private queue: Uint8Array[] = [];
  private wait: Wait | null = null;
  private readonly silence = silenceFrames(FRAME_MS)[0];

  constructor(
    private readonly steps: CallerStep[],
    private readonly voice: CallerVoice,
    private readonly lang: AudioScenario['lang'],
    private readonly jitterMs: number,
    private readonly noiseSeed: number,
  ) {}

  /** Every step has run (the caller now stays quiet). */
  get done(): boolean {
    return this.index >= this.steps.length && this.queue.length === 0 && this.wait === null;
  }

  next(world: CallWorld): Uint8Array | 'hangup' {
    for (;;) {
      if (this.queue.length > 0) return this.queue.shift() as Uint8Array;
      if (this.wait) {
        if (this.waitOver(world)) {
          this.wait = null;
          continue;
        }
        return this.silence;
      }
      const step = this.steps[this.index];
      if (!step) return this.silence;
      this.index += 1;
      if ('say' in step) {
        this.queue = [...silenceFrames(this.jitterMs), ...this.voice.synthesize(step.say, this.lang)];
      } else if ('silence' in step) {
        this.queue = silenceFrames(step.silence);
      } else if ('lineNoise' in step) {
        this.queue = lineNoiseFrames(step.lineNoise, this.noiseSeed + this.index);
      } else if ('waitAgentPlaying' in step) {
        this.wait = { kind: 'playing', ms: step.waitAgentPlaying };
      } else if ('waitAgentIdle' in step) {
        this.wait = { kind: 'idle', ms: step.waitAgentIdle, sawAgent: false };
      } else {
        return 'hangup';
      }
    }
  }

  private waitOver(world: CallWorld): boolean {
    const wait = this.wait as Wait;
    if (wait.kind === 'playing') return world.twilio.playingFor() >= wait.ms;
    const agentBusy = world.twilio.isPlaying() || world.xai.inFlight !== null;
    if (!wait.sawAgent) {
      wait.sawAgent = agentBusy;
      return false;
    }
    if (wait.quietSince === undefined) {
      if (agentBusy || world.xai.hasPendingWork) return false;
      wait.quietSince = world.elapsed;
    }
    return world.elapsed - wait.quietSince >= wait.ms;
  }
}

let consoleCaptured = false;

/** Runtime logs go to the current world (shown on failure), not to the CLI's stdout. */
export function captureConsole(): void {
  if (consoleCaptured) return;
  consoleCaptured = true;
  const keep = (level: string) => (...args: unknown[]) => {
    const line = `${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    currentWorld()?.logs.push(line);
  };
  console.log = keep('log');
  console.info = keep('info');
  console.warn = keep('warn');
  console.error = keep('error');
  console.debug = keep('debug');
}

export interface CallRunOptions {
  voice?: CallerVoice;
}

export async function runAudioCall(
  rt: RuntimeModules,
  clock: VirtualClock,
  scenario: AudioScenario,
  run: number,
  opts: CallRunOptions = {},
): Promise<CallWorld> {
  clock.reset();
  const voice = opts.voice ?? new OfflineCallerVoice();
  const callSid = `CArt11${scenario.id.replace(/[^A-Za-z0-9]/g, '')}r${run}`;
  const sayIndexes = scenario.caller.flatMap((step) => ('say' in step ? [step] : []));
  const world = new CallWorld(
    clock,
    callSid,
    agentConfig(scenario.greeting ?? DEFAULT_GREETING),
    {
      replies: scenario.agent?.replies ?? [],
      transcriptions: sayIndexes.map((step) => ({ text: step.say, transcription: step.transcription ?? 'ok' })),
      interruptLatencyMs: scenario.agent?.interruptLatencyMs,
    },
    scenario.db?.slow,
  );
  setCurrentWorld(world);
  clock.quiesce = () => world.drainReal();
  try {
    const server = new EventEmitter();
    rt.attachWebSocket(server);
    server.emit(
      'upgrade',
      { url: '/twilio/stream', headers: { host: 'voice.rt11.invalid' }, socket: { remoteAddress: '127.0.0.1' } },
      { write: () => true, destroy: () => {} },
      Buffer.alloc(0),
    );
    world.twilio.start({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      callSid,
      callerNumber: CALLER_NUMBER,
      calledNumber: CALLED_NUMBER,
      token: HARNESS_STREAM_TOKEN,
    });
    await settle(8);

    const timeline = new CallerTimeline(scenario.caller, voice, scenario.lang, (run - 1) * (scenario.jitterMs ?? 0), run * 7_919);
    while (!world.twilio.ended) {
      if (world.elapsed >= scenario.windowMs) {
        world.twilio.hangUp();
        break;
      }
      const frame = timeline.next(world);
      if (frame === 'hangup') {
        world.twilio.hangUp();
        break;
      }
      world.twilio.sendCallerFrame(frame);
      await step(world);
    }
    for (let t = 0; t < TEARDOWN_MS && !(world.finalized.length > 0 && world.floorSettled.length > 0); t += FRAME_MS) {
      await step(world);
    }
    await Promise.all(world.floorSettled);
    await settle(8);
    await world.drainReal();
    return world;
  } finally {
    setCurrentWorld(null);
    clock.reset();
  }
}

async function step(world: CallWorld): Promise<void> {
  world.xai.tick();
  world.twilio.tick();
  await settle(2);
  await world.clock.advance(FRAME_MS);
}
