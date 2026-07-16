# QVO GTM execution control

**Status:** Canonical execution document
**Document version:** 1.0
**Ultimate objective:** Launch and operate QVO as a focused, managed healthcare AI receptionist built on one perfected Master Voice Agent runtime.
**Current branch:** `codex/qvo-surface-reduction`
**Baseline commit:** `748c7bb8871aba0de597ac89a03d96a468c85626`

## 1. Authority and operating rules

This is the single source of truth for all work required to reach GTM readiness.

- Every application edit must map to a task and checkbox in this document.
- A newly discovered requirement must be added here, placed in dependency order, and given measurable acceptance evidence before implementation.
- Supporting audits, inventories, test reports, and designs may exist, but they are evidence—not competing plans.
- A work package is `COMPLETE` only when every checkbox is complete and its acceptance gate has objective proof.
- If one checkbox cannot be completed, the package is `BLOCKED`; record the exact owner, dependency, evidence, and next action.
- Do not mark work complete because code was written. Completion requires passing tests, build evidence, and behavior proof.
- Preserve unrelated user work and pre-existing workspace files.
- Do not delete retained features, APIs, database objects, migrations, or schemas without an explicit cleanup work package and dependency proof.
- QVO is a Replit project whose deployable source of truth is GitHub `origin/main`. Repository work is not delivery-complete while it exists only in a local worktree or feature branch.
- After a work package passes its required checks, commit it on a `codex/*` branch, push it, merge it into an up-to-date `main`, and push `main` so Replit can receive the change. Preserve review evidence and never force-push or overwrite unrelated remote work.
- A merge to `main` delivers code but does not by itself authorize a Replit production deployment, secret change, PHI activation, paid-plan purchase, live call, or other externally consequential operation. Those actions retain their explicit readiness and owner gates.

### Replit delivery workflow

1. Re-fetch `origin` and prove the delivery branch is based on the current `origin/main`; reconcile any remote movement without discarding local or user changes.
2. Review and classify the complete diff. Exclude unrelated local artifacts such as `.claude/`, secrets, generated coverage, and machine-specific files.
3. Run the work package's focused tests, typecheck, lint, production builds, migration checks, security review, and full-suite baseline comparison. Record all pre-existing failures separately and permit no introduced failure.
4. Commit the verified package on its `codex/*` branch with a scoped message and push that branch to `origin`.
5. Merge through a reviewed pull request when repository protections or review requirements exist. If direct integration is permitted, update local `main` from `origin/main`, merge the verified branch without rewriting history, rerun the deployment-critical checks, and push `main`.
6. Verify the resulting `origin/main` commit contains the work and record the commit, checks, merge method, and Replit deployment status in the execution log.
7. Deploy or promote in Replit only after the applicable environment, migration, vendor, compliance, and activation gates pass. A failed deploy must not be represented as completed delivery.

### Status vocabulary

| Status | Meaning |
| --- | --- |
| `PENDING` | Not started; dependencies may still be open |
| `IN PROGRESS` | Actively being implemented and verified |
| `BLOCKED` | Cannot satisfy an acceptance gate without a named dependency or owner |
| `COMPLETE` | Every checkbox and acceptance criterion has evidence |
| `DEFERRED` | Intentionally outside the current GTM path; retained without customer exposure |

## 2. North-star product definition

QVO is not a generic self-service agent platform. The GTM product is a managed healthcare AI receptionist that:

1. Answers calls naturally.
2. Understands and remembers the caller's context.
3. Handles interruptions and proper conversational turns.
4. Speaks the caller's language naturally, including language changes during a call.
5. Knows the correct current date, local time, and tenant timezone.
6. Retrieves approved knowledge instead of guessing.
7. Calls tools and functions to accomplish real work.
8. Captures complete caller intent and relevant details.
9. Creates a staff-ready task, ticket, appointment request, or escalation.
10. Persists the transcript, summary, outcome, and operational evidence.
11. Avoids unsafe medical claims and escalates appropriately.
12. Presents a focused customer portal and managed-service buying experience.

## 3. Non-negotiable architecture: one Master Voice Agent

### Canonical formula

`Master Voice Agent runtime + role package + permitted capabilities + tenant context = deployed voice application`

There are no separate dental, medical, legal, scheduling, support, or sales agent engines. There is one perfected real-time voice process. A vertical changes what that process is instructed and permitted to accomplish.

### Locked Master Voice Agent responsibilities

The following belong to the core and cannot be overridden by a vertical role package:

- Production realtime model and model version.
- Session lifecycle and transport.
- Voice-quality defaults.
- Natural multilingual recognition, response matching, and code-switching.
- Turn detection, pacing, interruption/barge-in, silence, and recovery behavior.
- Within-call working memory.
- Authorized, tenant-isolated cross-call caller memory.
- Current date, local time, weekday, and timezone context.
- Tool/function dispatch, schema validation, authorization, retries, idempotency, audit, and truthful failure handling.
- Knowledge retrieval behavior.
- Universal safety, privacy, escalation, and non-fabrication rules.
- Transcript, summary, outcome, cost, latency, and quality telemetry.
- Core version identifier and evaluation requirements.

### Role-package responsibilities

A role package may define only:

- Role and objective prompt.
- Organization-specific context and greeting.
- Approved knowledge sources.
- Allowed tools/functions and workflows.
- Vertical safety additions that strengthen the core policy.
- Information that must be collected.
- Desired business outcomes and escalation rules.

A role package may not select a different runtime, bypass core safety, replace memory, weaken tool validation, disable date/time context, or create a second agent process.

### Product and code terminology

- **Master Voice Agent:** the single locked runtime.
- **Role package:** prompts, allowed capabilities, workflow, and guardrails for a job.
- **Deployment:** one tenant/location configuration of the Master Voice Agent plus a role package.
- **Voice profile:** presentation characteristics such as voice selection; never a different agent architecture.
- Existing `agent`, `agentType`, template, and Agent Builder names are migration-era terminology. They must not drive new architectural branching.
- Customer-facing language should describe the receptionist and its outcomes, not agent creation.
- Internal Agent Builder should evolve into a Role/Deployment Studio after the runtime contract is stable.

### Core-to-use-case expansion standard

QVO reaches GTM through one runtime and an expanding catalog of approved role packages and outcomes—not by cloning agents:

`Master Voice Agent core → role package → use cases/outcomes → tenant deployment`

| Layer | Current GTM state | Rule for expansion |
| --- | --- | --- |
| Core runtime | Master Voice Agent `1.0.0`, model `gpt-realtime-2` | One constructor/session architecture. A core-invariant change requires a new core version and the complete gold evaluation. |
| First role package | `healthcare-receptionist@1.0.0` | Role prompt, workflow, allowed tools, data requirements, and guardrails configure the unchanged core. |
| Current healthcare use cases | 10 durable outcome types and 15 deterministic scenario categories spanning appointments, callbacks, billing, refill, records, operational facts, professional callers, emergencies, escalation, tool failure, and missed-call recovery | A use case is accepted only when it has an explicit outcome, required evidence, truthfulness rule, failure/escalation behavior, deterministic tests, and live gold evidence where audio/runtime behavior is claimed. |
| Future vertical roles | Not yet production-approved; legacy templates are migration inputs, not proof of an approved role package | Each must use the role-package compiler, preserve the core model/session, define its own outcome contract and permissions, pass the same core gold suite, and satisfy its applicable compliance gate. |
| Deployment | Tenant/location configuration of an approved role package | Tenant data may select allowed deployment settings and supply bounded facts; it may never relabel a role version, replace its prompt, expand tools, or weaken core/role safety. |

This distinction is the standing architectural gate for every remaining work package and future use case.

## 4. Dependency order

| Order | Work package | Depends on | Can proceed independently? | Status |
| --- | --- | --- | --- | --- |
| 0 | Repository and validation baseline | Correct repository | No | `COMPLETE` with baseline blockers recorded |
| 1 | Customer-facing surface reduction | WP0 | Yes | `BLOCKED` only on authoritative full-suite environment gate |
| 2 | Master Voice Agent core | WP0; preserved voice runtime | Yes, after characterization baseline | `IMPLEMENTED — ACTIVATION BLOCKED ON LIVE GOLD EVAL` |
| 3 | Healthcare receptionist role package | WP2 contract | No | `COMPLETE — RE-AUDITED GTM-009; PRODUCTION SUBJECT TO WP2/WP6/WP7` |
| 4 | End-to-end receptionist workflow and dashboard evidence | WP2, WP3, dashboard data contract | No | `COMPLETE — PRODUCTION SUBJECT TO WP6/WP7` |
| 5 | Healthcare-first demo | WP3, WP4 | No | `COMPLETE — LIVE AUDIO REMAINS WP6` |
| 6 | Real voice-runtime proof | WP2–WP4; credentials/services | No | `IN PROGRESS — LIVE DEPENDENCIES PARTIAL` |
| 7 | Compliance and PHI launch gate | WP2–WP4; compliance owner | Partly | `PENDING` |
| 8 | Public positioning and GTM site | WP1, WP3–WP5; approved language | Partly | `PENDING` |
| 9 | Pricing, billing, and managed onboarding | Founder approval; WP8 | No | `PENDING` |
| 10 | Pilot readiness and launch | WP5–WP9; pilot customer | No | `PENDING` |
| 11 | Post-proof cleanup and deletion | Production evidence and explicit decision | No | `DEFERRED` |

## 5. Work Package 0 — Repository and validation baseline

**Goal:** Ensure every edit and result belongs to the current QVO repository and can be compared against a recorded baseline.

- [x] Verify repository root and remote.
- [x] Fetch Git and confirm local `main` matches `origin/main`.
- [x] Record branch and commit.
- [x] Verify `client-app/src/App.tsx` and `client-app/src/PublicApp.tsx`.
- [x] Identify public, tenant, platform-admin, operations, and voice-runtime entrypoints.
- [x] Identify package manager commands for typecheck, tests, lint, and build.
- [x] Record the pre-change validation baseline.
- [x] Preserve the pre-existing untracked `.claude/` directory.
- [x] Record full-suite environment failures separately from modified-area failures.

**Evidence:** [Route and surface inventory](./route-surface-inventory.md)

**Acceptance gate:** Repository identity and baseline are provable. `COMPLETE`.

## 6. Work Package 1 — Customer-facing surface reduction

**Goal:** Make QVO present as a focused, managed receptionist product while retaining internal implementation for service delivery.

### Repository and inventory

- [x] Inventory every public, tenant, platform-admin, operations, auth, and standalone route.
- [x] Inventory desktop/mobile navigation, search, command palette, quick actions, dashboard links, help, notifications, sitemap, and metadata exposure.
- [x] Define a shared customer/internal/public surface policy.

### Tenant experience

- [x] Limit customer navigation to Dashboard, Calls, Tickets, Knowledge Base, Phone Numbers, Billing, Settings, Users, and Support.
- [x] Remove internal module exposure from desktop and mobile navigation.
- [x] Remove internal exposure from command search, dashboard cards, tours, shortcuts, notifications, help, and phone-number remediation.
- [x] Keep internal tooling available to QVO staff.
- [x] Prevent tenant members, managers, and owners from opening staff-only routes directly.
- [x] Use existing redirect/access-denied behavior and prevent redirect loops.

### Public experience

- [x] Remove generic platform, GIN, federated ingest, builder, marketplace, broad vertical, Docs, Resources, Blog, and self-service signup routes from active public discovery.
- [x] Reduce header, footer, mobile navigation, calls to action, and marketing search.
- [x] Remove deferred routes from the sitemap and public bundle classifier.
- [x] Preserve source components for later evidence-based deletion.

### Validation

- [x] Add focused route, role, navigation, public bundle, and sitemap tests.
- [x] Pass 119/119 modified-area tests.
- [x] Pass client typecheck.
- [x] Pass i18n consistency checks.
- [x] Pass sitemap coverage and hidden-route audit.
- [x] Pass production application and public builds.
- [x] Confirm no backend, API, schema, migration, or retained feature deletion.
- [ ] Obtain a green authoritative full suite or owner acceptance of the documented pre-existing baseline failures.

**Evidence:** [Route and surface inventory](./route-surface-inventory.md)

**Acceptance gate:** `BLOCKED` only by the authoritative full-suite environment/baseline checkbox. All implementation-area checks pass.

## 7. Work Package 2 — Master Voice Agent core

**Goal:** Establish one versioned, perfected voice runtime that every role and vertical uses without architectural branching.

### Task 2.0 — Characterize the existing runtime

- [x] Map every path that constructs `LoadedAgentConfig`, `RealtimeAgent`, and `RealtimeSession`.
- [x] Map every model, voice, language, VAD, memory, prompt, tool, guardrail, handoff, and session override.
- [x] Identify all vertical switches and duplicated prompt/tool definitions.
- [x] Identify all paths that replace or rebuild an agent during a call.
- [ ] Capture current unit, integration, scripted-call, latency, interruption, and tool-call behavior.
- [x] Add characterization tests before refactoring.
- [x] Classify every discovered behavior as core invariant, role-package configuration, tenant configuration, or obsolete branch.
- [x] Ensure no runtime path remains unclassified.

**Proof:** Runtime map plus passing characterization suite.

### Task 2.1 — Define and version the core contract

- [x] Create a typed `MasterVoiceAgentContract`.
- [x] Assign a core semantic version independent of prompts/role packages.
- [x] Define the one supported production model and session configuration.
- [x] Define immutable core policies and allowed deployment-level settings.
- [x] Prevent role packages and tenant records from overriding core invariants.
- [x] Define controlled rollout and rollback for a new core version.
- [x] Record the active core version on every call.

**Proof:** Contract tests reject prohibited overrides and every call record identifies its core version.

### Task 2.2 — Consolidate construction into one process

- [x] Create one constructor/compiler for the Master Voice Agent.
- [x] Route telephony, widget, demo, outbound, and internal test calls through it.
- [x] Remove runtime behavior switches based on vertical names.
- [x] Convert vertical template branches into declarative role-package inputs.
- [x] Ensure all deployments instantiate the same runtime/session class and core configuration.
- [x] Ensure role changes do not create a second agent runtime.
- [x] Convert agent-to-agent session swaps into role-context transitions unless the destination is a human.
- [x] Preserve transcript, memory, tool state, and call identity across role transitions.

**Proof:** Construction tests show every call path resolves to the same core version and constructor.

### Task 2.3 — Natural multilingual behavior

- [x] Do not pin speech transcription to a single language when automatic detection is required.
- [x] Detect and respond in the caller's language naturally.
- [x] Support code-switching during the same call without restarting the session.
- [x] Preserve names, dates, phone numbers, and organization terminology across language changes.
- [x] Keep a tenant-preferred greeting language without forcing the rest of the call into that language.
- [x] Define behavior for unsupported or low-confidence language detection.
- [x] Persist detected language changes for transcript review and quality evaluation.
- [x] Test at minimum English, Spanish, French, German, Portuguese, and one non-Latin-script language.

**Proof:** Deterministic multilingual/core-contract tests pass without changing the runtime or role package; recorded calls remain part of the production lock below.

### Task 2.4 — Conversation and turn-taking perfection

- [x] Centralize voice conversation principles as an immutable core policy.
- [x] Lock telephony noise reduction, VAD, barge-in, and interruption behavior behind the core contract.
- [x] Ask one question per turn and wait for the caller.
- [x] Stop speaking immediately when interrupted.
- [x] Avoid repeated questions when an answer is already in memory.
- [x] Handle silence once without looping or talking over the caller.
- [x] Recover from partial, noisy, or ambiguous speech with focused clarification.
- [x] Close or escalate promptly once the caller's need is satisfied.
- [ ] Measure response latency and interruption responsiveness.

**Proof:** Recorded scripted-call suite meets agreed latency, overlap, repetition, and completion thresholds.

### Task 2.5 — Memory

- [x] Guarantee within-call working memory across every turn and tool call.
- [x] Preserve memory across prompt compression and role-context transitions.
- [x] Load authorized caller history using tenant-isolated storage.
- [x] Distinguish verified facts, caller claims, tool results, and inferred context.
- [x] Never expose one tenant's or caller's memory to another.
- [ ] Define retention, consent, redaction, and PHI boundaries.
- [x] Fail safely when cross-call memory storage is unavailable.
- [x] Persist only approved memory needed for future service.

**Proof:** Same-call, returning-caller, isolation, unavailable-storage, and PHI tests pass.

### Task 2.6 — Date, time, and timezone awareness

- [x] Load the tenant's IANA timezone from the canonical tenant setting.
- [x] Inject the current date, weekday, local time, timezone, and UTC offset into every call at session creation.
- [x] Refresh time context during calls that cross a date/time boundary when necessary.
- [x] Interpret relative expressions such as today, tomorrow, next Monday, and after hours in tenant-local time.
- [x] Pass explicit timezone-aware timestamps to tools and functions.
- [x] Handle daylight-saving transitions correctly.
- [x] Never invent availability based only on date knowledge; use the scheduling tool.

**Proof:** Fixed-clock tests cover multiple timezones, midnight, daylight-saving changes, and relative dates.

### Task 2.7 — Tools and function calling

- [x] Use one typed registry and one execution pipeline for every tool/function.
- [x] Validate tool authorization against the role package and tenant configuration.
- [x] Validate all inputs against schemas before execution.
- [ ] Require idempotency for side-effecting operations.
- [x] Apply timeouts, bounded retries, and observable failure states.
- [x] Distinguish tool success, partial success, failure, and unknown outcome.
- [x] Never tell the caller an action succeeded until the tool confirms it.
- [x] Preserve tool results in working memory.
- [x] Audit every tool request, result, latency, retry, and error.
- [x] Provide a safe human escalation/fallback path.

**Proof:** Success, validation, denial, timeout, retry, duplicate, partial-failure, and fabricated-success prevention tests pass.

### Task 2.8 — Role-package compiler

- [x] Define one declarative role-package schema.
- [x] Separate role prompt, tenant context, knowledge, allowed tools, workflow, data requirements, and supplemental guardrails.
- [x] Validate role packages before deployment.
- [x] Prevent role packages from weakening core safety or changing core runtime settings.
- [x] Migrate existing healthcare/dental and other templates without preserving vertical runtime branches.
- [x] Version role packages independently from the core.
- [x] Support rollback to a previously approved role-package version.

**Proof:** The same Master Voice Agent passes distinct role scenarios by changing only the role package.

### Task 2.9 — Gold evaluation and lock

- [x] Define objective thresholds for latency, interruption, turn-taking, task completion, tool accuracy, memory accuracy, language handling, safety, and escalation.
- [x] Build deterministic unit and integration tests for core invariants.
- [ ] Build recorded-audio/scripted-call evaluations for realistic conditions.
- [x] Include quiet callers, background noise, speakerphone, accents, interruptions, code-switching, silence, ambiguous dates, tool failures, and unsafe requests.
- [ ] Run the same evaluation suite against every supported role package.
- [x] Prohibit production activation when a core invariant regresses.
- [x] Lock the approved core version and require a new version/evaluation cycle for future changes.

**Execution outcome (`GTM-003`):** Core `1.0.0` implementation and deterministic verification are complete. Production activation is intentionally blocked because this workspace has no OpenAI, Twilio, or database credentials; therefore the unchecked recorded-audio, measured-latency, full role-package evaluation, memory-governance, and universal side-effect-idempotency evidence cannot be manufactured. See [Master Voice Agent runtime map](./master-voice-agent-runtime-map.md).

**Acceptance gate:** Every call path uses one core version; all non-negotiable characteristics and gold evaluations pass; vertical behavior changes only through role packages.

## 8. Work Package 3 — Healthcare receptionist role package

**Goal:** Configure—not fork—the Master Voice Agent to perform the first GTM role safely and completely.

- [x] Define the healthcare receptionist role objective.
- [x] Define greeting and identity disclosure.
- [x] Define approved healthcare knowledge boundaries.
- [x] Define intake fields and minimum staff-ready task data.
- [x] Define appointment-request behavior without claiming an unconfirmed booking.
- [x] Define missed-call recovery and callback behavior.
- [x] Define urgent, emergency, clinical, and human-escalation rules.
- [x] Define prohibited medical claims and advice.
- [x] Define allowed tools/functions and their required evidence.
- [x] Keep caller identity distinct from an optional patient reference, including professional pharmacy/lab/facility/referring-office callers.
- [x] Accept only bounded, categorized practice operational facts; reject arbitrary metadata prompt instructions.
- [x] Prevent deployment overrides from expanding the healthcare tool allowlist.
- [x] Validate realtime tool input against the active compiled role schema rather than a legacy global schema.
- [x] Require a stable idempotency scope for healthcare outcomes and transactionally deduplicate human escalations.
- [x] Define multilingual behavior using the core language capability.
- [x] Validate the role package on the same Master Voice Agent `1.0.0` contract, model, constructor, and session architecture; no healthcare-specific runtime was created.
- [x] Pass the complete deterministic healthcare scripted-scenario suite; recorded/live audio execution remains an explicit WP2/WP6 production gate.

**Execution outcome (`GTM-004`, audited by `GTM-005` and `GTM-009`):** `healthcare-receptionist@1.0.0` is registered and deterministically verified on Master Voice Agent contract `1.0.0`. Its prompt, greetings, categorized operational facts, knowledge boundary, distinct caller/patient identities, professional-caller outcomes, tool truthfulness, strict permissions, stable idempotency, missed-call recovery, emergency/clinical escalation, and multilingual scenarios pass. WP3 exposed shared pre-activation reasoning, schema-validation, side-effect-idempotency, unapproved role-version relabeling, and untrusted prompt-data gaps; they were hardened without changing the core contract, model, constructor, session architecture, or semantic version and without creating a vertical runtime branch. See [Healthcare Receptionist Role Package](./healthcare-receptionist-role-package.md).

**Acceptance gate:** `COMPLETE` for implementation and deterministic verification. Production activation remains blocked by the credentialed WP2/WP6 gold evaluation and WP7 compliance gate.

### Executed specification — Task 3.0 healthcare role contract

Start WP3 by creating one independently versioned `healthcare-receptionist` role package and its failing acceptance scenarios. Do not change `Master Voice Agent 1.0.0` while doing this work.

1. Lock the role objective, identity disclosure, and prohibited clinical behavior.
2. Define the staff-ready outcome schema: caller identity/contact, reason, urgency, requested action, callback preference, consent/verification state, and evidence source.
3. Define allowed tools and require confirmed results before claiming a ticket, callback, appointment request, or transfer.
4. Define emergency, urgent, clinical, human-requested, and tool-failure escalation behavior.
5. Add English, Spanish, French, German, Portuguese, Chinese, and code-switch scenarios using the unchanged core.
6. Prove that changing only the role package produces the healthcare workflow; fail the task if core runtime code changes.

WP3 implementation is complete. Pilot/production activation must still wait for the unchecked WP2 live gold-evaluation evidence and the later compliance gate.

### Final Task 3 completion audit — `GTM-009`

| Task 3 requirement | Authoritative implementation and proof | Status |
| --- | --- | --- |
| Objective, AI identity, and disclosure | `rolePackage.ts`; disclosure greetings and role-contract tests | `COMPLETE` |
| Approved healthcare knowledge boundary | Bounded operational-fact categories, identity-verification policy, safety tests | `COMPLETE` |
| Minimum staff-ready outcome | Required PII/PHI field contract plus active `createServiceTicket` schema/validation tests | `COMPLETE` |
| Appointment request truthfulness | Explicit request-not-booking policy plus scripted appointment/reschedule/cancellation cases | `COMPLETE` |
| Missed-call and callback recovery | Callback contract plus deterministic missed-call scenario | `COMPLETE` |
| Emergency, urgent, clinical, and human escalation | Emergency-first instruction, shared safety gate, escalation tool and scenario tests | `COMPLETE` |
| Prohibited medical claims/advice | Role guardrails plus generated-response safety tests | `COMPLETE` |
| Allowed tools and required evidence | Exact three-tool allowlist, deployment non-expansion tests, active-schema authorization | `COMPLETE` |
| Caller/patient/professional identity separation | Structured outcome schema, healthcare ticket validation, connector normalization tests | `COMPLETE` |
| Bounded tenant operational facts | Category/count/length validation and instruction-like content rejection | `COMPLETE` |
| Stable side-effect idempotency | Tenant/role/call/outcome ticket scope plus transactional escalation deduplication tests | `COMPLETE` |
| Core multilingual behavior | Six required languages, Chinese/English code switch, localized AI disclosure, unchanged session | `COMPLETE` |
| Same core/model/constructor/session | Core `1.0.0`, `gpt-realtime-2`, one realtime constructor, no healthcare branch in `masterVoiceAgent.ts` | `COMPLETE` |
| Approved role identity cannot drift | All healthcare aliases compile to `healthcare-receptionist@1.0.0`; tenant metadata cannot relabel the version; manifest field locked | `COMPLETE` |
| Untrusted deployment/call data cannot become instructions | Database `system_prompt`/`customInstructions` ignored; instruction-like practice identity rejected/falls back; non-E.164 caller ID treated as unavailable | `COMPLETE` |
| Deterministic role scenario suite | 15 focused files / 132 assertions pass across role, scenario, outcome, permissions, safety, idempotency, loader, multilingual, and architecture evidence | `COMPLETE` |
| Production activation | Requires WP6 live recorded gold evidence and WP7 compliance approval; neither is represented as deterministic WP3 proof | `GATED — CORRECTLY NOT CLAIMED` |

**Audit conclusion:** Task 3 is complete for its authorized implementation and deterministic-verification boundary. The audit repaired three integrity gaps before reaffirming completion: unapproved role-version relabeling, instruction-like practice identity injection, and untrusted caller-ID prompt injection. These changes preserve the single-core architecture and make future role/use-case expansion safer.

**Next GTM execution:** complete Task 6.1 when infrastructure owners provide the staging OpenAI/gateway/test-number dependencies; in parallel, begin WP7 with a code-backed PHI/recording/retention/vendor posture inventory for compliance-owner approval.

## 9. Work Package 4 — Complete receptionist workflow and dashboard evidence

**Goal:** A completed call creates visible, actionable operational value.

- [x] Persist caller identity and intent.
- [x] Persist transcript and recording policy state.
- [x] Persist concise summary and structured outcome.
- [x] Create a task, ticket, appointment request, or escalation when required.
- [x] Show tool/function results and failures accurately.
- [x] Show staff ownership, priority, status, and next action.
- [x] Show caller language and escalation evidence.
- [x] Show recovered-opportunity or operational-value evidence without unsupported attribution.
- [x] Ensure the customer can complete follow-up using only the focused portal.
- [x] Add end-to-end tests from call input through dashboard evidence.

**Acceptance gate:** `COMPLETE` for deterministic call/tool fixtures and focused-portal staff follow-up. Credentialed audio-to-outcome proof remains WP6, and production PHI/recording activation remains WP7.

### Recommended next execution — Task 4.0 outcome-to-dashboard trace

Start WP4 with one healthcare appointment-request path and prove the entire operational chain before expanding to the remaining outcomes:

1. Trace one healthcare `createServiceTicket` success from call/session identity through durable outbox persistence and the customer-facing task/ticket record.
2. Define one typed dashboard projection containing caller identity, intent, outcome type, requested action, urgency, callback preference, verification/consent state, language, escalation/tool evidence, owner, priority, status, and next action.
3. Render that projection only in the focused Calls and Tickets surfaces; no internal Agent Builder, workflow, marketplace, or operations module may be required for follow-up.
4. Prove durable failure, idempotent replay, optional projection failure, and human-escalation states without false success or duplicate staff work.
5. Add failing-first integration tests from tool input to persistence and focused-portal rendering, then add one browser-level staff follow-up scenario.
6. Reconcile the implementation with a documented dashboard data contract and update this execution control before any newly discovered schema/API expansion.

WP4 may begin independently of live Twilio credentials using deterministic call/tool fixtures. Real audio and production service proof remains WP6.

**Execution outcome (`GTM-006`):** The durable `answering_service_ticket` outbox payload is now the structured outcome source; local ticket creation is transactionally deduplicated and repairs itself on idempotent replay after an optional projection failure. New calls persist an explicit disabled/not-recorded policy and normalized transcript lines. The authenticated tenant endpoint `GET /calls/:id/outcome` composes call, transcript, outbox, ticket, tool, and escalation evidence through one typed projection. Calls and Tickets render that projection and expose an actionable follow-up ticket without an internal route. Human escalation creates or reuses the call's focused ticket and notifications link to Calls. Browser validation exposed and closed a shared modal stacking bug that had made the ticket link unclickable. See [Healthcare Outcome Dashboard Contract](./healthcare-outcome-dashboard-contract.md).

## 10. Work Package 5 — Healthcare-first demo

**Goal:** Demonstrate the exact GTM workflow, not generic platform breadth.

- [x] Use the locked Master Voice Agent core.
- [x] Use the approved healthcare receptionist role package.
- [x] Demonstrate natural conversation and interruption.
- [x] Demonstrate multilingual behavior.
- [x] Capture intent and required caller details.
- [x] Demonstrate a tool/function call.
- [x] Demonstrate safe escalation behavior.
- [x] Show the created task/appointment request.
- [x] Show transcript, summary, outcome, and business value.
- [x] Remove claims not proven by the demo.
- [x] Add a repeatable demo reset and validation procedure.

**Acceptance gate:** `COMPLETE` for the deterministic guided boundary. A prospect can understand the receptionist outcome without seeing or hearing about a generic Agent Builder platform. Credentialed audio remains WP6.

### Completed execution — Task 5.0 production-equivalent healthcare demo

1. Use the unchanged Master Voice Agent `1.0.0` runtime and `healthcare-receptionist@1.0.0` role package; do not create a demo-only agent architecture.
2. Script one appointment-request conversation that demonstrates natural turn-taking, interruption recovery, Spanish or code-switch behavior, date/time awareness, and required caller intake.
3. Execute the real `createServiceTicket` tool contract against a resettable demo tenant fixture and render the same WP4 outcome projection used by Calls and Tickets.
4. Add one safe-escalation branch that proves clinical/emergency boundaries and a human follow-up without an unsupported transfer or appointment claim.
5. Show transcript, concise summary, delivery/tool truth, staff owner/status/next action, and conservative operational value in the prospect-facing demo.
6. Add a one-command reset, deterministic browser proof, claim audit, and operator runbook. Real Twilio/OpenAI audio remains WP6 unless credentials are available during Task 5.

**Execution outcome (`GTM-007`):** `/demo` now presents one healthcare receptionist built from Master Voice Agent `1.0.0` plus `healthcare-receptionist@1.0.0`. Appointment and safe-escalation scenarios execute the production `createServiceTicket` validation/outbox/result contract through an injected resettable local projector and render the shared WP4 outcome component without an authenticated ticket link. The appointment path proves Spanish-to-English code switching, caller interruption, retained context, current tenant date, complete staff intake, and truthful appointment-request wording. The escalation path refuses diagnosis, names emergency services, and creates pending human follow-up without a false transfer claim. A recursive claim audit rejects booking, revenue, compliance, live-call, transfer, and clinical claims. Focused tests, coverage, TypeScript, lint, application/public builds, desktop/mobile browser automation, and in-app visual inspection pass. See [Healthcare-First Demo Contract](./healthcare-demo-contract.md).

## 11. Work Package 6 — Real voice-runtime proof

**Goal:** Prove the production call path under realistic conditions.

- [ ] Validate real Twilio inbound call setup.
- [ ] Validate OpenAI Realtime connectivity and the locked model/configuration.
- [ ] Validate first-audio latency and dead-air handling.
- [ ] Validate interruption and barge-in.
- [ ] Validate multilingual and code-switch calls.
- [ ] Validate date/time/timezone behavior.
- [ ] Validate memory and returning-caller behavior.
- [ ] Validate every required healthcare tool/function.
- [ ] Validate dashboard persistence and staff-ready outcomes.
- [ ] Validate failure, retry, fallback, and escalation behavior.
- [ ] Validate usage, cost, and operational telemetry.
- [ ] Record evidence for every scripted scenario.

**External dependencies:** Twilio, OpenAI, database, deployment environment, phone number, and test caller access.

**Acceptance gate:** The real production path passes the gold voice and healthcare workflow suite.

### Recommended next execution — Task 6.0 credentialed gold call trace

Start WP6 with one synthetic-data, credentialed inbound appointment request and carry it through the real carrier/runtime/dashboard path before expanding the matrix:

1. Run a secrets-and-service preflight for a non-production Twilio number, OpenAI Realtime access, database, deployment, and an authorized test caller. Never record credentials in evidence.
2. Pin the call to Master Voice Agent `1.0.0`, `gpt-realtime-2`, and `healthcare-receptionist@1.0.0`; reject any runtime/model/session drift before calling.
3. Execute one Spanish-to-English appointment-request call containing a real interruption, date/time question, retained callback detail, and confirmed `createServiceTicket` invocation.
4. Trace the real Twilio call SID and core/role versions through transcript, tool execution, durable outbox, ticket, Calls, and Tickets evidence using synthetic caller data only.
5. Record first-audio, turn, interruption, tool, end-to-dashboard, usage, and cost telemetry; compare each against an explicit gold threshold.
6. Add the emergency/safe-escalation call, tool failure, carrier disconnect, and retry/fallback cases only after the first trace is green.
7. Produce replayable redacted evidence and a credential-free harness path for CI. If credentials are unavailable, complete the harness, preflight, evidence schema, and gold thresholds, then mark only the live-call rows blocked on the named infrastructure owner.

**Immediate dependencies:** Twilio test number and credentials, OpenAI Realtime credentials, reachable database/deployment, and authorized test-caller access. WP7 compliance approval is not required for synthetic test data, but is required before production PHI traffic.

## 12. Work Package 7 — Compliance and PHI launch gate

**Goal:** Establish an approved operating boundary for healthcare pilot traffic.

- [x] Inventory every place audio, transcripts, summaries, caller data, memory, and tool payloads are stored or transmitted.
- [ ] Confirm tenant isolation and least-privilege access.
- [ ] Confirm encryption, retention, deletion, redaction, and audit behavior.
- [ ] Confirm vendor/subprocessor posture and required agreements.
- [ ] Confirm consent, recording disclosure, and jurisdiction requirements.
- [x] Confirm emergency and clinical escalation wording.
- [x] Confirm the agent never represents itself as a clinician.
- [ ] Complete compliance-owner review and record approved limitations.
- [x] Add compliance regression tests for the current fail-closed boundary; owner-approved production limits remain pending.

**External dependency:** Named compliance/legal owner and vendor agreements.

**Acceptance gate:** Compliance owner approves the pilot operating boundary in writing.

### Active execution — Task 7.0 code-backed pilot boundary inventory

1. Map every healthcare data class from call ingress through prompt/runtime, persistence, tools/outbox/connectors, dashboards, logs, exports, deletion, backups, and external processors.
2. Classify each control as implemented and verified, implemented but environment-dependent, missing engineering work, or requiring compliance/legal/vendor-owner approval.
3. Default the pilot boundary to synthetic data and recording disabled until the named owner approves PHI, recording/consent, retention, and vendor agreements.
4. Reconcile public HIPAA/BAA/security/retention claims with code and documented evidence; unsupported claims must be removed or downgraded rather than inferred.
5. Add deterministic compliance regressions for enforceable engineering invariants, while keeping legal/jurisdiction/vendor decisions explicitly external.
6. Produce a signoff packet with owners, limitations, evidence, and a production-activation checklist. Do not mark WP7 complete without written compliance-owner approval.

**Task 7.0 execution outcome (`GTM-010`):** The complete code-backed inventory and owner signoff packet are recorded in [Healthcare Pilot Compliance Boundary](./healthcare-pilot-compliance-boundary.md). The audit found partial application controls but no basis for a production PHI approval: normalized transcript lines, event/tool/outbox/outcome/knowledge/log fields remain plaintext-capable; retention and deletion are not unified; production TLS/storage/backups/access are not evidenced; the Twilio/OpenAI/hosting agreement chain and exact service configuration are not approved; recording consent/jurisdiction is not approved; and encrypted caller lookup does not prove cross-call memory. Public posture now fails closed, active pages and localized trust badges no longer publish unsupported positive claims, the DPA identifies itself as a non-executable placeholder, and deletion messages no longer promise unverified complete erasure. Five focused files pass 55 assertions; the shared posture policy has 100% statement/branch/function/line coverage, the healthcare role remains above 87% branch coverage, client typecheck, affected lint, app/public builds, and affected root TypeScript pass. The root-only suite is 5,558 pass / 256 fail / 134 skip across 5,948 versus `GTM-009`'s 5,544 / 257 / 129 across 5,930; no `GTM-010` test fails. The full-suite i18n allowlist failure initially identified one changed compliance key and many pre-existing entries; the changed key was removed, and focused rerun confirms no Task 7 compliance key remains in the stale list. WP7 remains blocked on P0 remediation and written owner/vendor approval.

### Recommended next execution — Task 7.1 fail-closed healthcare activation and PHI data controls

Continue the independent engineering lane while legal/vendor owners work the signoff packet:

1. Add one production-healthcare activation record and gateway guard that defaults to deny; require exact tenant/deployment, Master Voice Agent, role-package, recording, vendor, retention, and approval identities before non-synthetic calls.
2. Produce and implement the approved storage strategy for every PHI-capable transcript, event, tool, outbox, ticket, escalation, knowledge, log, export, cache, and file field.
3. Implement one tenant-scoped retention/deletion manifest with dry-run evidence, non-cascading table coverage, vendor deletion tasks, backup limitations, legal holds, and idempotent verification.
4. Repair encrypted caller lookup or replace it with a keyed lookup token before enabling cross-call memory.
5. Add production-equivalent checks for RLS, keys, transport, backups, least privilege, recording-disabled state, retention, deletion, and subprocessor configuration.
6. Return the generated evidence to section 9 of the pilot boundary; do not activate production PHI without the named legal/compliance owner's written approval.

**Independent external lane:** The founder/compliance owner can now obtain customer, Twilio, OpenAI, hosting, and other subprocessor terms and approve the jurisdiction/recording/retention boundary without waiting for Task 7.1 code. Both lanes must converge before WP7 completion.

### Engineering execution complete — `GTM-011` Task 7.1

**Objective:** Turn the Task 7.0 operating boundary into an enforceable, tenant-and-agent-scoped runtime gate and close the independent memory/deletion evidence gaps without treating an engineer-authored record as legal approval.

**Recorded scope before implementation:**

1. Add a versioned `healthcare_deployment_approvals` record that binds one tenant and agent to Master Voice Agent `1.0.0`, `gpt-realtime-2`, `healthcare-receptionist@1.0.0`, recording disabled, an expiry, accountable platform administrator, and bounded evidence references.
2. Permit `synthetic_test` traffic only from HMAC-allowlisted test numbers; permit `production_healthcare` only when every required owner/vendor/security/retention/deletion/acceptance evidence reference is present. Never store or return the submitted test numbers.
3. Enforce the approval at the signed Twilio webhook before TwiML streaming and again at the WebSocket start frame using the database-backed agent type, so direct stream parameters cannot bypass the gate. Apply the same policy to outbound healthcare calls.
4. Add a deterministic, purpose-separated caller lookup HMAC so encrypted caller identifiers can support tenant-scoped cross-call memory without plaintext lookup or a weak development fallback.
5. Add a code-owned healthcare data-control manifest and deletion verifier covering every identified first-party PHI-capable store; make deletion completion fail closed when an internal store remains, while preserving external-processor and backup limitations as owner evidence rather than false code claims.
6. Add platform-admin-only create/list/revoke approval APIs with strict schemas, parameterized queries, generic client errors, audit events, bounded expiry, and immutable runtime identity. No customer/tenant role may create an approval.
7. Prove deny-by-default, exact-version drift denial, expired/revoked denial, synthetic allowlist behavior, production evidence completeness, inbound/outbound/stream enforcement, hash privacy, memory lookup, deletion verification, authorization, logging/redaction, and migration/RLS constraints through failing-first unit and integration tests.
8. Close the verification-discovered compact E.164 logging gap in the shared PHI scrubber so healthcare stream diagnostics cannot emit an unformatted international caller number.

**Expected implementation surfaces:** `migrations/`, `shared/compliance/`, `platform/compliance/`, `platform/core/phi/`, `server/voice-gateway/routes/`, `server/voice-gateway/services/`, `server/admin-api/routes/platformCompliance.ts`, focused tests, [Healthcare Pilot Compliance Boundary](./healthcare-pilot-compliance-boundary.md), and this control document.

**Completion evidence:** 80%+ modified-module statement/branch/function/line coverage; focused security/integration tests; client and affected root typecheck; affected lint; app/public builds; migration/SQL review; secret/PII scan; root-suite comparison; no live call; no production PHI activation; named remaining external gates.

**Execution outcome:** The repository now has a deny-by-default, tenant-and-agent-scoped healthcare activation record locked to Master Voice Agent `1.0.0`, `gpt-realtime-2`, `healthcare-receptionist@1.0.0`, and recording disabled. Synthetic traffic requires an expiring HMAC allowlist and a bounded test-evidence set; production records require all named evidence-reference fields and expire, but the code does not claim to authenticate the underlying legal/vendor artifacts. Platform-admin-only create/list/revoke endpoints audit every change and never return raw test numbers or stored hashes. Inbound, outbound, Twilio start-frame, and widget paths gate healthcare before session creation using the database-backed role identity. New calls persist a purpose- and tenant-separated caller lookup HMAC; history lookup sends no plaintext phone candidate to PostgreSQL and fails closed without a strong key. A versioned data-control manifest now discovers live tenant tables, blocks schema drift, handles approved non-cascade stores, verifies zero first-party rows before commit, and preserves a redacted deletion proof; production-equivalent schema classification plus external/cache/file/backup deletion remain unverified. Production/staging startup requires strong stream and lookup keys, and compact E.164 values are now scrubbed from carrier logs.

Fifteen focused files pass 178 assertions. The five new control modules individually exceed the 80% threshold: the minimum statement coverage is 87.87%, minimum branch coverage is 80%, functions are 100%, and minimum line coverage is 93.93%. Client typecheck, affected lint, app/public production builds, migration/security/static checks, and all affected root TypeScript paths pass; the repository-wide TypeScript inventory improved from 273 to 272 pre-existing errors. The final bounded-worker root-only suite is 5,628 pass / 261 fail / 129 skip across 6,018 versus `GTM-010`'s 5,558 / 256 / 134 across 5,948. All 70 added assertions pass and no `GTM-011` or affected test fails; five unrelated assertions that were previously skipped execute and fail in the existing non-green environment baseline. One unbounded retry was discarded after Vitest reported nine fork-runner startup timeouts; the bounded rerun completed all 494 files.

No approval was created, no migration was applied to a live database, no live call was placed, and no production PHI was activated. The engineering gate is complete, but WP7 remains blocked on live-schema classification, historical caller-hash backfill, retention, deployed control evidence, evidence-reference authenticity, vendor/customer agreements, recording/jurisdiction decisions, and written owner approval. Full evidence and the exact changed-file/control matrix are maintained in [Healthcare Pilot Compliance Boundary](./healthcare-pilot-compliance-boundary.md).

### Recommended next execution — Task 7.2 production-equivalent data-control evidence

Keep production PHI disabled and close the remaining independent engineering/evidence lane in this order:

1. Apply migration `114` to an isolated production-equivalent database, verify the actual application/service role, and prove approval reads cannot broaden customer access or bypass tenant isolation.
2. Run live schema discovery, classify every `tenant_id` table, and execute one synthetic tenant deletion dry run that proves drift blocking, rollback, zero first-party rows, and durable redacted evidence.
3. Build a controlled no-log historical `caller_lookup_hash` backfill plus HMAC rotation/dual-key procedure; do not claim historical caller memory until the backfill reconciliation is zero-gap.
4. Implement retention schedules and sweepers across calls, transcripts, events, tools, outbox, tickets, escalations, knowledge, logs, files, backups, and external processors with dry-run and completion evidence.
5. Create an owner-verified evidence registry, or equally auditable authenticity control, so production approval references cannot be satisfied by arbitrary well-formed strings.
6. Execute production-equivalent TLS, storage, backup/restore, keys, secrets, least privilege, MFA, access review, monitoring, logging, RLS, and cross-tenant checks and attach redacted evidence to section 9.
7. Hand the completed packet to compliance, infrastructure, product-safety, and pilot-customer owners. Only after their written approvals may an authorized platform administrator create the first short-lived production approval and proceed to the WP6 credentialed gold call.

**Parallel external lane:** The founder/compliance owner should obtain the customer, Twilio, OpenAI, hosting, privacy, recording/jurisdiction, and pilot-acceptance artifacts now. Task 7.2 must not invent or self-approve those decisions.

### Engineering execution complete — `GTM-012` Task 7.2 production-equivalent data-control evidence

**Objective:** Convert the remaining Task 7.1 evidence placeholders into enforceable, rotation-safe, schema-complete controls and a production-equivalent operator proof without activating production PHI or inventing compliance decisions.

**Pre-implementation audit:** The ordered migration history currently defines 185 tenant-scoped tables, while data-control manifest `1.0.0` classifies 12; live-schema drift therefore remains correctly fail-closed. Only `call_events` has a platform retention scheduler (90-day partition pruning), while ticket retention is separately tenant-configurable and no unified approved healthcare schedule covers the remaining stores. Caller lookup has one HMAC key and no version/dual-read path. Healthcare approval evidence values are shape-checked strings but not authenticated against an evidence registry. This workspace has no database, Twilio, OpenAI, or deployment credentials, so live migration, carrier, vendor, and production-environment proof cannot be manufactured here.

**Recorded scope before implementation:**

1. Add a checked-in, versioned catalog for every tenant-scoped table discoverable from ordered migrations. Classify deletion disposition for every table, preserve the detailed PHI classes for healthcare stores, and add a drift test that fails when migrations introduce or remove a tenant table without a catalog decision.
2. Add an owner-verifiable healthcare control-evidence registry storing metadata and an artifact SHA-256 digest, never artifact contents or secrets. Require exact tenant, agent, environment, control key, expiry, submitter, independent verifier, revocation state, and immutable audit history.
3. Make production healthcare approval creation resolve every required reference against verified, unexpired, non-revoked registry records scoped to the same tenant, agent, and production environment. Well-formed arbitrary strings must no longer satisfy production activation.
4. Add versioned HMAC configuration with one current write key and at most one explicitly versioned previous read key. New calls persist the key version; memory lookup uses current and previous candidates during rotation; ambiguous, duplicate, weak, or partially configured keyrings fail closed.
5. Add a bounded, resumable caller-hash backfill command that decrypts one row at a time through the existing envelope service, never logs or outputs the number, writes only hash/version, supports dry-run, requires explicit apply acknowledgement, and records count-only evidence. No live execution is authorized in this workspace.
6. Add a versioned healthcare retention policy contract and dry-run planner covering sessions, transcripts, events, tools, outbox, tickets, escalations, knowledge, logs, evidence, files/backups, and external processors. Destructive execution must require an owner-verified policy/evidence record; no retention duration may be silently invented by engineering.
7. Add operator-safe preflight/evidence output for migration status, schema catalog drift, RLS/service role, keyring, evidence registry, retention plan, deletion dry run, and caller-hash reconciliation. Output must contain counts/status/digests only—no PHI, decrypted values, secrets, database URLs, or artifact contents.
8. Prove authorization, two-person evidence verification, digest/expiry/scope/revocation checks, SQL parameterization, catalog completeness, deletion drift blocking, rotation dual-read, backfill dry-run/apply guards, retention non-destruction without approval, and redacted evidence through failing-first tests and at least 80% coverage for each new control module.
9. Run all available type, lint, build, security, focused, and full-suite comparisons. Mark live database/carrier/vendor rows `BLOCKED — EXTERNAL EVIDENCE` with exact owner and command rather than treating local mocks as production proof.
10. Update the Healthcare Pilot Compliance Boundary and this execution record with the exact changed-file matrix, verified controls, unresolved owner dependencies, and the next GTM task. Do not activate production PHI, create a production approval, run destructive retention/deletion, or place a live call.

**Expected implementation surfaces:** `migrations/`, `shared/compliance/`, `platform/compliance/`, `platform/security/`, `server/admin-api/routes/platformCompliance.ts`, voice persistence/memory adapters, `scripts/`, environment/deployment documentation, focused tests, [Healthcare Pilot Compliance Boundary](./healthcare-pilot-compliance-boundary.md), and this control document.

**Completion evidence:** complete migration-to-catalog equality; authenticated production evidence resolution; rotation/backfill and retention dry-run proof; 80%+ per-module coverage; affected type/lint/build/security checks; full-suite delta; explicit external-evidence matrix; no secrets/PHI in output; no live or destructive action.

**Execution outcome:** Migration `115` adds a metadata-only, service-RLS evidence registry with immutable artifact identity, independent verification, expiry/revocation, and caller-HMAC key-version metadata. The platform-admin workflow submits, lists, verifies, and revokes evidence without returning artifact locators; production approval creation and runtime re-evaluation now resolve the exact eleven tenant/agent/production records, so arbitrary strings, same-person review, scope drift, expiry, and revocation deny. This execution originally recorded catalog version `2.0.0` and 186 tables; `GTM-013` subsequently proved that claim modeled migration-era names rather than final relations and superseded it with the corrected version `3.0.0`/188-root-table result below.

Caller memory now writes the current HMAC/version and reads current plus at most one distinct previous key during rotation. Production requires an explicit current version; malformed, weak, duplicate, or partial keyrings fail closed. The historical reconciliation job is batch-limited, resumable, dry-run by default, exact-acknowledgement protected for apply, conditionally writes only hash/version, and returns counts only. No backfill was executed.

The version `1.0.0` retention contract covers sessions, transcripts, events, tools, outbox, tickets, escalations, knowledge, logs, evidence, first-party files, backups, and external processors. Every duration must be supplied by the owner-approved artifact; the planner issues parameterized count queries only and can never authorize deletion. The operator preflight reports migration, schema drift, service role/RLS, keyring, evidence, caller reconciliation, retention, and deletion state with counts/status/keyed digests only. Missing production-equivalent retention or deletion evidence remains `external_required`.

**Verification:** Eighteen focused files pass 156 assertions. The five new platform control modules measure 100% statements / 93.38% branches / 100% functions / 100% lines; the two shared policies measure 97.22% / 95.34% / 100% / 97.01%; `PiiLookupHash.ts` measures 87.93% / 87.14% / 90.90% / 95.83%. Client typecheck, affected root TypeScript, production-source lint, migration/static tests, diff integrity, and application/public builds pass. Root TypeScript remains at 272 unrelated errors and zero affected errors. The bounded full suite is 5,682 pass / 261 fail / 129 skip across 6,072 versus `GTM-011`'s 5,628 / 261 / 129 across 6,018: 54 additional assertions pass with no new failure or skip. The build's live case-study fetch was unavailable and correctly produced zero dynamic case-study sitemap entries.

**Safety boundary:** No migration was applied, no evidence or approval row was created, no backfill/retention/deletion write ran, no live call was placed, and no production PHI was activated. Master Voice Agent `1.0.0`, `gpt-realtime-2`, and `healthcare-receptionist@1.0.0` remain one locked core→role deployment; no model, runtime, prompt ownership, customer route, or retained generic feature was forked or deleted.

**External gates:** The workspace has no owner-authorized production-equivalent target, Twilio/OpenAI activation packet, or complete vendor/customer/owner evidence. A database credential exists, but `GTM-013` classifies it as read-only/unidentified and prohibits mutation. Infrastructure must apply migrations through `116` only after target classification, prove the actual service role/RLS/catalog, execute synthetic deletion and caller-hash reconciliation, and attach storage/TLS/backup/key/access/log evidence. Compliance and vendor/customer owners must approve retention durations, legal holds, subprocessors, recording/jurisdiction, agreements, and pilot acceptance, then independently verify the eleven registry records. [The exact owner/evidence matrix is maintained in the Healthcare Pilot Compliance Boundary](./healthcare-pilot-compliance-boundary.md).

### Recommended next execution — Task 7.3 production-equivalent owner proof and controlled activation rehearsal

Task 7.3 is the convergence task; it requires infrastructure and owner participation and must preserve the single Master Voice Agent architecture:

1. Apply migrations `112`, `114`, `115`, and `116` to an owner-classified isolated production-equivalent database and capture count/status/digest proof for migration state, actual service role, RLS, and exact 188-root-table catalog equality.
2. Run the synthetic tenant deletion rehearsal and attach drift-blocking, rollback, zero-row, durable evidence, cache/file/backup/vendor, and legal-hold results.
3. Run caller-HMAC dry-run and acknowledged batches until preflight reports zero missing/stale rows; rehearse one current/previous key rotation, validate the pair constraint only after zero gap, then remove the previous pair.
4. Have the compliance owner approve explicit retention durations and legal-hold behavior for every scope; run the read-only plan, implement only the approved sweepers, and attach completion evidence for first-party stores, files, backups, and external processors.
5. Submit artifact metadata/digests for all eleven controls, require a different platform administrator to verify each, and complete the written owner/vendor/customer checklist. Registry verification does not substitute for legal approval.
6. Run `npm run preflight:healthcare-data-controls` for the pilot tenant/agent and require every row to pass. A missing or `external_required` row is a hard stop.
7. Only after the compliance owner signs may an authorized platform administrator create one short-lived production approval and hand off to the WP6 credentialed synthetic gold call. Do not enable real patient traffic during the rehearsal.

**Parallel independent work:** The founder can approve WP8 positioning/claims and WP9 pricing/service scope while Task 7.3 evidence is collected. Those lanes must not publish compliance, live-audio, outcome, or availability claims beyond the proven boundary.

### Engineering execution complete — `GTM-013` Task 7.3 production-equivalent owner proof and activation rehearsal

**Objective:** Converge the repository controls with an identified production-equivalent target and durable owner proof, while refusing to mutate an unclassified database or create an activation record from incomplete rehearsal evidence.

**Pre-implementation audit:** No relevant credential is loaded into the process. A gitignored `.env` contains an external database credential, but `APP_ENV` and any target-owner classification are absent. A redacted read-only transaction proves the target is writable, uses a privileged service role, has one healthcare agent, and is only migrated through `111`: migrations `112`, `114`, and `115` are absent; the approval/evidence tables do not exist. The original relation count included partition children and a compatibility view. Root-relation reconciliation instead finds 184 live tenant tables versus the catalog's then-recorded 186, with real final-state tables `user_roles` and `legacy_agent_prompt_versions` unclassified and stale pre-rename `user_tenant_roles` still cataloged. This invalidates the previous final-schema equality claim. The target also lacks complete RLS coverage. No mutation is authorized until its owner identifies it as an isolated production-equivalent environment.

**Recorded scope before implementation:**

1. Correct the catalog and its test to model final migration state, including table renames, while excluding compatibility views and managed partition children from independent deletion classification.
2. Make live discovery and RLS preflight operate on root base/partitioned relations only, preserving the partitioned parent and failing closed on any real unclassified store.
3. Add a versioned, immutable activation-readiness attestation that binds one tenant/agent, exact Master Voice Agent/model/role/recording identity, schema/catalog state, RLS state, evidence snapshot, caller-hash reconciliation, retention proof, deletion proof, and bounded expiry.
4. Require all rehearsal checks to be `pass`, all counts to reconcile, every proof digest to be valid, and submission/verification to use different platform administrators. Never store PHI, raw rows, identifiers in output, artifact contents, secrets, or database URLs.
5. Bind production approval creation and runtime re-evaluation to the active verified readiness attestation, so evidence records alone cannot bypass an incomplete or later-revoked rehearsal.
6. Enforce the expected accountable owner role for every healthcare control-evidence key rather than accepting an arbitrary self-labeled owner role.
7. Add platform-admin-only submit/list/verify/revoke readiness APIs with strict schemas, parameterized SQL, generic errors, immutable audit history, and no customer-role access.
8. Extend count/status/digest-only preflight and operator guidance to produce the normalized readiness payload without adding a destructive database path.
9. Run failing-first policy, migration, repository, API, authorization, revocation, drift, redaction, coverage, type, lint, build, and full-suite checks. Continue read-only external checks only; do not apply migrations to the unidentified target.
10. Update the Healthcare Pilot Compliance Boundary and this execution record with corrected prior evidence, the exact target-state facts, changed-file/control matrix, owner actions, and the next GTM task. Do not create evidence/approval/readiness rows, execute backfill/deletion/retention writes, place a call, or activate PHI in this workspace.

**Completion evidence:** final-state migration-to-catalog equality; root-relation live discovery; immutable all-pass readiness contract; production approval/runtime binding; exact owner-role enforcement; 80%+ coverage per new module; affected type/lint/build/security checks; bounded full-suite delta; redacted external read-only target report; no live/destructive action.

**Engineering outcome:** Catalog version `3.0.0` now exactly matches the 188 final root tenant tables produced by ordered migrations through `116`. The equality test applies table renames; runtime deletion discovery and RLS preflight include root base/partitioned relations and exclude compatibility views and partition children. This corrects the `GTM-012` 186-table claim without weakening unknown-table drift blocking.

Migration `116` adds a tenant/agent/environment-scoped readiness registry locked to Master Voice Agent `1.0.0`, `gpt-realtime-2`, `healthcare-receptionist@1.0.0`, and recording disabled. It requires 188/188 catalog and RLS counts, eleven verified controls, zero missing/stale caller hashes, eight literal `pass` states, four SHA-256 proof bindings, bounded expiry, independent verification, immutable proof identity, controlled workflow transitions, and service-only RLS. It also enforces the exact evidence-owner matrix and adds a database trigger preventing production approval insertion unless the referenced readiness is verified, active, scope/identity-matched, and long-lived enough for the approval.

The platform-admin API now lists, submits, independently verifies, and revokes readiness metadata using strict schemas and parameterized SQL; customer roles receive `403`, proof digests are omitted from responses, and every transition is audited. The server recomputes the canonical preflight SHA-256 from every normalized field and rejects a syntactically valid digest that does not match its payload. Production approval creation requires and verifies the readiness reference. Runtime authorization re-resolves both evidence and readiness, so later expiry, revocation, owner/evidence failure, identity drift, count drift, or non-pass status denies. The preflight now requires migration `116` and emits the normalized readiness payload using counts/status/digests only.

**Disposable database proof:** Migration `116` was applied to a fresh isolated local PostgreSQL cluster containing only the required predecessor-table contracts. The exercise proved that self-verification fails, independent verification succeeds, one exact scope/identity-matched production approval succeeds, wrong-agent approval scope fails, wrong-owner evidence fails while the expected owner succeeds, verified readiness can be revoked, revoked readiness cannot return to verified, and revoked readiness cannot authorize a later approval. The cluster was stopped and deleted after the test; the existing local and external database servers were untouched.

**External read-only result:** The available database remains unclassified and was never mutated. Corrected reconciliation reports catalog `3.0.0`/188 versus 184 live root tenant relations, zero unknown tables, and exactly four expected absent tables: `billing_reconciliation`, `healthcare_control_evidence`, `healthcare_deployment_approvals`, and `healthcare_activation_readiness`. Migrations `112`, `114`, `115`, and `116` are unapplied. Only 161 of 184 live root tenant relations have RLS. This target cannot produce or verify readiness and remains `BLOCKED — UNCLASSIFIED TARGET AND FAILED PREFLIGHT PREREQUISITES`.

**Verification:** Sixteen focused files pass 131 tests. The two new readiness modules measure 100% statements, branches, functions, and lines; the hardened preflight module measures 100% statements, 94.44% branches, 100% functions, and 100% lines. Affected production-source lint, affected root TypeScript, client typecheck, migration/security tests, disposable PostgreSQL behavior proof, and application/public production builds pass. Root TypeScript retains 272 unrelated pre-existing errors and zero affected-path errors. The bounded root suite records 5,719 pass / 261 fail / 129 skip across 6,109 versus `GTM-012`'s 5,682 / 261 / 129 across 6,072: all 37 additional tests pass and no failure or skip was added. A concurrent build/suite run was discarded because sitemap generation can mutate a test input; the isolated comparison above is authoritative.

**Safety boundary:** No migration was applied externally; no evidence, readiness, or approval row was created; no backfill, retention, or deletion write ran; no call was placed; and no production PHI was activated. The single-agent architecture remains intact: one Master Voice Agent core/model/session contract, one independently versioned healthcare role package, and no runtime/model/prompt-ownership fork.

**Owner continuation required for Task 7.3 operational completion:**

1. Infrastructure owner identifies the target as isolated production-equivalent, records its owner/purpose/lifecycle, and authorizes migrations through `116`.
2. Infrastructure/security closes all RLS gaps and proves 188/188 root-table, role, TLS, storage, backup/restore, key, secret, access, monitoring, and log controls.
3. Compliance/infrastructure execute the guarded deletion, caller-HMAC reconciliation/rotation, and owner-approved retention rehearsals until every preflight status is `pass`.
4. Compliance, infrastructure, product-safety, and pilot-customer owners submit the exact eleven artifacts under the enforced owner-role matrix; different platform administrators verify them.
5. A different platform administrator submits/verifies one short-lived production readiness record. Only then may one readiness-bound production approval be created for the credentialed synthetic WP6 gold call. Real patient traffic remains prohibited.

### Active execution — `GTM-014` Task 7.4 inline operational blocker clearance

**Objective:** Clear Task 7.3's operational gates in owner-authorized, fail-closed order without deleting or rewriting the imported Azul Vision/demo tenant data, inventing legal/vendor/customer evidence, or weakening the single Master Voice Agent contract.

**Owner classification:** The owner confirmed that every row on the available Supabase target is demo data and that the Azul Vision tenant is imported demo data. The target is therefore classified as a non-production, production-equivalent demo environment whose data must be preserved. Before mutation it contained three tenants, one user, fifteen agents, nine phone numbers, and fourteen call sessions. The migration credential is a non-superuser login with `BYPASSRLS`; its configured URL identity matches `current_user`. No names, identifiers, phone numbers, row contents, role name, or connection details were emitted.

**Migration and RLS remediation:** Read-only discovery found 23 live root tenant relations without RLS or a policy. Migration `117_tenant_rls_remediation.sql` enables and forces RLS and installs fail-closed `FOR ALL` tenant policies on those exact tables, including explicit UUID handling for marketplace records. Empty tenant context sees no rows, nullable tenant rows receive no customer bypass, and cross-tenant reads/writes are denied. The healthcare preflight now requires migration `117`.

The target migration ledger also contained two proven branch-history aliases plus two target-only historical records. `migration-aliases.ts` now records a canonical filename only when both the legacy record and its exact final schema are present; it never removes target-only history and fails closed on mismatch. The two proven mappings are `111_usage_metrics_details_jsonb.sql` → `109_usage_metrics_details_column.sql` and `109_tenants_industry_company_size.sql` → `113_tenants_industry_company_size.sql`.

**Rehearsal and external execution:** The RLS migration passed twice on a disposable PostgreSQL cluster with 23/23 enabled, forced, and policy-covered relations; varchar and UUID tenant isolation, empty-context denial, and cross-tenant write denial all passed. A clean PostgreSQL 15 run applied all 188 repository migration files and finished at 188/188 RLS. The exact external target then passed a transaction-scoped seven-migration rehearsal and full rollback at 188/188. The normal staging runner subsequently applied only migrations `110`, `111`, `112`, `114`, `115`, `116`, and `117`. Post-change proof reports zero pending local migrations, 188 root tenant relations, 188 RLS-enabled relations, 188 policy-covered relations, verified configured role identity/capability, and unchanged representative row counts.

**Preflight correction and current result:** The first post-migration preflight exposed duplicate discovery rows for tables with multiple tenant foreign-key paths. Discovery now aggregates and defensively deduplicates to one root relation, conservatively selecting a non-cascade rule whenever any path is non-cascade. The corrected target preflight reports migration `pass` (4/4 readiness prerequisites), schema `pass` (catalog/discovered `188/188`, drift `0`), and database `pass` (RLS `188/188`, configured role proof `pass`).

The owner then installed a dedicated durable caller-lookup HMAC key/version. Only presence, minimum strength, version validity, secret separation, and rotation-pair consistency were inspected; the key was never printed. The guarded backfill first reported 14 eligible demo rows in dry-run mode, then updated exactly 14 rows in acknowledged apply mode with zero failures. The post-run global reconciliation reports zero eligible rows, and the healthcare scope reports `3/3` on the current key version with zero missing and zero stale rows. The preflight keyring and caller-hash sections now pass with dual-read disabled.

**Deletion mechanism rehearsal:** A rollback-only synthetic deletion rehearsal initially exposed a real mixed-identifier defect: most tenant identifiers are text while marketplace tenant identifiers are UUIDs. The explicit-delete and zero-row verification predicates now compare tenant identifiers through a text representation, with a failing-first regression test covering the non-UUID tenant path. The repeated rehearsal created only a synthetic non-UUID tenant and representative first-party fixtures, discovered all 188 root tenant relations, classified 158 cascade relations, 28 explicit-delete relations, one controlled-audit relation, and one preserved-evidence relation, then proved zero first-party rows and the required redacted evidence shape before rollback. A separate post-rollback query proved zero residue. This is first-party mechanism proof only: it does not claim backup, log, cache, Twilio, OpenAI, Supabase, or hosting deletion evidence, and it did not commit a deletion-completion record.

**Remaining owner gates:** Evidence remains `0/11`; retention and external deletion remain `external_required`. The target has one administrator and one tenant-owner assignment, so the enforced independent-verifier rule cannot be satisfied by the current single user. No second identity, approval, readiness, call, or PHI activation was created.

**Checkpoint verification:** Eight focused files pass 38 tests. Coverage across the changed preflight/deletion production modules is 96.62% statements, 90.47% branches, 100% functions, and 96.34% lines. Configured affected-source lint and `git diff --check` pass. Root TypeScript retains the same 272 unrelated pre-existing errors and reports zero errors in GTM-014 paths. The complete suite/build comparison remains reserved for the final GTM-014 handoff after the remaining inline blockers are resolved.

**Next inline blocker:** Obtain the remaining account-level compliance facts and activate the accountable reviewer identities needed for retention, external deletion, and the exact eleven evidence records. Specifically, await the OpenAI BAA plus Modified Retention decision and Replit hosting determination, resume the Twilio BAA/HIPAA-account lane when the owner clears its account issue, and execute the approved Supabase upgrade/BAA/control package only in the go-live readiness window. Yaritza Ferreras Fernandez's distinct sign-in identifier is owner-confirmed as `yferrera05@hotmail.com`, and Wayne Fabian remains the independent reviewer. Migration `118` and the fail-closed platform-admin MFA/invitation flow are implemented, tested, and applied to the demo target, but no account or invitation has been created: deployment, a public `APP_URL`, complete SMTP configuration, a dedicated encryption key (or the documented connector-key fallback), and Wayne's own MFA enrollment must precede the invitation. Until those controls and vendor facts exist, do not invent evidence references or enable healthcare traffic.

**Owner response and vendor-acquisition control:** On 2026-07-13 the owner confirmed that the Supabase organization is on the Pro plan. The current published Pro defaults are daily backups retained for seven days and platform logs retained for seven days; the HIPAA add-on is not available on Pro. The owner approved Team plus the required HIPAA/PITR add-ons as the production direction, but explicitly deferred the subscription change and purchase until the go-live readiness window. This is a timing deferral, not approval to process PHI on Pro: the upgrade, BAA, add-ons, High Compliance designation, and control verification must all complete before production approval or real caller traffic. No BAA is currently executed with Supabase, OpenAI, Twilio, Replit, or any other third-party processor in this path. Replit HIPAA/BAA availability is unknown. Wayne Fabian will serve as the independent platform-administrator reviewer, and the owner designated Yaritza Ferreras Fernandez as the separate evidence submitter. The role separation is named but not yet operational: Yaritza still requires a distinct QVO sign-in identity, least-privilege platform-admin assignment, MFA, access review, and a successful access verification before submitting any artifact.

Official vendor requirements convert those facts into the following fail-closed acquisition queue:

| Order | Processor | Current confirmed state | Required next action | Completion evidence |
| --- | --- | --- | --- | --- |
| 1 | Supabase | `DIRECTION APPROVED / EXECUTION DEFERRED`; Pro confirmed; seven-day daily-backup and seven-day log defaults; no BAA/HIPAA add-on; not eligible for PHI | During the go-live readiness window, execute the approved move to at least Team, purchase the HIPAA/PITR add-ons, submit and execute the BAA, mark the target High Compliance, enforce MFA, enable PITR, SSL enforcement, network restrictions, and Postgres connection logging, then clear every Security Advisor warning. Do not create production readiness or admit real PHI before completion. | Founder direction recorded; timed purchase approval at go-live; executed BAA; Team-or-higher invoice/plan and HIPAA add-on proof; designated project; redacted control screenshots/exports; actual daily-backup and PITR windows; restore-test record |
| 2 | OpenAI API | No BAA or Modified Retention approval recorded; authorized inquiry sent from the owner's work account on 2026-07-13 and verified in Sent Items | Await the vendor response, then complete the API-services BAA and account provisioning for Modified Retention covering `/v1/realtime`; identify the exact organization/project and confirm the locked production model is eligible before sending PHI. | Executed OpenAI BAA/Healthcare Addendum; approved organization/project; Modified Retention status; eligible endpoint/model record; data-control export |
| 3 | Twilio | Credentials exist; no BAA or HIPAA-account evidence; owner tabled outreach on 2026-07-13 while account issues are resolved | After the owner resumes this lane, purchase or verify Security/Enterprise Edition, execute the BAA through the authenticated account's account manager/Sales path, designate the exact account and every used subaccount as HIPAA, restrict the workflow to eligible services, and retain recording-disabled plus call-log deletion/retention proof. | Executed BAA; Edition proof; HIPAA account/subaccount designation; eligible-service mapping; recording and retention/deletion configuration |
| 4 | Replit hosting | Deployment configuration exists; HIPAA/BAA support remains unknown; authorized written-eligibility inquiry sent from the owner's work account on 2026-07-13 and verified in Sent Items | Await the written eligibility decision. If eligible, complete the agreement and verify regions, secrets, logs, backups, retention, deletion, access, and incidents. If Replit cannot provide this, move the PHI-bearing application runtime to an approved BAA-covered host before activation. | Executed BAA or written non-eligibility decision; service boundary; region/access/log/backup/retention/deletion controls; replacement-host evidence if required |
| 5 | Independent review | `IDENTITIES CONFIRMED / SECURE PROVISIONING IMPLEMENTED / ACTIVATION PENDING`; Wayne Fabian is the independent reviewer; Yaritza Ferreras Fernandez is the evidence submitter and her owner-confirmed sign-in is `yferrera05@hotmail.com`; migration `118` is applied, but the target still has only one active administrator | Deploy the MFA/provisioning code with `APP_URL`, SMTP, and encryption configuration; Wayne enrolls MFA and saves recovery codes; invite Yaritza through the audited platform-admin flow; Yaritza accepts, enrolls MFA, saves recovery codes, and completes access verification. Wayne then independently reviews retained artifacts; self-verification stays prohibited. | Two distinct active identities; least-privilege assignments; MFA; recovery acknowledgement; access-review record; submitter/reviewer audit trail |

The production direction is approved, and the OpenAI and Replit vendor requests have been sent. No subscription change, add-on purchase, agreement execution, or evidence-registry row was created. Twilio outreach is explicitly deferred by the owner while account issues are resolved. Until rows 1–5 are complete, the approved product posture remains demo/synthetic only with real PHI prohibited.

**Pre-live vendor requests that should not wait for the Supabase upgrade:** These requests disclose no patient data and do not authorize a purchase. Retain the sent request, vendor response, final agreement, scope attachment, and configuration approval as separate artifacts.

OpenAI API BAA request — send to `baa@openai.com`:

> Subject: API Services BAA and Modified Retention request — Quality Voice Operations
>
> Quality Voice Operations is preparing a managed healthcare receptionist application that uses the OpenAI API `/v1/realtime` endpoint for live voice, multilingual conversation, operational appointment intake, staff follow-up tasks, and safe human escalation. The application is not authorized to diagnose, recommend treatment, or provide clinical advice, and real PHI is disabled pending completion of our vendor agreement chain. We request an API Services BAA/Healthcare Addendum and Modified Retention provisioning for the exact OpenAI organization/project that will run this workload. Please provide the application steps and confirm endpoint/model eligibility, retention behavior, required configuration, subprocessors, deletion handling, and the evidence we should retain. An enterprise agreement is not assumed.

Twilio Sales/account-manager request:

> Subject: Security/Enterprise Edition and HIPAA Account request — Quality Voice Operations
>
> Quality Voice Operations is preparing a managed healthcare receptionist using Twilio Programmable Voice and Media Streams. Recording is disabled. Real PHI is disabled pending completion of our vendor agreement chain. Please quote the minimum eligible Edition, provide the Business Associate Addendum process, confirm the exact eligible products used by this architecture, and explain how to designate the production account and all applicable subaccounts as HIPAA. Please also provide authoritative call-log retention/deletion, region, access-control, incident, and configuration requirements.

Replit Enterprise/Security request:

> Subject: Written HIPAA/BAA eligibility determination for published application workload
>
> Quality Voice Operations is evaluating Replit as the application host for a managed healthcare receptionist. Real PHI is disabled pending a complete vendor agreement chain. Please confirm in writing whether Replit will execute a BAA covering the exact published-application runtime and its handling of live request data, environment secrets, application/platform logs, backups, support access, subprocessors, and transient data. Please identify eligible plans/services, regions, retention/deletion behavior, incident terms, required configuration, and excluded features. If Replit cannot contractually support this workload, please state that so we can select a different PHI-bearing runtime host.

The required second human is now designated: Yaritza Ferreras Fernandez is the evidence submitter, separate from Wayne Fabian as reviewer, and the owner confirmed `yferrera05@hotmail.com` as her QVO sign-in. Do not create a placeholder or shared account. Provision only through the audited invitation flow after deployment configuration and Wayne's MFA enrollment; then verify and record Yaritza's MFA-protected access before she submits any artifact.

**Outbound execution — 2026-07-13:** The connected Outlook profile was verified as the owner's `wfabian@azulvision.com` work account. The connector first rejected both authorized writes with Microsoft `403 AccessDenied` and created neither a sent message nor a draft. The owner then explicitly authorized Outlook Web through Chrome as the fallback. Outlook Web sent the OpenAI request to `baa@openai.com` with subject `API Services BAA and Modified Retention request — Quality Voice Operations` at 19:02 America/Los_Angeles and the Replit request to `sales@replit.com` with subject `Written HIPAA/BAA eligibility determination for published application workload` at 19:03. Both exact recipient/subject entries were verified in Sent Items. These sent inquiries are contact evidence only: they do not establish a BAA, retention approval, endpoint eligibility, hosting authorization, or a completed evidence-registry record. The owner reported active Twilio account issues and explicitly tabled that outreach; no Twilio message was attempted or sent, and the request must later use the authenticated account's Sales/Support path rather than a guessed address.

### Recommended next independent execution — Task 8.0 founder claim register and positioning decision

Task 7.3 external evidence can proceed in parallel. The next repository task should establish the approved commercial language before further public-site edits:

1. Founder approves one primary positioning statement: a managed healthcare AI receptionist built on QVO's single Master Voice Agent, with vertical behavior supplied by the locked role package rather than separate agents.
2. Founder/compliance classify every proposed outcome, availability, multilingual, integration, security, privacy, compliance, pricing, and pilot claim as proven, qualified, deferred, or prohibited.
3. Engineering records one canonical claim register consumed by landing, healthcare/dental, demo, pricing, contact, book-demo, security, privacy, legal, metadata, structured data, locale, and sales-widget surfaces.
4. Failing tests prove no public surface can publish a deferred/prohibited claim or resurrect generic platform/builder/marketplace positioning.
5. Only after claim approval does Task 8.1 rewrite and visually verify all public surfaces. Pricing amounts and service scope remain separately gated by WP9 founder approval.

## 13. Work Package 8 — Public positioning and GTM site

**Goal:** Make every public surface sell the proven managed healthcare receptionist outcome.

- [ ] Approve one positioning statement and claim hierarchy.
- [ ] Rewrite the landing page around missed-call recovery, intake, follow-up, safe escalation, and done-for-you setup.
- [ ] Align pricing, demo, healthcare/dental, contact, book-demo, case-study, security, and legal pages.
- [ ] Remove remaining generic-platform terminology and unsupported claims.
- [ ] Ensure public calls to action match the managed sales/onboarding process.
- [ ] Ensure screenshots and videos show only approved customer surfaces.
- [ ] Validate localized copy against the same claim set.
- [ ] Validate routes, metadata, canonical URLs, structured data, sitemap, and accessibility.

**External dependency:** Founder approval of positioning and claims.

**Acceptance gate:** Every discoverable public page presents the same focused, evidence-backed offer.

## 14. Work Package 9 — Pricing, billing, and managed onboarding

**Goal:** Make the commercial and onboarding path match the actual service.

- [ ] Approve setup fee, recurring price, included usage, overages, and support scope.
- [ ] Define what QVO configures versus what the customer manages.
- [ ] Define contract, cancellation, pilot, and success terms.
- [ ] Align pricing UI and billing implementation.
- [ ] Replace self-service provisioning assumptions with a managed onboarding checklist.
- [ ] Define internal deployment/role-package setup procedure.
- [ ] Define customer acceptance and go-live signoff.
- [ ] Test checkout/invoicing and account activation paths.

**External dependency:** Founder approval of pricing and service scope.

**Acceptance gate:** A buyer can understand, purchase, and onboard into the service without encountering a generic platform workflow.

## 15. Work Package 10 — Pilot readiness and GTM launch

**Goal:** Launch a controlled healthcare pilot with measurable operational outcomes.

- [ ] Select a pilot customer and named operational owner.
- [ ] Capture business hours, escalation contacts, routing, knowledge, tools, and role-package requirements.
- [ ] Configure a deployment of the locked Master Voice Agent.
- [ ] Complete scripted acceptance calls with the customer.
- [ ] Complete compliance and commercial signoff.
- [ ] Define monitoring, alerting, support, rollback, and incident procedures.
- [ ] Define baseline and success metrics.
- [ ] Run the pilot and review every failed or low-quality call.
- [ ] Feed core defects into a new Master Voice Agent version cycle.
- [ ] Feed role-specific defects into the healthcare role package only.
- [ ] Produce launch evidence and a repeatable onboarding playbook.

**External dependencies:** Pilot customer, Twilio/OpenAI/deployment credentials, compliance approval, and pricing approval.

**Acceptance gate:** The pilot operates safely and repeatedly, delivers agreed outcomes, and has an evidence-backed support and rollback process.

## 16. Work Package 11 — Post-proof cleanup and deletion

**Goal:** Remove obsolete generic-platform code only after proof that it is unnecessary.

- [ ] Run dependency and reference scans.
- [ ] Review production telemetry and internal operator usage.
- [ ] Identify code replaced by the Master Voice Agent and role-package architecture.
- [ ] Identify hidden public and tenant components with no approved future use.
- [ ] Identify obsolete APIs, jobs, database objects, migrations, docs, and tests.
- [ ] Produce an explicit deletion proposal with rollback and data-retention impact.
- [ ] Obtain approval before deletion.
- [ ] Delete in small verified packages.
- [ ] Run full regression, migration, deployment, and rollback checks.

**Acceptance gate:** Deletion is evidence-based, explicitly approved, and introduces no loss of required customer or operator capability.

## 17. External dependencies and decision owners

| Decision/dependency | Required owner | Blocks |
| --- | --- | --- |
| Stable full-suite environment and required service credentials | Infrastructure/engineering | WP1 closure; WP2 and later authoritative regression proof |
| Production realtime model and core lock policy | Engineering/product owner | WP2 |
| Healthcare workflow/data contract | Product + pilot operations | WP3–WP5 |
| PHI, recording, retention, emergency, and vendor posture | Compliance/legal owner | WP7, WP10 |
| Public positioning and claim approval | Founder | WP8 |
| Setup fee, recurring pricing, usage, and service scope | Founder | WP9 |
| Pilot organization, contacts, and success criteria | Pilot-customer owner | WP10 |
| Hard deletion decision | Founder/engineering owner | WP11 |

## 18. GTM completion definition

QVO is GTM-ready only when all of the following are true:

- [ ] WP1 customer/public surface reduction is fully closed.
- [x] One locked Master Voice Agent runtime powers every implemented call path; production activation still depends on the next evaluation checkbox.
- [ ] The core passes multilingual, conversational, turn-taking, memory, date/time, tool/function, safety, latency, and failure evaluations.
- [x] Healthcare behavior is supplied by `healthcare-receptionist@1.0.0`, not a separate runtime.
- [ ] A real call creates a correct staff-ready outcome visible in the focused portal.
- [x] The healthcare demo proves the same production workflow.
- [ ] Real Twilio/OpenAI runtime validation passes.
- [ ] Compliance approves the pilot operating boundary.
- [ ] Public positioning and commercial terms are approved and consistent.
- [ ] Managed onboarding is documented and tested.
- [ ] A pilot customer completes acceptance and produces measurable evidence.
- [ ] Monitoring, support, rollback, and incident procedures are operational.

No individual feature, page, passing demo, or planning document is sufficient by itself.

## 19. Change-control protocol

Before modifying the application, create or update an execution-log entry containing:

1. A unique execution ID.
2. The controlling work package and task.
3. The exact objective and acceptance evidence.
4. Expected files/systems in scope.
5. Dependencies and decisions already satisfied.
6. Required tests, build, and manual proof.
7. Final changed-file evidence and result.

If implementation discovers a necessary edit outside the recorded scope, update this document before making that edit. Do not hide scope expansion inside a diff.

### Decision log

| ID | Decision | Consequence | Status |
| --- | --- | --- | --- |
| `GTM-D001` | QVO has one Master Voice Agent runtime | Verticals become role packages; no new vertical-specific runtime branches | Approved |
| `GTM-D002` | QVO GTM is a managed healthcare receptionist, not a generic self-service agent platform | Customer/public surfaces and commercial workflows must remain focused | Approved |
| `GTM-D003` | Hide and internalize before deletion | Retained implementations require telemetry/dependency proof and separate approval before removal | Approved |
| `GTM-D004` | Shared runtime integration may be hardened before the credentialed Master Voice Agent production lock, but it may not fork by vertical or change the locked contract/model/session architecture silently | WP3's shared reasoning/tool-authorization hardening remains in core candidate `1.0.0`; after the live gold lock, any core-invariant change requires a semantic version bump and complete reevaluation | Approved for pre-activation candidate |
| `GTM-D005` | Healthcare tenant context is structured data, not a free-form prompt extension | Practice-specific facts use bounded approved categories; arbitrary database prompts and legacy custom instructions cannot modify the healthcare role | Approved |
| `GTM-D006` | A deployment may reference only an implementation-backed, QVO-approved role-package identity | Tenant metadata cannot relabel a role implementation/version; manifest identity/version fields remain locked, and untrusted deployment/call data must be validated before entering a prompt | Approved |
| `GTM-D007` | Regulatory, certification, security-control, BAA, residency, retention, and deletion claims fail closed to the recorded evidence state | Code capability, roadmap language, vendor eligibility, or an unsigned template cannot be promoted into a public compliance claim or production approval | Approved |

## 20. Execution log

| ID | Date | Work package/task | Objective and scope | Required proof | Evidence/result | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `GTM-000` | 2026-07-12 | WP0 | Verify repository, Git state, entrypoints, commands, and validation baseline | Repository/Git evidence and baseline command results | Route inventory baseline | `COMPLETE` |
| `GTM-001` | 2026-07-12 | WP1 Tasks 1–8 | Reduce customer/public surfaces without backend or schema deletion | Focused tests, typecheck, i18n, sitemap, build, full-suite comparison | Route inventory and changed-file manifest; implementation checks pass; full-suite environment gate remains | `BLOCKED` |
| `GTM-002` | 2026-07-12 | WP2 architecture gate | Establish one Master Voice Agent and define core versus role-package ownership | Repository runtime inspection and approved non-negotiable contract | One core/role/deployment ownership contract implemented as core `1.0.0` | `COMPLETE` |
| `GTM-003` | 2026-07-12 | WP2 Tasks 2.0–2.9 | Characterize, implement, consolidate, and verify the versioned Master Voice Agent core across telephony, widget, role packages, memory, multilingual behavior, time context, tools, and gold evaluations | Characterization tests, core contract tests, runtime integration tests, security review, typecheck, focused/full regression comparison, and build | Runtime map; 47 files/339 Task 2 tests pass; typecheck/build/lint pass; one locked model/session and same-session role transitions proven. Full suite remains red on pre-existing environment/UI/DB failures. Coverage provider and credentialed recorded-call proof unavailable. | `IMPLEMENTED — ACTIVATION BLOCKED` |
| `GTM-004` | 2026-07-12 | WP3 healthcare receptionist role package | Configure and prove one independently versioned healthcare receptionist role package on Master Voice Agent contract `1.0.0`, including identity disclosure, staff-ready outcomes, appointment-request truthfulness, missed-call recovery, safety/escalation, allowed tools, and multilingual scenarios | Failing-first contract tests, role compilation tests, tool schema/handler tests, healthcare scripted scenarios, core-architecture guard, security review, focused/full regression comparison, typecheck, lint, and build | Initial implementation completed and subsequently subjected to the stricter `GTM-005` completion audit. [Healthcare role evidence](./healthcare-receptionist-role-package.md). | `COMPLETE — SUPERSEDED BY AUDITED EVIDENCE` |
| `GTM-005` | 2026-07-12 | WP3 completion audit and hardening | Re-audit every WP3 acceptance requirement against current code and close any contradiction before preserving completion | Failing-first tests for structured practice facts, caller-versus-patient identity, professional callers, input validation, strict tool permissions, active-role schema validation, ticket and escalation idempotency; focused security/regression tests, coverage, typecheck, lint, build, and full-suite comparison | All discovered gaps closed. Arbitrary custom prompt metadata is ignored; categorized facts are bounded and injection-checked; caller and optional patient identity remain distinct; professional outcomes persist and normalize into ticketing; permission overrides cannot expand access; realtime validation uses the active role schema; ticket creation requires a stable call scope; human escalation uses transaction-lock deduplication. 32 files/323 focused tests pass. Hardened coverage is 91.39% statements, 84.23% branches, 100% functions, and 93.62% lines. Lint, client typecheck, changed-path TypeScript check, diff guard, and both builds pass. Full suite remains at the 263-failure baseline with 5,480 passing, 129 skipped, and zero relevant failures. No public API, schema, migration, or retained-feature deletion occurred. | `COMPLETE — PRODUCTION GATED` |
| `GTM-006` | 2026-07-12 | WP4 outcome-to-dashboard trace | Prove that one healthcare appointment request and one human escalation can be traced from the Master Voice Agent call through durable persistence into a tenant-isolated, actionable Calls/Tickets experience containing transcript/recording policy state, structured outcome, truthful tool state, ownership, priority, status, next action, language, escalation evidence, and supported operational value | Evidence-backed data-contract inventory; failing-first persistence/API/UI/security tests; tenant and role isolation; idempotent replay and failure-state tests; focused browser-level staff workflow; 80%+ modified-scope coverage; typecheck, lint, builds, and full-suite comparison | Contract and implementation complete in [Healthcare Outcome Dashboard Contract](./healthcare-outcome-dashboard-contract.md). Durable request and summary, self-repairing idempotent ticket projection, normalized transcript, explicit recording policy, tenant-isolated typed API, Calls/Tickets UI, escalation-ticket reuse, truthful failure states, and focused follow-up are proven. 13 test files/104 focused regressions pass; WP4-owned coverage is 91.09% statements, 83.47% branches, 95.23% functions, and 95.80% lines. The self-contained real-browser flow passes login → Calls → outcome → ticket → in-progress status, and an in-app browser inspection confirmed the same rendered contract. Client typecheck, affected-path TypeScript, lint, diff guard, and app/public builds pass. Root-only full suite improved from the recorded 263 failures/5,480 passes/129 pending to 261 failures/5,496 passes/129 pending across 5,886 assertions, with zero relevant failures. Root TypeScript retains 273 pre-existing errors and zero affected-path errors. No schema, migration, model/runtime fork, unsupported attribution, or retained-feature deletion occurred. | `COMPLETE — PRODUCTION GATED BY WP6/WP7` |
| `GTM-007` | 2026-07-12 | WP5 healthcare-first demo | Replace the generic multi-agent showcase with one production-equivalent healthcare receptionist proof using Master Voice Agent `1.0.0`, `healthcare-receptionist@1.0.0`, the production ticket tool contract, and the WP4 outcome projection | Failing-first architecture/tool/API/component/claim/reset tests; appointment and safe-escalation journeys; real-browser proof; 80%+ modified-scope coverage; typecheck, lint, builds, and full-suite comparison | Complete in [Healthcare-First Demo Contract](./healthcare-demo-contract.md). The public gallery is now one guided healthcare proof with appointment and escalation branches. Both import the locked core/role, invoke production `createServiceTicket`, and render the shared WP4 projection through stateless synthetic demo persistence. Claim audit, reset/retry, rate-limited endpoint, analytics, desktop/mobile browser flow, and operator procedure are proven. Four focused files/48 tests pass; modified scope reaches 86.73% statements, 81.73% branches, 85.48% functions, and 89.30% lines. Client TypeScript, affected-path TypeScript, lint, application/public builds, automated browser proof, and in-app inspection pass. The root-only suite now has 5,515 pass, 257 fail, and 129 skipped across 5,901 assertions versus WP4's 5,496/261/129 across 5,886, with zero WP5-relevant failures; root TypeScript retains 273 pre-existing errors and zero affected-path errors. No schema, migration, model/runtime fork, authenticated internal route exposure, or live-audio claim was introduced. | `COMPLETE — PRODUCTION GATED BY WP6/WP7` |
| `GTM-008` | 2026-07-12 | WP6 Task 6.0 credentialed gold call trace | Build the fail-closed, redaction-safe evidence harness for real Twilio/OpenAI healthcare calls; prove one synthetic appointment trace when dependencies are available; preserve the one-core architecture and prohibit activation on partial evidence | Dependency preflight; locked-version/schema/threshold/scenario tests; secret/phone/transcript/provider-error redaction tests; credential-free CLI; existing stream diagnostic integration; live synthetic trace if all opt-ins and services exist; 80%+ coverage; typecheck, lint, builds, security review, and suite comparison | Harness complete in [Master Voice Agent Gold Call Contract](./master-voice-agent-gold-call-contract.md). A versioned synthetic-only schema, strict redaction/validation, canonical scenario and threshold evaluator, safe operator CLI, persisted first-audio event, and tenant-scoped production evidence collector now join locked runtime identity, tool/outbox/ticket, WP4 dashboard, usage, AI cost, and Twilio carrier cost without exposing transcripts, phone numbers, patient data, provider errors, secrets, or database URLs. Forty-one focused regressions pass; evidence-module coverage is 89.53% statements / 82.17% branches / 98.24% functions / 93.92% lines. Client typecheck, affected TypeScript/lint, application/public builds, security review, and diff guard pass. The root-only suite is 5,540 pass / 257 fail / 129 skip across 5,926 versus WP5's 5,515 / 257 / 129 across 5,901: all 25 added assertions pass, with no new failure and no WP6-relevant failure. The current preflight has only Twilio account and database ready; staging target, OpenAI, gateway, test numbers, and both opt-ins remain absent, so no call was placed and activation remains false. | `HARNESS COMPLETE — LIVE CALL DEPENDENCY-GATED` |
| `GTM-009` | 2026-07-12 | WP3 Task 3.0 final completion audit | Re-derive and prove every healthcare role requirement against the current worktree, repair any integrity gap, and make the core→role→use-case→deployment expansion rule explicit for all future GTM work | Failing-first drift/injection tests; exact core/role/model/tool/scenario checks; 80%+ role/loader coverage; affected typecheck/lint/build; security/diff review; full-suite comparison; requirement matrix | Complete in [Healthcare Receptionist Role Package](./healthcare-receptionist-role-package.md). Tenant metadata can no longer relabel the implementation, the manifest locks the role version, instruction-like practice identity falls back safely, and only E.164 caller ID may enter the role prompt. Every healthcare alias remains on Master Voice Agent `1.0.0` / `gpt-realtime-2` / `healthcare-receptionist@1.0.0`. The 15-file Task 3 suite passes 132 assertions; modified role/loader coverage is 91.35% statements / 81.01% branches / 100% functions / 93.24% lines. Verification also reproduced and fixed the WP6 diagnostic's zero-millisecond connection classifier without altering the voice runtime contract. Client typecheck, affected root TypeScript, production-file lint, app/public builds, security review, and diff guard pass. The root-only suite is 5,544 pass / 257 fail / 129 skip across 5,930 versus GTM-008's 5,540 / 257 / 129 across 5,926: all four new assertions pass, no new failure remains, and no Task 3 or diagnostic test fails. | `COMPLETE — PRODUCTION GATED BY WP6/WP7` |
| `GTM-010` | 2026-07-12 | WP7 Task 7.0 code-backed pilot boundary inventory | Establish the evidence-backed PHI/audio/recording/retention/access/vendor operating boundary for a healthcare pilot without manufacturing legal approval or promoting unsupported public claims | Repository-wide data-flow/control inventory; authoritative regulatory/vendor references; claim-to-evidence audit; failing-first compliance invariants; affected security/type/build/test checks; named owner/signoff matrix | Engineering inventory, fail-closed posture policy/API, active-page and five-locale claim correction, non-executable DPA boundary, truthful deletion messaging, authoritative source register, P0/P1 remediation backlog, and owner activation checklist are complete in [Healthcare Pilot Compliance Boundary](./healthcare-pilot-compliance-boundary.md). Five focused files/55 assertions pass; shared policy coverage is 100%; client typecheck, affected lint/root TypeScript, and app/public builds pass; full suite has no Task 7 failure and improves from 257 to 256 failures. Production PHI remains prohibited: plaintext-capable fields, retention/deletion, deployment evidence, agreements, jurisdiction/recording, and written owner approval remain hard gates. | `ENGINEERING INVENTORY COMPLETE — WP7 OWNER/VENDOR BLOCKED` |
| `GTM-011` | 2026-07-12 | WP7 Task 7.1 fail-closed healthcare activation and PHI data controls | Enforce exact-version, tenant/agent-scoped healthcare activation; allow only HMAC-allowlisted synthetic tests or evidence-referenced production records; repair encrypted caller memory lookup; verify first-party deletion coverage; preserve external approval as a hard gate | Failing-first policy/repository/API/inbound/outbound/stream/memory/deletion/log-redaction tests; 80%+ modified-module coverage; migration/RLS and security review; affected type/lint/build; full-suite comparison | Fail-closed approval schema/policy/admin API and all healthcare ingress guards implemented; purpose-separated caller HMAC implemented for new calls; manifest-driven deletion blocks unclassified stores, rolls back failed verification, records a non-reversible executor fingerprint, and verifies zero rows; strong production secrets and compact E.164 log redaction enforced. Fifteen files/178 focused assertions pass; every new control module exceeds 80%; client typecheck, affected lint/TypeScript, and app/public builds pass; all 70 new root assertions pass. No approval, live migration, call, or PHI activation occurred. Production-equivalent schema/retention/storage/access/evidence-authenticity proof and written owner/vendor/customer approval remain blocked. [Detailed evidence](./healthcare-pilot-compliance-boundary.md). | `ENGINEERING GATE COMPLETE — WP7 EVIDENCE/OWNER BLOCKED` |
| `GTM-012` | 2026-07-12 | WP7 Task 7.2 production-equivalent data-control evidence | Complete the tenant-table catalog; authenticate deployment evidence; add rotation-safe caller HMAC and a guarded backfill; define owner-approved retention planning; produce redacted operator evidence without production activation | Failing-first catalog/evidence/API/rotation/backfill/retention/preflight tests; 80%+ per-module coverage; migration/RLS/security review; affected type/lint/build; full-suite comparison; explicit external-evidence matrix | Migration `115`, evidence registry, production approval revalidation, current/previous HMAC rotation, guarded historical backfill, owner-bound read-only retention planning, and redacted preflight are complete. The originally recorded 186-table catalog claim was superseded by `GTM-013`'s corrected final-relation model. 18 files/156 focused assertions pass; all new modules exceed 80%; builds/types/lint pass; full suite adds 54 passes with failures/skips unchanged. No live/destructive action or production activation occurred. [Detailed evidence](./healthcare-pilot-compliance-boundary.md). | `ENGINEERING COMPLETE — EXTERNAL PROOF BLOCKED` |
| `GTM-013` | 2026-07-12 | WP7 Task 7.3 production-equivalent owner proof and activation rehearsal | Correct final-schema discovery, add immutable all-pass readiness attestation, bind production approval/runtime to it, enforce evidence owner roles, and collect safe target proof without mutating an unidentified database | Failing-first catalog/discovery/policy/migration/API/approval/runtime/redaction tests; 80%+ coverage; affected types/lint/build; full-suite delta; redacted read-only external report; explicit owner matrix | Catalog `3.0.0` exactly models 188 final root tenant tables; root discovery excludes views/partition children; migration `116`, owner-role enforcement, immutable all-pass readiness, canonical payload-digest verification, platform-admin workflow, production approval/database/runtime binding, and normalized preflight are implemented. Migration/state/owner/approval triggers pass a disposable PostgreSQL exercise. 16 focused files/131 tests pass; readiness modules have 100% coverage and preflight reaches 100/94.44/100/100; affected lint/types, client typecheck, builds, and security tests pass; full suite is 5,719/261/129 versus 5,682/261/129. Read-only target proof finds 184 live roots, zero unknown, four expected missing migration tables, migrations 112/114/115/116 absent, and RLS 161/184. No external mutation or activation occurred. | `ENGINEERING COMPLETE — OWNER/TARGET REHEARSAL BLOCKED` |
| `GTM-014` | 2026-07-12 | WP7 Task 7.4 inline operational blocker clearance | Owner-classify and preserve the demo target, reconcile migration history, close live RLS gaps, apply the reviewed schema sequence, and drive the normalized preflight toward all-pass without manufacturing owner evidence | Failing-first migration/alias/discovery tests; disposable RLS behavior proof; clean full-chain migration; exact-target rollback rehearsal; transactional external migration; guarded HMAC backfill; rollback-only first-party deletion rehearsal; redacted post-state/preflight proof | Owner classified all rows as demo and the imported Azul Vision tenant as preserved demo data. Migration `117`, schema-verified alias reconciliation, configured-role capability proof, and one-row-per-root discovery are implemented. The target has zero pending local migrations and 188/188 RLS/policy coverage. The dedicated HMAC backfill reconciled 14/14 demo rows and healthcare caller proof is `3/3` current with zero missing/stale. A synthetic mixed-ID deletion rehearsal proves zero first-party rows across all 188 classified relations and zero rollback residue, but does not claim external/backup deletion. On 2026-07-13 the owner confirmed no third-party BAA exists, Supabase is Pro with seven-day daily-backup/log defaults, Replit eligibility is unknown, and Wayne Fabian will be the independent reviewer. Team plus HIPAA/PITR is approved as the production direction but intentionally deferred to the go-live readiness window. Authorized OpenAI and Replit inquiries were sent from the owner's work account and verified in Sent Items; Twilio outreach was explicitly tabled during account issues. Yaritza Ferreras Fernandez is designated as the separate evidence submitter, but her distinct QVO identity, least-privilege platform-admin assignment, MFA, and access review remain pending. Vendor responses/agreements, eleven artifacts, approved retention/external deletion, readiness, approval, and the gold call also remain. No purchase, durable deletion, readiness, approval, call, or PHI activation occurred. | `ACTIVE — SUBMITTER NAMED; PROVISIONING/VENDOR RESPONSES REQUIRED; TWILIO DEFERRED` |
| `GTM-015` | 2026-07-13 | WP7 secure independent-reviewer provisioning | Add a fail-closed platform-admin TOTP MFA and audited invitation path so the named submitter can be provisioned without granting password-only global access | Failing-first cryptographic, migration, auth, replay, recovery, lockout, rate-limit, invitation, and client-flow tests; migration rehearsal/application; affected typecheck/lint; deployment and identity runbook | Migration `118` is applied to the demo target. Platform-admin password/invitation authentication now requires TOTP enrollment or challenge before privileged session issuance; encrypted pending/enabled seeds, hashed single-use recovery codes, replay prevention, lockout, rate limits, live authorization checks, audit events, and a 72-hour invitation flow are implemented. Fifty-four focused assertions, client typecheck, affected lint, and diff guard pass. Yaritza Ferreras Fernandez's sign-in is owner-confirmed as `yferrera05@hotmail.com`, but no account or invitation was created because code deployment, public `APP_URL`, complete SMTP/encryption configuration, and Wayne's MFA enrollment are prerequisites. | `ENGINEERING COMPLETE — DEPLOYMENT/ENROLLMENT ACTIVATION BLOCKED` |

Every future implementation must add an entry here before it begins and update the result before handoff.

## 21. Supporting evidence index

| Artifact | Purpose | Authority |
| --- | --- | --- |
| [Route and surface inventory](./route-surface-inventory.md) | Detailed WP1 route map, file manifest, baseline, final evidence, and manual checks | Supporting evidence |
| [Master Voice Agent runtime map](./master-voice-agent-runtime-map.md) | WP2 construction map, ownership matrix, removed branches, security review, test evidence, and production-lock requirements | Supporting evidence |
| [Healthcare Receptionist Role Package](./healthcare-receptionist-role-package.md) | WP3 role contract, outcome/tool matrix, multilingual scenarios, security review, changed-file manifest, validation results, and production gates | Supporting evidence |
| [Healthcare Outcome Dashboard Contract](./healthcare-outcome-dashboard-contract.md) | WP4 durable-source inventory, typed tenant projection, truth-state rules, recording policy, operational-value boundary, and verification checklist | Supporting evidence |
| [Healthcare-First Demo Contract](./healthcare-demo-contract.md) | WP5 runtime identity, prospect journeys, claim boundary, interface contract, tests, and production boundary | Supporting evidence |
| [Master Voice Agent Gold Call Contract](./master-voice-agent-gold-call-contract.md) | WP6 dependency matrix, evidence schema, locked thresholds, scenario matrix, redaction boundary, and live completion rule | Supporting evidence |
| [Healthcare Pilot Compliance Boundary](./healthcare-pilot-compliance-boundary.md) | WP7 healthcare data-flow inventory, control-state matrix, authoritative sources, vendor/owner gates, P0/P1 remediation, and production signoff checklist | Supporting evidence |
| `docs/audit/` | Historical product, architecture, UX, security, cost, and backlog findings | Intake/reference only; tasks must be promoted into this document before execution |
| `docs/CONSOLE_REDESIGN_PLAN.md` and `docs/CONSOLE_REDESIGN/` | Historical admin/tenant/operations console planning | Reference only; not a competing GTM plan |
