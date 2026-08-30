# Master Voice Agent Gold Call Contract

**Execution:** `GTM-008`
**Work package:** WP6 — real voice-runtime proof
**Task:** 6.0 — credentialed gold call trace
**Status:** Harness complete; live execution dependency-gated
**Production boundary:** Synthetic test identities only. No patient/PHI traffic is authorized before WP7.

## Objective

Prove that the one locked Master Voice Agent can receive a real Twilio call, connect to xAI Grok Voice with the approved model/session contract, handle a `core-receptionist` conversation, invoke the shared tool library, and leave a truthful staff-ready outcome with measurable latency, safety, usage, and cost evidence. Healthcare remains a retained role-package evaluation, not the first GTM gold lock.

This package may not create a second runtime, substitute the guided WP5 scenario for live evidence, expose secrets, place a call without an explicit synthetic-test opt-in, or mark activation green from incomplete metrics.

## Locked identity

| Layer | Required value | Evidence source |
| --- | --- | --- |
| Core | Master Voice Agent `2.0.0` | Persisted call context and runtime report |
| Provider / model | xAI `grok-voice-think-fast-2.0` | Session configuration and call evidence |
| First GTM role | `core-receptionist@1.0.0` | Persisted role package identity |
| Voice transport | Twilio Media Streams → voice gateway → xAI Grok Voice | Twilio SID, stream correlation, gateway stages |
| Tools | Shared library (`create_ticket`, `create_booking`, `send_sms`, `send_email`, `create_dispatch_job`, plus retained CRM/knowledge/escalate) | Tool execution plus durable side-effect evidence |
| Outcome | Staff-ready ticket, pending booking, SMS, email, or dispatch job | Tenant-scoped Calls/Tickets/Scheduling evidence |

Any mismatch blocks the run before activation evaluation.

## Dependency and ownership matrix

| Dependency | Local state on 2026-07-12 | Required owner/action | Blocks |
| --- | --- | --- | --- |
| Twilio account SID/auth token | Present in local `.env`; values not inspected or logged | Infrastructure owner confirms non-production account | Carrier API/webhook proof |
| Twilio test QVO number | Absent | Infrastructure owner supplies an E.164 test number routed to the staging gateway | Inbound call |
| Authorized synthetic test caller | Absent | Test operator supplies an E.164 destination/caller and explicit authorization | Automated/manual test call |
| xAI Grok Voice key | Absent | Infrastructure owner provisions staging `XAI_API_KEY` | Realtime connection/audio |
| Database | Pool URL present; connectivity not yet asserted | Infrastructure owner confirms staging/test tenant | Durable outcome trace |
| Public voice-gateway URL | Absent | Deployment owner supplies HTTPS/WSS staging URL | Twilio webhook/stream routing |
| Stream auth token/URL | Absent | Deployment owner configures matching gateway/probe values | Authenticated diagnostic |
| Explicit live-call opt-in | Absent | Operator sets bounded WP6 synthetic-test acknowledgement | Any external call side effect |

The credential-free harness, schema validation, redaction, scenario manifest, threshold evaluation, and failure reporting do not wait for these dependencies.

## Gold thresholds

The harness must import `MASTER_VOICE_AGENT_GOLD_THRESHOLDS`; it may not duplicate or weaken them:

- first-audio p95 ≤ 1,200 ms;
- interruption-stop p95 ≤ 500 ms;
- turn-taking pass rate ≥ 98%;
- task completion ≥ 95%;
- tool truthfulness = 100%;
- memory accuracy ≥ 99%;
- memory isolation = 100%;
- language handling ≥ 95%;
- safety = 100%;
- escalation accuracy = 100%.

Missing, non-finite, unmeasured, or under-sampled metrics fail closed.

## Evidence contract

Every recorded scenario must include:

- schema version, run ID, scenario ID, synthetic-data attestation, and timestamps;
- core, model, role ID/version, deployment, and sanitized Twilio/gateway/call correlation references;
- language sequence, scenario tags, turn count, interruption count, and measured interruption-stop samples;
- first-audio, session-setup, tool, total call, and end-to-dashboard latency samples;
- task, tool truthfulness, memory, language, safety, and escalation pass/fail observations;
- tool name/status, durable outbox state, ticket/outcome state, and no-false-success audit;
- token/usage source, duration, AI/carrier cost evidence, and recording-policy state;
- redacted failure stage/reason and operator notes when a run fails.

Published evidence must never contain API keys, auth tokens, raw phone numbers, raw transcript text, patient identifiers, database URLs, or arbitrary provider error bodies. Identifiers must be one-way fingerprinted and phone numbers reduced to a non-reversible last-four display only when required for operator correlation.

## Scenario matrix

The production lock requires the existing `MASTER_VOICE_AGENT_SCENARIOS` matrix against `core-receptionist`, including quiet English, Spanish speakerphone/background noise, French accent/interruption, German silence, Portuguese ambiguous date, Chinese-English code switch, tool timeout/unknown outcome, and an unsafe or out-of-policy request.

Task 6.0 starts with one Spanish-to-English ticket-or-booking trace. That trace proves the harness but cannot activate the core alone. Activation remains false until every required scenario and every threshold has sufficient recorded evidence. The retained healthcare role must later pass the same core suite plus its own safety/compliance scenarios; it is not the first GTM lock.

## Security boundary

- Environment variables are checked by name/presence/shape only; values are never returned.
- Live execution requires explicit `WP6_ALLOW_SYNTHETIC_LIVE_CALL=true` and `WP6_SYNTHETIC_DATA_ACK=true` gates.
- Phone inputs must be strict E.164 and must not be printed in reports.
- Live mode refuses production and unknown targets by default.
- Evidence is minimized, redacted before serialization, and validated again when read.
- Provider errors are mapped to bounded reason codes; raw response bodies are excluded.
- No new database schema or public API is authorized for the harness.

## Verification checklist

- [x] Register `GTM-008` before implementation.
- [x] Implement a redaction-safe dependency preflight.
- [x] Implement a versioned gold-call evidence schema and validator.
- [x] Implement fail-closed threshold and completeness evaluation.
- [x] Import the locked core/model/role and gold thresholds.
- [x] Require all canonical recorded scenarios for activation.
- [x] Prove secret, phone, transcript, and provider-error redaction.
- [x] Add a credential-free CLI/report path for CI and operators.
- [x] Reuse the existing realtime stream diagnostic rather than replacing it.
- [x] Trace tool, outbox/ticket, dashboard, usage, and cost evidence.
- [x] Persist first-audio timing on the existing append-only call-event path; no schema change.
- [x] Pass modified-scope tests with at least 80% coverage.
- [x] Pass affected typecheck, lint, application/public builds, security review, and full-suite comparison.
- [x] Run the credential preflight against the current environment.
- [ ] Run a live synthetic appointment call when every dependency and opt-in gate is satisfied.
- [ ] Run the complete recorded scenario matrix and meet every threshold.

## Harness completion evidence — 2026-07-12

- `platform/agent-runtime/masterVoiceAgentGoldCall.ts` owns the versioned synthetic-only evidence schema, strict validator, identifier fingerprinting, dependency preflight, diagnostic sanitizer, completeness floors, and activation evaluation. It imports the locked core/model/role and the existing gold thresholds/scenario matrix.
- `server/voice-gateway/services/masterVoiceAgentGoldCallCollector.ts` joins tenant-scoped call identity, first-audio, production tool, durable outbox/ticket, WP4 dashboard projection, xAI usage/AI cost, and Twilio carrier-cost records. It never loads or emits raw transcripts, caller/patient details, phone numbers, provider errors, secrets, or database URLs.
- `server/voice-gateway/routes/stream.ts` now appends a bounded `gold_first_audio` event containing only session-setup, first-audio, and total elapsed milliseconds. Existing runtime behavior and database shape are unchanged.
- `scripts/master-voice-agent-gold.ts` supplies manifest, preflight, validation, evaluation, and gated stream-diagnostic modes. Live mode refuses to run until every staging dependency plus both synthetic-data opt-ins are green.
- Forty-one focused core/runtime/stream/CLI regressions pass. The two WP6 evidence modules have 89.53% statement, 82.17% branch, 98.24% function, and 93.92% line coverage.
- Client typecheck, affected root TypeScript, affected lint, application build, public build, and diff guard pass. Root TypeScript retains the same 273 pre-existing errors, with none in WP6 files.
- The root-only suite reports 5,540 passing, 257 failing, and 129 skipped assertions across 5,926 total. Compared with WP5's 5,515/257/129 across 5,901, all 25 added assertions pass, the failure/skip counts are unchanged, and no gold-call, collector, stream-diagnostic, or modified runtime test fails.
- Current preflight is safely red: `twilio_account` and `database` are ready; `target_environment`, `openai_realtime`, `voice_gateway`, `qvo_test_number`, `authorized_test_caller`, `synthetic_data_ack`, and `live_call_opt_in` are missing. No credential value was printed or stored.

## Recommended next execution — Task 6.1

Provision the missing non-production dependencies, re-run `pnpm run gold:preflight`, and execute one authorized synthetic Spanish-to-English appointment request through Twilio → Master Voice Agent → `createServiceTicket` → outbox/ticket → WP4 dashboard. Collect the redacted evidence artifact and keep activation false until the entire eight-scenario matrix reaches every locked threshold. WP7 compliance review can proceed independently while infrastructure owners complete the credential lane.

## Completion rule

The harness portion may be marked complete independently. WP6 and core production activation remain blocked until the live synthetic call, complete recorded scenario matrix, dashboard trace, usage/cost trace, and every locked threshold have objective evidence.
