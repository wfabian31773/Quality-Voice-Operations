# Healthcare-First Demo Contract

**Execution:** `GTM-007`
**Work package:** WP5 — healthcare-first demo
**Status:** Complete for deterministic guided proof
**Production boundary:** Guided deterministic workflow; credentialed live audio remains WP6.

## Purpose

The public demo must make one proposition obvious: QVO answers a healthcare call, safely captures what staff need, invokes the approved function contract, and leaves a truthful follow-up outcome. It must not look like a generic agent marketplace, imply that an appointment was booked, or introduce a demo-only agent runtime.

## Runtime identity

| Layer | Required identity |
| --- | --- |
| Core | Master Voice Agent `1.0.0` |
| Role package | `healthcare-receptionist@1.0.0` |
| Tool | Production `createServiceTicket` input/validation/result contract |
| Outcome | WP4 `HealthcareOutcomeDashboardProjection` |
| Demo persistence | Resettable in-memory adapter injected through the production tool boundary; never a second tool implementation |

The demo must fail its architecture test if it hard-codes a different model, creates another voice-agent constructor, or bypasses the role/tool contracts.

## Prospect journeys

### Appointment-request journey

1. The assistant identifies itself as QVO's virtual receptionist.
2. The caller begins in Spanish and code-switches to English.
3. The caller interrupts; the assistant yields and resumes without losing context.
4. The assistant uses an injected current date/time and states it truthfully.
5. Caller and optional patient identity remain distinct.
6. The assistant captures reason, urgency, requested action, callback preference, consent, verification state, and evidence source.
7. The production `createServiceTicket` contract returns confirmed durable and local demo results.
8. The public experience renders the same structured WP4 outcome without exposing a tenant/internal route.

### Safe-escalation journey

1. The caller asks for clinical advice or describes an emergency signal.
2. The assistant does not diagnose or recommend treatment.
3. The assistant advises emergency services for an immediate emergency and records a human follow-up/escalation outcome.
4. The demo does not claim a transfer succeeded unless the returned evidence says it did.

## Claim boundary

Allowed claims are limited to evidence present in the scenario result: request durably queued, staff follow-up created, human follow-up required, transcript available, and tool result confirmed.

The demo must not claim:

- an appointment was booked or confirmed;
- a transfer completed without confirmed evidence;
- recovered revenue or a dollar value;
- HIPAA compliance or a compliance guarantee;
- diagnosis, treatment, clinical advice, or clinician status;
- a real live call when the deterministic guided scenario is running.

## Interface contract

- One healthcare receptionist, not a grid of selectable agents.
- Two bounded scenarios: appointment request and safe escalation.
- Visible core/role lock, guided-demo disclosure, language/turn/interruption evidence, transcript, tool state, and staff-ready outcome.
- Start, replay/reset, and scenario-switch controls with deterministic state.
- A focused sales CTA after the proof.
- No Agent Builder, marketplace, workflow, templates, campaigns, or generic platform messaging.

## Verification checklist

- [x] Production core and role versions are imported, not duplicated.
- [x] Appointment scenario executes the production tool contract.
- [x] Scenario result uses the WP4 projection type and component.
- [x] Code-switch, interruption, memory continuity, and current date/time are visible.
- [x] Safe escalation refuses clinical advice and shows human follow-up evidence.
- [x] Claim audit rejects every prohibited claim.
- [x] Demo reset produces the identical initial state and can be replayed.
- [x] Component and API tests fail before implementation and pass afterward.
- [x] Real-browser prospect journey passes at desktop and mobile widths.
- [x] Modified-scope coverage is at least 80%.
- [x] Typecheck, lint, builds, and full-suite comparison introduce no regressions.

## Implementation evidence

The generic eight-agent showcase has been replaced by a focused healthcare proof. Both scenarios execute `executeHealthcareDemoScenario`, which imports the locked core and healthcare role versions, verifies that the role permits `createServiceTicket`, invokes the production tool handler, and composes the result through `buildHealthcareOutcomeDashboardProjection`. The injected local projector replaces only demo persistence; production validation, idempotency scope, outbox payload, confirmation wording, and result semantics remain the real implementation.

The public endpoint `POST /demo/healthcare/run` accepts only `appointment_request` or `safe_escalation`, optionally accepts a bounded valid ISO clock for deterministic verification, is rate limited, requires no prospect data, and performs no database access. Every run starts from an empty in-memory adapter, so the UI's **Reset demo** control and a replay produce the same initial state without cleanup jobs or retained PHI.

The prospect UI proves:

- Master Voice Agent `1.0.0` plus `healthcare-receptionist@1.0.0`, not a menu of agent engines;
- Spanish-to-English code switching, caller interruption, retained details, and clinic-local date context;
- production `createServiceTicket` success and the exact WP4 staff outcome component;
- emergency-services direction, a non-diagnosis boundary, and pending human follow-up;
- delivery, tool, transcript, recording-policy, ownership, status, and next-action truth;
- a clear guided-workflow disclosure and no internal ticket link or unsupported completion claim.

## Verification evidence

| Gate | Result |
| --- | --- |
| Failing-first baseline | Scenario module missing, injected projector unused, endpoint returned 404, and old generic UI failed the new contract as expected |
| Focused regression | 4 files, 48 tests passing |
| Modified-scope coverage | 86.73% statements, 81.73% branches, 85.48% functions, 89.30% lines |
| Client TypeScript | Passing |
| Root TypeScript comparison | 273 pre-existing errors; zero errors in WP5 affected paths |
| Lint | All WP5 implementation, test, and browser-spec paths passing |
| Production builds | Application and public builds passing |
| Browser proof | `pnpm run test:e2e:healthcare-demo` passes appointment, reset, escalation, claim, internal-link, desktop, and 390px overflow checks |
| In-app inspection | Confirmed public disclosure, readable transcript/evidence sequence, shared outcome card, corrected CTA contrast, one main landmark, and no internal ticket link |
| Root-only full suite | 5,901 assertions: 5,515 pass, 257 fail, 129 skipped; previous WP4 comparison was 5,496 pass, 261 fail, 129 skipped across 5,886 assertions; zero WP5-relevant failures |

The remaining full-suite failures are the recorded environment/repository baseline classes: missing `DATABASE_URL`, invalid injected `--localstorage-file`, and unrelated stale/source assertions. WP5 adds no relevant failure and improves the aggregate failure count by four while adding passing coverage.

## Changed-file manifest

| File | Purpose |
| --- | --- |
| `shared/demo/healthcareDemo.ts` | Shared scenario/result, transcript, timeline, and signal contract |
| `platform/demo/healthcareDemoScenario.ts` | Deterministic production-shaped appointment and escalation execution plus claim audit |
| `platform/demo/healthcareDemoScenario.test.ts` | Core/role/tool/projection, behavior, reset, invalid-scenario, and prohibited-claim proof |
| `platform/agent-templates/answering-service/tools/createServiceTicketTool.ts` | Injectable local projection boundary while retaining production default behavior |
| `platform/agent-templates/answering-service/tools/createServiceTicketTool.healthcare.test.ts` | Production validation/outbox preservation proof for the injected projector |
| `server/admin-api/routes/demo.ts` and `server/admin-api/routes/demo.test.ts` | Rate-limited bounded public scenario endpoint and no-database tests |
| `client-app/src/pages/Demo.tsx` | Focused healthcare proof, reset/retry, claim-safe evidence, and GTM CTA |
| `client-app/src/components/HealthcareOutcomeCard.tsx` | Reuse the WP4 component publicly without exposing its authenticated ticket link |
| `tests/marketing/demoLiveExperience.test.tsx` | Public UI, analytics, failure, reset, and safe-escalation regression contract |
| `tests/e2e/healthcareDemoGtm.spec.ts` | Self-contained real-browser desktop/mobile prospect journey |
| `package.json` | One-command `test:e2e:healthcare-demo` operator proof |
| `docs/launch/healthcare-demo-contract.md` and `docs/launch/qvo-gtm-execution-control.md` | Canonical contract, evidence, status, and next dependency |

## Operator procedure

1. Run `pnpm run test:e2e:healthcare-demo` for a one-command production-shaped proof with synthetic deterministic data.
2. Open `/demo`, choose a scenario, and run it.
3. Use **Reset demo** before switching a prospect narrative or repeating the appointment journey.
4. Never describe this workflow as a live phone call. Credentialed Twilio/OpenAI audio, carrier behavior, and production service evidence belong to WP6.

## Completion decision

`GTM-007 / WP5` is complete for its authorized deterministic boundary. It does not activate the product for real patient calls. Production remains gated by WP6 real voice-runtime proof and WP7 compliance/PHI approval.
