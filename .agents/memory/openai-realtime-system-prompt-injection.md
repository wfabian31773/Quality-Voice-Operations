---
name: System-driven prompts in OpenAI Realtime — never use role:'user'
description: To make the Realtime model say or do something mid-call (greeting, recovery, safety override), use response.create with response.instructions — never wrap a `[System: ...]` string in a conversation.item.create with role:'user'.
---

The Realtime API only accepts `role: 'user' | 'assistant'` on `conversation.item.create` of type `message`. There is no `role: 'system'` for items. People (and we, in an earlier rev) reach for the pattern:

```ts
sendEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[System: Say exactly: "${greeting}"]` }] } });
sendEvent({ type: 'response.create' });
```

**Why this is wrong:** the model treats every entry in the conversation array as either the caller talking (`user`) or the agent talking (`assistant`). Wrapping a system instruction in `role: 'user'` makes the model believe the *caller* literally said the words `[System: Say exactly: ...]`. It then generates a response *to* that fake utterance. Worse, the fake user turn persists in history — so every subsequent response is generated against a conversation that includes phantom caller turns. When you have multiple injection sites (greeting + silence recovery + safety override + handoff), the model loses track of which turns were real, gets stuck in a single intent (e.g. asking the caller's name), and re-asks the same question on every tick while the caller is trying to answer.

**Correct pattern — `response.instructions` override:**

```ts
sendEvent({
  type: 'response.create',
  response: { instructions: 'Greet the caller now by saying exactly: "Hi, how can I help?". Do not say anything else.' },
});
```

`response.instructions` replaces the session-level instructions for *that one response only*, then reverts. Nothing is added to the conversation array. The model produces the desired output without ever seeing a phantom user turn.

**How to apply:**
- Every site that wants to make the model say or do something out-of-band (initial greeting, handoff greeting, silence recovery, safety override, clarifying question, "say exactly X" admin messages) must use `response.create` + `response.instructions`. The voice-gateway codifies this as `sendModelInstruction(text)` in `server/voice-gateway/services/openaiSession.ts`.
- Reserve `conversation.item.create` with `role: 'user'` for cases where the text genuinely *is* what the caller said (e.g. the widget's text-input fallback channel where typed messages should be treated as caller utterances).
- If you ever need to inject persistent memory (e.g. a compression summary that the model should *remember* but not *speak*), that's a third pattern — `session.update` with revised `instructions`, not a conversation item. Treat that as a separate primitive.
- The SDK's `RealtimeSession.sendMessage(message, { triggerResponse })` wraps the same pattern but bakes in a real user-role item; only use it for actual caller-side text.
