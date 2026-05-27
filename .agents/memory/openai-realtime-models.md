---
name: OpenAI Realtime model whitelist
description: The Realtime API only accepts *-realtime-preview SKUs; passing a regular GPT model name opens the WS then errors out and the call goes silent.
---

OpenAI's Realtime API is a **separate model family** from the regular Chat Completions / Responses models. Only Realtime-family IDs are accepted: the current GA line `gpt-realtime` / `gpt-realtime-mini` (released Aug 2025) and the older `*-realtime-preview` SKUs. Passing a regular model ID — `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo`, etc. — gets a JSON error frame on the WebSocket:

```
{"type":"error","error":{"type":"invalid_request_error","code":"invalid_model",
 "message":"Model \"<name>\" is not supported in realtime mode."}}
```

**Why this hurts so much:** the WebSocket *opens successfully* and the Twilio↔OpenAI media bridge reports `Bidirectional media bridge established`. The error frame arrives, but downstream code may only log it — the call then sits with audio flowing one way (caller → us) and nothing coming back, until the silence-detection fallback kicks in (~17s here) and tears it down. The Twilio status callback reports `completed`, not `failed`, so it looks like a normal short call. From the caller's side: "the call connects but there's no voice." Easy to misdiagnose as audio codec, WebSocket auth, or TwiML problem.

**How to apply:**
- Any tier-to-model map used by the voice gateway (`TIER_MODEL_MAP` in `platform/billing/cost/providerRates.ts`) must contain *only* Realtime-eligible models. **Default to the current GA line** (`gpt-realtime` / `gpt-realtime-mini`) — QVO is a quality-voice product, so the new-call default should always be the newest available Realtime SKU, not a preview. Keep older preview IDs in `MODEL_RATES` only for back-compat with DB rows that still reference them. If a tier doesn't have a distinct Realtime SKU at the current GA size, alias it to the closest one rather than substituting a non-realtime model.
- Production defaults to swap when bumping the GA model: `TIER_MODEL_MAP` in `platform/billing/cost/providerRates.ts`, the `model = '...'` defaults in `server/admin-api/routes/agents.ts` (create + publish), the per-template fallbacks in `server/voice-gateway/services/agentLoader.ts`, `platform/marketplace/InstallationService.ts`, and the seed SQL in `platform/tenant/provisioning/TenantProvisioningService.ts` + `platform/assistant/PlatformAssistantService.ts`. Test fixtures with hard-coded model strings can stay on the legacy preview ID — they're DB-row mocks, not consumers of the default.
- When adding new tiers / model choices, the question is never "what's the cheapest GPT model" — it's "which Realtime SKU is right." Cost-rate entries can be added to `MODEL_RATES` independently for accounting; routing decisions are constrained by the Realtime whitelist.
- If you see `[WS_STREAM] Bidirectional media bridge established` immediately followed by `[OPENAI_SESSION] Realtime session error` with `invalid_model`, that's this bug — go fix the model string, not the bridge.
- Transcription models like `gpt-4o-mini-transcribe` are a **different surface** (input STT, not the Realtime LLM) and *are* valid where they're used. Don't confuse the two when searching/replacing model strings.
