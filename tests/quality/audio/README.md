# Audio pack (RT-11): synthetic caller audio, pass^5

Text packs (RT-10) can't see audio failures (plan F13). This pack sends synthetic caller audio through the real voice transport path and grades the call on end state.

```
npx tsx scripts/quality/audio/run.ts                     # pass^5 over tests/quality/audio/scenarios
npx tsx scripts/quality/audio/run.ts --pass-k=5 --out=.ci-out/quality-audio-pass5.json
npx vitest run tests/quality/audio                        # pack, CLI exit codes, mutation proof, harness units
```

CI: `.github/workflows/quality-audio.yml`, nightly at 07:00 UTC, on demand, and on pull requests (the pack runs in a few seconds).

## What is real and what is fake

| Real (production code, loaded like production: `node --import tsx`, CJS) | Fake (the edges, `scripts/quality/audio/edges.ts`) |
|---|---|
| `routes/stream.ts`: Twilio media-stream handling, `mark` sending, `finalizeStream` | `ws`: the wire to a fake Twilio side and a fake xAI server |
| `openaiSession.ts`: silence watchdog, playback marks, invariants, floor | `platform/db`: records statements, returns no rows |
| `xaiRealtimeTransport.ts`, `phoneCallTeardown.ts`, `callInvariants.ts` | `callPersistence`: records events, states, outcome |
| | tenant agent row, open budget, a fixed barbershop agent config, no-op lifecycle coordinator |

- **Caller audio:** `OfflineCallerVoice` (`scripts/quality/audio/callerVoice.ts`) makes deterministic 8 kHz μ-law frames, 20 ms per Twilio `media` event: a band-limited voiced buzz with a syllable envelope, as long as the line. Silence and faint line hiss are there for diallers. `CallerVoice.synthesize(line, lang)` is where a real TTS would plug in. Only the offline voice exists: no network, no key, no env.
- **Fake xAI server** (`fakeXai.ts`): runs energy VAD on the audio the transport appends and honours the session's `turn_detection` (end of turn after `silence_duration_ms`, auto-response, interrupt). It maps the k-th caller utterance to the scenario's k-th reply, with the transcript the scenario gives, an empty one, or none. It says the quoted line of runtime instructions (greeting, silence prompt, goodbye), and streams audio 4x faster than real time, like the real model.
- **Fake Twilio** (`fakeTwilio.ts`): models the playback buffer. Agent audio plays in real time, a `mark` is echoed once the audio before it has played, and `clear` drops unplayed audio and echoes pending marks. So "what the caller heard" is graded.
- **Time:** a virtual clock replaces the global timers, `Date.now` and `new Date()`, so the 8 s, 15 s and 10-minute ladders run in milliseconds and every run is identical. Run r shifts the caller's timing by (r - 1) × `jitterMs`.

## Determinism on a loaded box

Nothing on a call's timeline may wait on real time:

- **Runtime `import()`.** The tool path (`await import('…/UsageRecorder')`) and stream.ts's DNC check use dynamic imports. Under `node --import tsx` these resolve asynchronously on the loader thread, in real time, while the clock keeps stepping. On a busy box S12's late tool result landed after the hangup (the 1-in-3 flake). The edge compiles each relative `import('./x')` in `server/`/`platform/` as `Promise.resolve().then(() => require('./x'))` (`edges.ts`): it's the same module from the require cache, resolved in one microtask.
- **Real I/O in an edge** goes through `CallWorld.trackReal(promise)`. The clock doesn't advance until it settles.
- **Env:** `installEdges` clears the process env to `HARNESS_ENV` (`TZ=UTC`) before the runtime loads. The CLI on a CI runner and the vitest-spawned child therefore see the same env.

`tests/quality/audio/stress.ts` proves it. It runs the pass^5 gate with the loader thread slowed (every runtime `import()` waits 1 s), the event loop starved (busy-waits) and real I/O in the DB edge. `audio.test.ts` checks three things:

- the stressed report is identical to an idle run, every observation included;
- the same stress with `--keep-dynamic-imports` (the old harness) reproduces the flake;
- a polluted env (another TZ, `CI`, `NODE_ENV`, the test process env) gives the identical report.

```
node --import tsx tests/quality/audio/stress.ts [--keep-dynamic-imports] [--loader-delay-ms=N]
```

## Scenarios

| File | Plan | Status on today's runtime |
|---|---|---|
| `s03-dialler-never-heard.yaml` | S03 | **core, 5/5**: `never_heard`, 3 prompts ~8 s after each mark echo, goodbye played in full, no floor ticket, nothing written |
| `s12-barge-in.yaml` | S12 | **known red** `barge-in-runtime-gap`: no Twilio `clear` (the caller hears ~3 s more of the interrupted line), and the late tool result starts a second answer |
| `s17-audible-never-transcribed.yaml` | S17 | **known red** `vad-heard-runtime-gap`: "heard" needs a transcript, so an audible caller gets the never-heard ladder and is cut during a 30 s pause |

A known-red scenario carries `expectedFail` + `pinned`, like the vertical1 pack. It is not `core`, and every run must fail on exactly the pinned checks. An unexpected pass or any other failure turns the gate red. When the runtime guard lands, drop `expectedFail`/`pinned` and tag it `core`.

## Mutation proof

`tests/quality/audio/mutants.ts` applies in-memory overrides in the harness process; no runtime file is edited. `audio.test.ts` asserts:

- the ladder skipping a prompt → S03 0/5;
- silence counted from `response.done` instead of the mark echo → S03 0/5;
- a reference barge-in guard (`clear`, plus dropping the interrupted turn and its late tool result) → S12 passes 5/5. The gate flags the unexpected pass. Without its `clear` or without the late-result drop, a different check fails;
- VAD speech marking the caller heard → S17 passes 5/5, and S03 still passes;
- with all reference guards in place, all three pass 5/5.
