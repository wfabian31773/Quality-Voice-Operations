---
name: QVO voice-agent globals
description: Two non-negotiable platform-wide layers that every QVO voice agent inherits — transport defaults and conversation principles. Never bypass.
---

QVO has two "global" layers that every voice agent (demo, template, DB-defined, generic fallback) must inherit. Both are intentionally locked — no per-agent override path exists, by design, because regressions on either side break the product as a salesman.

## Layer 1 — Transport defaults
`buildOpenAISessionConfig` (server/voice-gateway/services/openaiSession.ts) is the only builder for the OpenAI Realtime session config. Its input type accepts only `voice / language / model / reasoningEffort`. VAD type, noise reduction, turn-detection thresholds, audio format, transcription model, and barge-in flags are baked in and not overridable by agent config or DB row.

## Layer 2 — Conversation principles
`platform/agent-templates/voicePrinciples.ts` exports `VOICE_CONVERSATION_PRINCIPLES`. It is appended to every agent's system prompt by `agentLoader.finalize()`. Appending is idempotent (no-op if the marker `VOICE CONVERSATION PRINCIPLES` is already in the prompt) and happens AFTER the agent-specific instructions so it weights heavier.

**Why:** Realtime transport alone enables natural turn-taking; the model still has to choose to honor it. Without these principles, every prompt author has to remember "ask one question at a time, wait, don't monologue" — and most don't, which is what produced the original "agent kept talking and didn't wait" demo failure.

**How to apply:**
- Any new vertical template, DB code path, or user-built agent automatically gets both layers — do nothing special.
- NEVER add VAD / noise / turn-detection knobs to `OpenAISessionConfigInput` or any agent-config schema.
- NEVER duplicate the principles fragment inside a template's prompt builder — the loader appends it once.
- When tuning conversation quality based on a real bad call, edit `voicePrinciples.ts` ONCE; every agent benefits on the next call.
- Test invariant lives in `tests/agentLoader.voicePrinciples.test.ts` — covers all 8 templates + DB-defined + generic-fallback paths, and the idempotency guard.
