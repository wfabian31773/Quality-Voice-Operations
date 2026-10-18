/**
 * RT-11 harness parts, in process: μ-law, the offline caller voice, the
 * provider VAD, the virtual clock, the Twilio playback model, the scenario
 * loader and the pinned-status rule. No runtime code is loaded here.
 */
import { describe, expect, it } from 'vitest';
import { lineDurationMs, lineNoiseFrames, OfflineCallerVoice, silenceFrames } from '../../../scripts/quality/audio/callerVoice';
import { settle, VirtualClock } from '../../../scripts/quality/audio/clock';
import { FakeTwilioCall } from '../../../scripts/quality/audio/fakeTwilio';
import { statusOf } from '../../../scripts/quality/audio/gate';
import { FRAME_BYTES, FRAME_MS, frameRms, linearToMulaw, MULAW_SILENCE, mulawToLinear } from '../../../scripts/quality/audio/mulaw';
import { parseAudioArgs } from '../../../scripts/quality/audio/run';
import { parseAudioScenario, type AudioScenario } from '../../../scripts/quality/audio/scenario';
import { DEFAULT_VAD_RMS, EnergyVad, type VadEvent } from '../../../scripts/quality/audio/vad';
import { CallWorld } from '../../../scripts/quality/audio/world';

describe('μ-law (G.711)', () => {
  it('round-trips within the codec step and encodes silence as 0xff', () => {
    expect(MULAW_SILENCE).toBe(0xff);
    for (const sample of [0, 1, -1, 100, -100, 1_000, -1_000, 8_000, -8_000, 32_000, -32_000]) {
      const back = mulawToLinear(linearToMulaw(sample));
      expect(Math.abs(back - sample)).toBeLessThanOrEqual(Math.max(8, Math.abs(sample) * 0.07));
    }
    expect(linearToMulaw(1_000)).not.toBe(linearToMulaw(-1_000));
  });
});

describe('offline caller voice', () => {
  const voice = new OfflineCallerVoice();

  it('is deterministic, 20 ms frames, as long as the line', () => {
    const a = voice.synthesize('Hi, what time do you close on Saturday?', 'en');
    const b = voice.synthesize('Hi, what time do you close on Saturday?', 'en');
    expect(a.every((frame) => frame.length === FRAME_BYTES)).toBe(true);
    expect(a.map((f) => Buffer.from(f).toString('base64'))).toEqual(b.map((f) => Buffer.from(f).toString('base64')));
    expect(a.length * FRAME_MS).toBe(lineDurationMs('Hi, what time do you close on Saturday?'));
    expect(voice.synthesize('Hola, ¿tienen algo el viernes?', 'es')).not.toEqual(a);
  });

  it('speech is well above the VAD level; silence and line noise are well under it', () => {
    const speech = voice.synthesize('I need a fade on Friday at nine', 'en');
    const loud = speech.slice(3, -3).map(frameRms);
    expect(Math.min(...loud)).toBeGreaterThan(DEFAULT_VAD_RMS * 2);
    expect(Math.max(...silenceFrames(200).map(frameRms))).toBe(0);
    expect(Math.max(...lineNoiseFrames(2_000, 7).map(frameRms))).toBeLessThan(DEFAULT_VAD_RMS / 4);
  });
});

describe('provider VAD', () => {
  const run = (frames: Uint8Array[]) => {
    const vad = new EnergyVad({ silenceDurationMs: 500 });
    return frames.flatMap((frame) => vad.push(frame));
  };

  it('one line = one utterance: starts on the speech, stops 500 ms after it', () => {
    const line = new OfflineCallerVoice().synthesize('Actually, can I just book a fade for Friday at nine?', 'en');
    const events = run([...silenceFrames(400), ...line, ...silenceFrames(1_000)]);
    expect(events.map((e) => e.type)).toEqual(['speech_started', 'speech_stopped']);
    const [start, stop] = events as [VadEvent, VadEvent];
    expect(start.audioMs).toBe(400);
    expect(stop.audioMs).toBe(400 + line.length * FRAME_MS + 500);
  });

  it('never fires on an open line with hiss (S03 dialler)', () => {
    expect(run(lineNoiseFrames(30_000, 11))).toEqual([]);
  });
});

describe('virtual clock', () => {
  it('fires timers in time order, intervals repeat, cleared timers never fire, Date.now follows', async () => {
    const clock = new VirtualClock();
    const fired: string[] = [];
    clock.install();
    try {
      setTimeout(() => fired.push(`b@${clock.elapsed}`), 200);
      setTimeout(() => fired.push(`a@${clock.elapsed}`), 100);
      const cancelled = setTimeout(() => fired.push('never'), 150);
      clearTimeout(cancelled);
      const every = setInterval(() => fired.push(`i@${clock.elapsed}`), 80);
      await clock.advance(250);
      clearInterval(every);
      await clock.advance(1_000);
      expect(fired).toEqual(['i@80', 'a@100', 'i@160', 'b@200', 'i@240']);
      expect(Date.now()).toBe(clock.epochMs + 1_250);
    } finally {
      clock.uninstall();
    }
    // Uninstalled: the real timers are back.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    await settle();
  });

  it('what real work unblocks runs before the clock moves, even when the work settled just before the advance', async () => {
    // The #131 stress flake: the last call-setup query settled right before a step's advance, and the
    // fake xAI socket's open (one event-loop turn later) landed after it, so session.update went out at 20.
    const clock = new VirtualClock();
    const world = new CallWorld(clock, 'CAunitdrain', {}, { replies: [], transcriptions: [] });
    clock.quiesce = () => world.drainReal();
    const opened: number[] = [];
    const io = world.trackReal(Promise.resolve());
    void io.then(() => setImmediate(() => opened.push(clock.elapsed)));
    await io;
    await clock.advance(FRAME_MS);
    expect(opened).toEqual([0]);
  });
});

describe('Twilio playback model', () => {
  function call() {
    let now = 0;
    const tags = new Map<string, number>();
    const twilio = new FakeTwilioCall(() => now, (b64) => tags.get(b64), 'CAunit');
    const sent: Array<Record<string, unknown>> = [];
    const socket = twilio.attach();
    socket.on('message', (data: Buffer) => sent.push(JSON.parse(data.toString()) as Record<string, unknown>));
    const media = (response: number, frame: number) => {
      const bytes = Buffer.alloc(FRAME_BYTES, frame + 1);
      bytes[0] = response;
      const payload = bytes.toString('base64');
      tags.set(payload, response);
      socket.send(JSON.stringify({ event: 'media', streamSid: twilio.streamSid, media: { payload } }));
    };
    return { twilio, socket, sent, media, at: (t: number) => { now = t; } };
  }

  it('plays queued audio in real time and echoes a mark once it has played', () => {
    const c = call();
    for (let i = 0; i < 50; i += 1) c.media(1, i); // 1 s of audio, sent at once
    c.socket.send(JSON.stringify({ event: 'mark', mark: { name: 'agent-turn-1' } }));
    c.at(500);
    c.twilio.tick();
    expect(c.twilio.isPlaying()).toBe(true);
    expect(c.sent).toEqual([]);
    c.at(1_000);
    c.twilio.tick();
    expect(c.sent).toEqual([expect.objectContaining({ event: 'mark', mark: { name: 'agent-turn-1' } })]);
    expect(c.twilio.audibleMsAfter(1, 0)).toBe(1_000);
  });

  it('clear drops the unplayed audio and echoes pending marks at once', () => {
    const c = call();
    for (let i = 0; i < 100; i += 1) c.media(2, i); // 2 s
    c.socket.send(JSON.stringify({ event: 'mark', mark: { name: 'agent-turn-2' } }));
    c.at(600);
    c.socket.send(JSON.stringify({ event: 'clear', streamSid: c.twilio.streamSid }));
    expect(c.sent).toEqual([expect.objectContaining({ event: 'mark', mark: { name: 'agent-turn-2' } })]);
    expect(c.twilio.audibleMsAfter(2, 600)).toBe(0);
    expect(c.twilio.audibleMsAfter(2, 0)).toBe(600);
    expect(c.twilio.responseAudibleAt(700)).toBeUndefined();
    expect(c.twilio.responseAudibleAt(700, true)).toBe(2);
  });
});

describe('scenario format and pinned status', () => {
  const base = {
    id: 'x',
    plan: 'S03',
    title: 't',
    tags: ['audio'],
    lang: 'en',
    windowMs: 1_000,
    caller: [{ silence: 100 }],
    expect: { outcome: 'never_heard' },
  };

  it('rejects unknown keys, bad steps, and expectedFail without pinned checks', () => {
    expect(() => parseAudioScenario({ ...base, extra: 1 }, 'x.yaml')).toThrow(/unknown scenario key/);
    expect(() => parseAudioScenario({ ...base, expect: { outcom: 'x' } }, 'x.yaml')).toThrow(/unknown expect key/);
    expect(() => parseAudioScenario({ ...base, caller: [{ say: 'hi', silence: 5 }] }, 'x.yaml')).toThrow(/exactly one/);
    expect(() => parseAudioScenario({ ...base, caller: [{ say: 'hi', transcription: 'maybe' }] }, 'x.yaml')).toThrow(/transcription/);
    expect(() => parseAudioScenario({ ...base, expectedFail: 'gap' }, 'x.yaml')).toThrow(/pinned/);
    expect(parseAudioScenario({ ...base, caller: [{ say: 'hi', transcription: 'empty' }] }, 'x.yaml').caller).toHaveLength(1);
  });

  it('expected_fail only on exactly the pinned keys; anything else is failed or unexpected_pass', () => {
    const red = parseAudioScenario({ ...base, expectedFail: 'gap', pinned: ['outcome', 'ended_by'] }, 'x.yaml') as AudioScenario;
    const f = (key: string) => ({ key, message: key });
    expect(statusOf(red, [f('ended_by'), f('outcome')])).toBe('expected_fail');
    expect(statusOf(red, [f('outcome')])).toBe('failed');
    expect(statusOf(red, [f('outcome'), f('ended_by'), f('floor')])).toBe('failed');
    expect(statusOf(red, [])).toBe('unexpected_pass');
    const green = parseAudioScenario(base, 'x.yaml');
    expect(statusOf(green, [])).toBe('passed');
    expect(statusOf(green, [f('outcome')])).toBe('failed');
  });

  it('CLI args: pass-k, only, out, dir; unknown flags are an error', () => {
    expect(parseAudioArgs([])).toMatchObject({ k: 5, json: false });
    expect(parseAudioArgs(['--pass-k=3', '--only=a,b', '--out=.ci-out/x.json', '--json'])).toMatchObject({ k: 3, only: ['a', 'b'], out: '.ci-out/x.json', json: true });
    expect(() => parseAudioArgs(['--pass-k=0'])).toThrow(/pass-k/);
    expect(() => parseAudioArgs(['--mode=llm'])).toThrow(/unknown argument/);
  });
});
