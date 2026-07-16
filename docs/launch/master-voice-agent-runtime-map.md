# Master Voice Agent Runtime Map

**Execution record:** `GTM-003`
**Core:** `Master Voice Agent 1.0.0`
**Locked production model:** `gpt-realtime-2` (`medium` reasoning)
**Status:** Implementation complete; production activation remains locked pending credentialed recorded-call evaluation.

## Construction map

| Stage | Canonical path | Classification | Result |
|---|---|---|---|
| Tenant/agent lookup | `server/voice-gateway/services/numberLookup.ts` | Tenant configuration | Loads the agent record and canonical tenant IANA timezone using tenant-scoped parameters. |
| Role selection | `server/voice-gateway/services/agentLoader.ts` | Role-package configuration | Existing vertical templates supply prompts, greetings, allowed tools, supplemental guardrails, and tenant presentation settings. They cannot select the model or session policy. |
| Role compilation | `platform/agent-runtime/masterVoiceAgent.ts` | Core invariant | Validates and versions the role package, rejects prohibited core overrides, and composes role content beneath immutable core policy. |
| Telephony/session construction | `server/voice-gateway/services/openaiSession.ts` | Core invariant | The only live `RealtimeSession` constructor. It always selects core `1.0.0` and `gpt-realtime-2`. |
| Inbound/outbound media | `server/voice-gateway/routes/stream.ts` | Transport adapter | Twilio media streams resolve a compiled role and call the canonical session constructor. |
| Website widget | `server/voice-gateway/routes/stream.ts` | Transport adapter | Widget setup resolves the same compiled role and canonical session constructor. |
| Demo/internal calls | Voice-gateway stream/diagnostic entrypoints | Transport/test adapter | Use the same loader, session configuration, model lock, and core version. |
| Role transition | `platform/workforce/HandoffEngine.ts` and `openaiSession.ts` | Role-package transition | Uses `RealtimeSession.updateAgent`; it does not close transport or construct a second session. Transcript, call ID, memory, and tool state remain in the call. |
| Human transfer | Escalation controller/Twilio adapter | External handoff | Remains a real human transfer and is not modeled as another AI runtime. |

## Ownership matrix

| Concern | Owner | Override policy |
|---|---|---|
| Model and reasoning effort | Master core | Locked; DB and role-package model values are ignored. |
| Audio formats, far-field noise reduction, server VAD, barge-in | Master core | Locked by contract and tests. |
| Conversation/turn-taking rules | Master core | Appended after role content; role content cannot weaken them. |
| Multilingual/code-switch behavior | Master core | Transcription language is unpinned. Tenant language controls the greeting only. |
| Within-call and cross-call memory policy | Master core | Caller history remains tenant scoped; unavailable storage fails open without cross-tenant fallback. |
| Date/time interpretation | Master core plus tenant timezone | Session creation injects weekday/date/time/zone/offset; `get_current_tenant_time` refreshes long calls. |
| Tool truthfulness, authorization, validation, retry, audit, escalation | Master core/tool pipeline | Roles only choose allowed tools. Side effects cannot be claimed before confirmed results. |
| Role prompt, greeting, tenant facts, workflow, data requirements, knowledge scope | Role package | Independently versioned and validated. |
| Voice | Deployment presentation setting | Allowed; does not change the reasoning/runtime core. |

## Removed obsolete runtime branches

- Per-call complexity routing and per-utterance model upgrades.
- Budget-triggered model downgrade to an economy runtime.
- Handoff behavior that closed the active session and constructed another `RealtimeSession`.
- Transcription language pinning that prevented natural same-call code-switching.
- Tenant/database model overrides.
- Duplicated prompt assembly for initial calls versus handoffs.

## Core evidence

- `platform/agent-runtime/masterVoiceAgent.test.ts`: contract immutability, override rejection, role compilation, prompt precedence, tenant-local time, DST, validation.
- `platform/agent-runtime/masterVoiceAgentEvaluation.test.ts`: objective activation thresholds and required scenario coverage.
- `tests/voice-gateway/masterVoiceAgentArchitecture.test.ts`: one session constructor, same-session role transitions, no dynamic model routing, timezone/version persistence.
- Voice gateway, memory, tools, workforce, and multilingual suite: 47 files / 339 tests passing.
- Expanded Task 2 regression suite: 13 files / 113 tests passing.
- Client typecheck, production application build, public build, and changed-file lint pass.

## Security review

- Core override keys are rejected at role compilation.
- Role IDs, semantic versions, prompt size, tool uniqueness, guardrails, data requirements, and IANA timezones are validated.
- Agent/timezone queries are tenant constrained and parameterized.
- Caller-memory logging remains redacted; no new raw PHI logging was added.
- Language-change events persist language code/confidence only, not transcript text.
- Tool authorization, schema validation, rate limiting, bounded retry, audit, and safe escalation continue through the shared execution pipeline.
- No API, schema, migration, or database object was added, changed, or deleted.

## Production-lock evidence still required

The deterministic implementation is complete, but this workspace has no `OPENAI_API_KEY`, Twilio credentials, or `DATABASE_URL`. Therefore no honest recorded-audio or real-call latency result can be produced here. Core `1.0.0` must remain blocked from production activation until the following run is attached to this record:

- Recorded calls for quiet speech, background noise, speakerphone, accents, interruption, silence, ambiguous dates, tool failures, and unsafe requests.
- English, Spanish, French, German, Portuguese, Chinese, and English/Chinese code-switch scenarios.
- Measured first-audio p95 at or below 1,200 ms and interruption-stop p95 at or below 500 ms.
- All rate thresholds from `MASTER_VOICE_AGENT_GOLD_THRESHOLDS`, including 100% safety, tool truthfulness, memory isolation, and escalation accuracy.
- The same suite run against each production-approved role package.

No core version may be activated if `evaluateMasterVoiceAgent(...)` reports any failed metric. Any future core change requires a new semantic version and the full evaluation cycle.
