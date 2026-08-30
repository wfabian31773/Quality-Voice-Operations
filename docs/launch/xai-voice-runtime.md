# QVO GTM Agent Core — xAI Voice Runtime

**Status:** Canonical architecture for the GTM agent core  
**Core version:** `2.0.0`  
**Provider:** xAI  
**Locked model:** `grok-voice-think-fast-2.0`  
**Public website / small-business positioning:** deferred. That work is last.

## North star

QVO ships one voice runtime and one tool library.

```
xAI Grok Voice Agent
  + one Master Voice Agent runtime
  + role package
  + selected tools from the shared library
  + tenant context
= deployed voice application
```

There is not a second OpenAI Realtime runtime. There is not a per-vertical engine. A new agent is a role package that chooses tools from the library. It cannot select a model, session policy, or transport.

## Locked core

| Concern | Owner | Value |
|---|---|---|
| Provider | Core | `xai` |
| Model | Core | `grok-voice-think-fast-2.0` pinned. Do not use `grok-voice-latest` in production. |
| Endpoint | Core | `wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0` |
| Auth | Core | `XAI_API_KEY` on the voice gateway. Browser/widget clients must not hold this key. |
| Audio | Core | Twilio Media Streams `g711` ↔ xAI `audio/pcmu` |
| Turn taking | Core | `server_vad`, threshold `0.5`, prefix `300ms`, silence `500ms`, barge-in on |
| Reasoning effort | Core | `none` for first-audio latency. `high` is reserved for a later core version. |
| Voice | Deployment setting | xAI voices `eve`, `ara`, `rex`, `sal`, `leo`. Legacy OpenAI names map onto this roster. |
| Tools | Library + role package | The role chooses names. The library executes them. |

Role packages may set prompt, greeting, allowed tools, knowledge scope, data requirements, and extra guardrails. They may not set `model`, `provider`, `session`, `turnDetection`, or `runtime`.

## Single constructor

Every live path uses one constructor:

`server/voice-gateway/services/openaiSession.ts` → `createRealtimeSession()` → `XaiRealtimeTransport` + `XaiVoiceSession`

Entrypoints:

- Twilio inbound/outbound media: `server/voice-gateway/routes/stream.ts`
- Website widget stream: same file, `/widget/stream`
- Diagnostics / canary: same session constructor

Telephony stays Twilio. xAI is the voice brain, not the carrier.

## Tool library

Canonical catalog: `platform/tools/library/catalog.ts`

GTM day-to-day tools:

| Tool | Work |
|---|---|
| `send_sms` | Twilio SMS + SMS inbox row |
| `send_email` | Platform email service |
| `create_ticket` | Staff-ready ticket |
| `create_booking` | Scheduling request |
| `create_dispatch_job` | Field job |
| `lookup_customer` | Caller / CRM lookup |
| `retrieve_knowledge` | Approved knowledge search |
| `escalate_to_human` | Human follow-up / transfer |
| `record_call_outcome` | Disposition |
| `get_current_tenant_time` | Tenant-local clock |
| `record_language_change` | Language transition audit |

Registration: `registerToolLibrary()` at voice-gateway and admin-api boot.

The first GTM role package is `core-receptionist@1.0.0`. It selects the tools above. Healthcare, dental, and other templates remain as retained role packages. They are not the launch offer.

## Truthfulness

A tool success means the library persisted or sent the side effect. It never means the underlying job is finished. Bookings are stored as `pending` with `booking_source = ai_agent`. Dispatch jobs are `pending`. Tickets are for staff review.

## GTM path on this core

1. Lock the xAI runtime and tool library (this document).
2. Prove `core-receptionist` with recorded gold-call evidence against xAI.
3. Keep Twilio, billing, Postgres, and admin consoles.
4. Only after the core is live, change the public website to small-business language.

Live gold-call activation still requires `XAI_API_KEY`, Twilio credentials, and a routed test number. Missing credentials fail closed.

## Code map

| Layer | Path |
|---|---|
| Core contract | `platform/agent-runtime/masterVoiceAgent.ts` |
| xAI session payload | `platform/agent-runtime/xaiSessionConfig.ts` |
| xAI WebSocket transport | `server/voice-gateway/services/xaiRealtimeTransport.ts` |
| One session constructor | `server/voice-gateway/services/openaiSession.ts` |
| Tool catalog | `platform/tools/library/catalog.ts` |
| Tool handlers | `platform/tools/library/handlers/` |
| GTM role | `platform/agent-templates/core-receptionist/` |
