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
| `openaiSession.ts`: silence watchdog, playback marks, invariants, floor, the bookkeeping queue | `platform/db`: records statements, returns no rows |
| `xaiRealtimeTransport.ts`, `phoneCallTeardown.ts`, `callInvariants.ts`, `contractToolBridge.ts` + `platform/actions` (the composed agent's reads) | `callPersistence`: records events, states (a state + event pair as both), outcome |
| | tenant agent row, open budget, a fixed composed barbershop agent config, no-op lifecycle coordinator |

- **Caller audio:** `OfflineCallerVoice` (`scripts/quality/audio/callerVoice.ts`) makes deterministic 8 kHz μ-law frames, 20 ms per Twilio `media` event: a band-limited voiced buzz with a syllable envelope, as long as the line. Silence and faint line hiss are there for diallers. `CallerVoice.synthesize(line, lang)` is where a real TTS would plug in. Only the offline voice exists: no network, no key, no env.
- **Fake xAI server** (`fakeXai.ts`): runs energy VAD on the audio the transport appends and honours the session's `turn_detection` (end of turn after `silence_duration_ms`, auto-response, interrupt). It maps the k-th caller utterance to the scenario's k-th reply, with the transcript the scenario gives, an empty one, or none. It says the quoted line of runtime instructions (greeting, silence prompt, goodbye), and streams audio 4x faster than real time, like the real model.
- **Fake Twilio** (`fakeTwilio.ts`): models the playback buffer. Agent audio plays in real time, a `mark` is echoed once the audio before it has played, and `clear` drops unplayed audio and echoes pending marks. So "what the caller heard" is graded.
- **Time:** a virtual clock replaces the global timers, `Date.now` and `new Date()`, so the 8 s, 15 s and 10-minute ladders run in milliseconds and every run is identical. Run r shifts the caller's timing by (r - 1) × `jitterMs`. Each run in a process starts 2 h after the previous one on the wall clock (`RUN_SPACING_MS`), so process-wide per-tenant windows (the tool rate limit, 30 a minute) start fresh for every synthetic call, as they would for separate real calls; observations are relative to the run's start.
- **Tools:** a scenario's tool is either the runtime's `get_current_tenant_time` (no DB work in its action) or the composed agent's `scheduling_list_services`, a real `platform/actions` read whose own catalog query `db.slow` can make slow. Since RT-HOLD-LINE part 2 the bookkeeping writes are off the tool's critical path, so a slow tool is made slow by its own query (`FROM scheduling_appointment_types`), not by `INSERT INTO tool_invocations`.

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

| File | Plan | Status |
|---|---|---|
| `s03-dialler-never-heard.yaml` | S03 | **core, 5/5**: `never_heard`, 3 prompts ~8 s after each mark echo, goodbye played in full, no floor ticket, nothing written |
| `s12-barge-in.yaml` | S12 | **core, 5/5**: the caller talks over "let me check" while Twilio still holds ~3 s of it. One Twilio `clear` at the barge-in, nothing of that line audible after it, and the slow tool result that lands meanwhile is handed to the model without a response of its own: one answer, to the barge-in |
| `s12-barge-in-mid-stream.yaml` | S12 | **core, 5/5**: the caller talks over a long answer the model is still streaming, and the provider's cancel lands 200 ms late (`agent.interruptLatencyMs`), so deltas keep coming after the `clear`. The gateway drops them: nothing of the interrupted turn is audible after the barge-in |
| `s12-backchannel-during-tool.yaml` | S12 | **core, 5/5**: once "let me check" has played, the caller says "okay, thanks" while a slow lookup runs. Server VAD answers that before the tool output is in the conversation, and the result lands while that reply is in flight. It starts no second response then, and is voiced exactly once after that reply is done (`toolResultsVoiced: 1`, no provider error) |
| `s17-audible-never-transcribed.yaml` | S17 | **core, 5/5**: VAD hears every utterance, the transcriber returns nothing. The caller is heard anyway (an utterance of at least 300 ms): one check at 15 s per pause, never cut, `caller_hangup`, the floor files nothing |
| `s18-slow-tool-hold-line.yaml` | S18 (RT-HOLD-LINE) | **core, 5/5**: the model calls a lookup with no words first and the tool takes 2 s. The runtime's hold line ("One moment while I check that.") is asked for 0.7-1.0 s after the tool call, once, before the result, and heard in full; the answer waits for it (no overlapping response, no provider error) |
| `s18-fast-tool-no-hold-line.yaml` | S18 (RT-HOLD-LINE) | **core, 5/5**: the same call with a 300 ms tool: the answer and no hold line, before or after it |

`fixtures/timing/` holds report fixtures, not gate scenarios. `audio.test.ts` runs them at 250 ms per DB statement on this PR's path and on the older ones (mutants `bookkeeping-inline`, `part1-path` = 31996d53, `a3d2a94c-path`), and prints the per-tool timings: tool call → result sent, → first agent audio heard, → answer heard.
- `s18-timing-db-250ms.yaml`: `get_current_tenant_time`, whose action does no DB work, so tool call → result sent is the bookkeeping on the inline paths. It must be under 1000 ms (it is 0; 3000 inline).
- `s18-catalog-cache-db-250ms.yaml`: `scheduling_list_services` twice in one call. The repeat is served from the call cache: one catalog read reaches the DB, and there are still two tool rows.

A scenario the runtime can't pass yet can carry `expectedFail` + `pinned`, like the vertical1 pack. It is not `core`, and every run must fail on exactly the pinned checks. An unexpected pass or any other failure turns the gate red. When the runtime guard lands, drop `expectedFail`/`pinned` and tag it `core`. None is known red today.

## Mutation proof

`tests/quality/audio/mutants.ts` removes one runtime guard at a time with an in-memory override in the harness process; no runtime file is edited. `audio.test.ts` asserts that only the guarded scenario goes red:

- the ladder skipping a prompt → S03 0/5;
- silence counted from `response.done` instead of the mark echo → S03 0/5;
- no Twilio `clear` on barge-in (`SilenceWatchdog.interruptAgentAudio`) → both S12 scenarios 0/5 on `barge_in.clear` + `barge_in.stale_audio`;
- the interrupted turn's late deltas not dropped (`XaiRealtimeTransport.dropInterruptedAudio`) → S12 mid-stream 0/5 on `barge_in.stale_audio`;
- a tool result the caller spoke over starts its own response (`XaiRealtimeTransport.callerSpokeSince`) → S12 0/5 on `barge_in.answers` + `barge_in.late_tool_result` (S12 backchannel stays green: since RT-HOLD-LINE its `response.create` waits behind the in-flight reply to "thanks");
- no one-response-at-a-time guard in the transport (`XaiRealtimeTransport.responseBusy`) → S12 backchannel 0/5 on `tool_result.voiced`: the create lands on the in-flight reply, is rejected, re-sent once, rejected again (never a loop);
- the hold line's deadline does nothing (`HoldLine.onDeadline`) → S18 slow 0/5 on `hold_line.count`;
- the hold line no longer knows the result came back first (`HoldLine.toolEnded` + `HoldLine.agentAudioStarted`: the tool's end and the answer's audio each keep a fast tool quiet on their own, so both go) → S18 fast 0/5 on `hold_line.count` + `hold_line.after_result` (and S12 backchannel, whose "let me check" it no longer hears);
- a withheld tool result is never voiced on its own (`XaiRealtimeTransport.voiceWithheldResult`) → S12 backchannel 0/5 on `tool_result.voiced`: the confirmation is never spoken;
- "heard" needs a transcript again (`SilenceWatchdog.isAudibleSpeech`) → S17 0/5: never-heard prompts every 8 s, cut mid-pause, `never_heard`;
- a tool call waits for its bookkeeping writes again (`BookkeepingQueue.onCriticalPath` → `settled()`) → the timing fixture's tool call → result sent is 3000 ms, so its < 1000 ms assertion fails;
- no call cache for call-stable reads (`ContractToolBridge.readCacheKey`) → the catalog fixture reads the DB twice.
