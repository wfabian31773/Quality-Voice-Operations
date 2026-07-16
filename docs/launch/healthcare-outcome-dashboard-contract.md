# Healthcare Outcome Dashboard Contract

**Execution:** `GTM-006`
**Work package:** WP4 — complete receptionist workflow and dashboard evidence
**Status:** Complete for deterministic workflow and focused-portal proof; production gated by WP6/WP7
**Schema decision:** Reuse existing tenant-scoped records; no migration is authorized or required.

## Purpose

This contract defines the one tenant-facing projection that traces a healthcare receptionist call into staff work. It does not create a second agent runtime or a generic workflow surface. The Master Voice Agent remains the only voice runtime; the healthcare role package supplies the structured outcome.

## Durable sources of truth

| Evidence | Existing source | Required tenant key | Contract use |
| --- | --- | --- | --- |
| Call identity, language, lifecycle, recording policy | `call_sessions` | `tenant_id` + `id` | Call and policy state |
| Transcript availability and content | `call_transcripts` and encrypted `call_sessions.context.transcript` | `tenant_id` + `call_session_id` | Transcript evidence |
| Structured receptionist outcome | `outbox_messages.payload` (`answering_service_ticket`) | `tenant_id` + `call_log_id` | Durable request and summary |
| External-delivery truth | `outbox_messages.status`, `last_error`, `context` | `tenant_id` + `id` | Pending, sent, retry, or dead-letter evidence |
| Customer follow-up record | `tickets.call_id` | `tenant_id` + `call_id` | Owner, priority, status, and staff action |
| Tool truth | `tool_invocations` | `tenant_id` + `call_session_id` | Confirmed result or failure |
| Human escalation | `escalation_tasks` | `tenant_id` + `call_session_id` | Reason, priority, owner, and state |
| Call audit trail | `call_events` | `tenant_id` + `call_session_id` | Transfer/escalation evidence |

All reads must include the authenticated `req.user.tenantId`; a client-supplied tenant identifier is never accepted.

## Typed projection

The tenant API returns a `HealthcareOutcomeDashboardProjection` with:

- call ID, language, lifecycle, and timestamps;
- caller identity and contact, kept distinct from optional patient identity;
- caller intent, concise persisted summary, outcome type, requested action, urgency, callback preference, verification and consent state, and evidence sources;
- transcript state and explicit recording policy/status;
- durable outbox delivery state and error evidence;
- local ticket ID/number, owner, priority, status, and next action when available;
- latest relevant tool status, result reference, and failure evidence;
- latest human-escalation task, reason, priority, owner, and status;
- a conservative operational-value statement backed only by durable evidence.

The projection must never claim that an appointment is booked. `appointment_request` means staff review is required until a separately confirmed scheduling tool proves booking.

## State rules

| Condition | Customer-facing state | Required wording/behavior |
| --- | --- | --- |
| Outbox write succeeds; local ticket exists | `staff_follow_up_created` | Link to the focused ticket and show its real status/owner |
| Outbox write succeeds; local ticket projection fails | `durably_queued` | Show the durable request in Calls; do not claim a ticket exists |
| Idempotent replay after projection failure | `staff_follow_up_created` after repair | Reuse the outbox record and create at most one local ticket |
| Outbox delivery is retrying or dead-lettered | `delivery_attention_required` | Show the stored failure; do not show success |
| Tool execution fails | `tool_failed` | Show failure and recovery/escalation evidence |
| Human escalation exists | `human_follow_up_required` | Show the task state in Calls and use the focused portal for follow-up |
| No supported outcome evidence exists | `none` | Do not infer recovered revenue or opportunity |

## Recording policy

QVO does not currently persist call audio in the production voice path. Every newly created call therefore persists the explicit policy state `{ policy: "disabled", status: "not_recorded" }` in `call_sessions.context`. The dashboard may show that truthful state, but it must not fabricate a recording URL. Any future recording enablement requires a compliance-approved policy, encrypted storage, retention controls, and a separately recorded execution scope.

## Operational-value boundary

Allowed evidence is limited to statements such as “staff follow-up created,” “request durably queued,” or “human follow-up required.” WP4 must not attach a dollar amount, label revenue as recovered, or attribute an appointment outcome without a confirmed downstream event.

## Portal boundary

The projection is rendered in the existing customer-facing Calls and Tickets surfaces. Staff must not need Agent Builder, Marketplace, workflow, developer, intelligence, or operations routes to inspect the outcome or open the follow-up ticket.

## Verification checklist

- [x] Appointment request persists to the durable outbox with a concise summary.
- [x] Local ticket projection is idempotent and repairs after a prior optional failure.
- [x] Transcript lines and recording-policy state persist.
- [x] Tenant-isolated API returns the typed projection.
- [x] Calls renders structured outcome, tool/delivery truth, and escalation evidence.
- [x] Tickets renders outcome and next action and links to the actionable detail.
- [x] Tool, outbox, projection, and escalation failures never display false success.
- [x] Focused integration and browser-level staff-follow-up tests pass.
- [x] Modified-scope coverage is at least 80%.
- [x] Typecheck, lint, production builds, and full-suite comparison introduce no regressions.

## Implemented behavior

- `createServiceTicket` persists a bounded summary and complete staff-ready outcome to the tenant-scoped durable outbox.
- The local ticket projection uses a tenant/call/outcome advisory lock, reuses an existing ticket, and repairs a missing ticket on idempotent replay.
- A failed optional ticket projection remains a truthful durable queue; a failed outbox write remains a failed tool result.
- New call sessions persist `{ policy: "disabled", status: "not_recorded" }`; transcript updates also persist normalized, tenant-scoped lines.
- `GET /calls/:id/outcome` composes the projection from existing records and returns 404 rather than crossing a tenant boundary.
- Calls lists the outcome and next action; its drawer shows structured, delivery, tool, escalation, transcript, recording, and operational-value evidence.
- Tickets lists the receptionist outcome and renders the same evidence on the actionable ticket detail.
- Human escalation transactionally creates or reuses the call's focused ticket, and notification links target Calls rather than the internal operations console.
- The shared Modal always keeps custom panels above its backdrop; this closed the browser-discovered click interception on the follow-up link.

## Access and safety evidence

- All projection queries bind the authenticated tenant ID and call/ticket ID as parameters.
- Tenant members may read focused Calls/Tickets evidence; only the existing owner/operations-manager write gate may advance or assign tickets.
- A read-only tenant role is denied ticket status updates.
- Caller and optional patient identity remain distinct.
- The projection reports only recorded outbox/tool/escalation state and never infers a booking, recovered revenue, or dollar value.
- No schema, migration, public marketing route, backend deletion, or second agent runtime was added.

## Verification evidence

| Gate | Result |
| --- | --- |
| Failing-first development | Missing projection module, transcript/policy persistence, replay repair, tenant API, component, and escalation-ticket tests failed before implementation |
| Focused regression | 13 test files / 104 assertions pass |
| WP4-owned coverage | 91.09% statements, 83.47% branches, 95.23% functions, 95.80% lines |
| Browser flow | `pnpm run test:e2e:healthcare-outcome` passes login → Calls → outcome → ticket → status advancement |
| Manual browser inspection | Focused navigation, aligned Calls table, outcome evidence, recording state, transcript, ticket link, and in-progress ticket verified |
| Client typecheck | Pass |
| Affected-path root TypeScript | Zero errors; repository retains 273 pre-existing errors elsewhere |
| ESLint | Zero source errors |
| Production builds | Tenant app and public app pass |
| Diff guard | Pass |
| Full-suite comparison | 5,886 assertions: 5,496 pass, 261 fail, 129 pending; baseline was 5,480 pass, 263 fail, 129 pending; zero relevant failures |

## Changed-file manifest

| Area | Files | Purpose |
| --- | --- | --- |
| Contract and projection | `shared/receptionist/healthcareOutcomeDashboard.ts`, `server/admin-api/services/healthcareOutcomeDashboard.ts` and tests | Typed projection and tenant-scoped composition |
| Durable workflow | `createServiceTicketTool.ts`, `callPersistence.ts`, `HumanEscalationService.ts` and focused tests | Summary, idempotent projection repair, transcript/policy persistence, escalation-ticket reuse |
| Tenant APIs | `server/admin-api/routes/calls.ts`, `server/admin-api/routes/tickets.ts` and tests | Outcome endpoint, list evidence, ticket-detail projection, role/tenant checks |
| Focused portal | `HealthcareOutcomeCard.tsx`, `Calls.tsx`, `Tickets.tsx`, `TicketDetail.tsx`, `Modal.tsx` and tests | Actionable evidence, ticket navigation, browser-discovered stacking fix |
| Browser proof | `tests/e2e/healthcareOutcomeStaffFollowUp.spec.ts`, `package.json` | Self-contained deterministic staff workflow and one-command runner |
| Execution evidence | This document and `qvo-gtm-execution-control.md` | Decision, scope, proof, remaining gates, and next task |

## Remaining production gates

WP4 does not claim a credentialed audio recording. WP6 must prove the real Twilio/OpenAI audio-to-outcome path, and WP7 must approve PHI, recording/consent, retention, and pilot operating boundaries. Those external gates do not invalidate the completed deterministic outcome-to-dashboard contract.
