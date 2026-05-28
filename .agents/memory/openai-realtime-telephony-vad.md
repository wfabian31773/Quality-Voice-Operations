---
name: OpenAI Realtime VAD config for telephony
description: Use server_vad (not semantic_vad) for Twilio narrowband calls, and always set noiseReduction — the SDK defaults are tuned for browser-quality audio and feel "deaf" on phones.
---

The `@openai/agents-realtime` SDK exposes turn detection via `audio.input.turnDetection` and offers two modes — `semantic_vad` and `server_vad`. The defaults are tuned for browser microphones (24kHz, clean) and behave badly when the audio source is a Twilio phone call (8kHz g711_μlaw, lossy, often speakerphone / car / background noise).

**Symptom when you get it wrong:** the call connects, the WS handshakes, audio flows both ways, but the agent feels "deaf." Callers say "Hello? Hello?" and the agent only responds 3–4 seconds later, or talks over them, or never answers at all. It looks like a turn-detection bug because it *is* one — the VAD config is wrong for the audio characteristics.

**Why `semantic_vad` is the wrong default for phone calls:** semantic VAD runs a prosody-analysis model that scores end-of-turn probability from the audio. That model is trained on full-band 24kHz speech. On 8kHz narrowband μ-law, the prosodic cues it relies on (pitch contours, breath sounds, micro-pauses) are largely gone, so it stalls until the `eagerness` ceiling fires (`low`=8s, `medium`/`auto`=4s, `high`=2s). Even at `high`, it's slower than `server_vad` and prone to misclassifying line noise as continued speech.

**Why `server_vad` is right for phone calls:** it's a per-frame energy detector — deterministic, no model pass, latency-free. It's exactly what you want when (a) the audio is already low-fidelity, (b) the channel quality varies call-to-call, and (c) you want predictable behavior. Twilio's own reference integrations all use `server_vad`.

**The full telephony-tuned config the SDK accepts:**
```ts
audio: {
  input: {
    format: 'g711_ulaw',
    noiseReduction: { type: 'far_field' }, // SDK preset for distant / speakerphone audio; runs server-side before VAD
    turnDetection: {
      type: 'server_vad',
      threshold: 0.5,            // 0.0–1.0; OpenAI default. Lower picks up soft voices but false-triggers on hiss.
      prefixPaddingMs: 300,      // audio captured *before* VAD trips, so first phoneme isn't clipped
      silenceDurationMs: 500,    // end-of-turn after this much silence. 200ms = interrupts user, 1000ms = sluggish
      // idleTimeoutMs: do NOT set this if you already have a local
      // silence watchdog (we have a 15s `silenceTimer` in
      // openaiSession.ts that calls reasoningEngine.handleSilence()).
      // The server idle timer fires first → generic re-prompt; then
      // the local watchdog fires → context-aware prompt; the model
      // ends up re-asking the same question twice while the caller
      // is still trying to answer. Pick one source of truth.
      createResponse: true,      // auto-create response on end-of-turn
      interruptResponse: true,   // barge-in: cancel in-flight response when caller starts talking
    },
  },
},
```

**Why:** these are the values OpenAI's own telephony quickstarts use, validated against the Twilio Media Streams audio profile (8kHz μ-law mono, ~20ms frames). They're a starting point, not a constant — if a tenant's callers are all in a quiet office, dropping `silenceDurationMs` to 300 makes the agent feel snappier; if callers are mostly mobile-in-car, raising the threshold to 0.6 helps.

**How to apply:**
- The SDK accepts camelCase (`turnDetection`, `noiseReduction`, `prefixPaddingMs`, etc.) and converts to snake_case on the wire. Either spelling works (`buildTurnDetectionConfig` in `openaiRealtimeBase.js` handles both), but stay consistent with camelCase to match the SDK's TypeScript types.
- The SDK's `DEFAULT_OPENAI_REALTIME_SESSION_CONFIG` sets `noiseReduction: null` and a bare `{ type: 'semantic_vad' }` — both wrong for phone calls. Always override both fields in `buildOpenAISessionConfig` for telephony agents.
- Single source of truth: `buildOpenAISessionConfig` in `server/voice-gateway/services/openaiSession.ts`. Both the initial session and the handoff session run through it, so editing it once fixes both surfaces.
- If you ever route a non-telephony surface (e.g. the embedded web widget, where the browser sends 24kHz Opus) through the same code path, gate the VAD choice on the format — `semantic_vad` may actually be the better pick there. Don't blanket-apply the telephony values.
- Check `node_modules/@openai/agents-realtime/dist/clientMessages.d.ts` for the current shape of `RealtimeSessionConfigDefinition` when the SDK is upgraded; OpenAI keeps adding new audio knobs (e.g. `audio.output.speed`) and the typings are the cleanest source.
