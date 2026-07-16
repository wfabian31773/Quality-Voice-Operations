# Healthcare Receptionist Role Package

**Work package:** WP3
**Execution:** `GTM-004`, completion audits `GTM-005` and `GTM-009`
**Role package:** `healthcare-receptionist@1.0.0`
**Master Voice Agent contract:** `1.0.0`
**Status:** Deterministic implementation and verification complete; production activation remains gated by the WP2 live gold evaluation and WP7 compliance approval.

## Purpose and architecture

This package configures the one QVO Master Voice Agent to perform the managed healthcare receptionist role. It does not create a healthcare-specific agent engine, select another model, create another realtime session class, or permit tenant content to replace the approved role and core policies.

The deployment formula remains:

`Master Voice Agent 1.0.0 + healthcare-receptionist 1.0.0 + tenant context = healthcare receptionist deployment`

The core contract, locked model, session defaults, multilingual policy, turn-taking policy, memory model, time context, and core version did not change. WP3 added a declarative role package, registered it with the existing compiler/loader, extended the existing staff-outcome tool, and hardened the shared reasoning integration needed to enforce the new role safely. Because the production core has not passed its credentialed live gold evaluation, this hardening remains part of the pre-activation `1.0.0` candidate. After the live core lock, any core-invariant change requires a semantic version change and a complete reevaluation.

## Role contract

The healthcare receptionist must:

- identify itself as the practice's AI receptionist;
- answer only approved operational questions from approved knowledge;
- collect minimum-necessary information for one accurate staff-ready outcome;
- treat appointment, reschedule, cancellation, callback, refill, records, billing, and staff actions as requests until an authoritative tool or human confirms completion;
- direct a life-threatening emergency to 911 immediately, before collecting information;
- escalate urgent clinical issues, medical questions, explicit human requests, policy uncertainty, and tool failure;
- never diagnose, triage clinically, prescribe, interpret results, recommend treatment, or advise medication changes;
- use the core multilingual capability without selecting a separate language-specific agent or session; and
- state success only after the responsible tool confirms durable success.

## Staff-ready outcome contract

| Field | Requirement | Classification/constraint |
| --- | --- | --- |
| Caller first and last name | Required for a persisted outcome | PII |
| Caller phone | Required and phone validated | PII |
| Confirmed callback number | Required and phone validated | PII |
| Caller type | Required; patient, caregiver, pharmacy, lab, facility, referring office, or other | PHI context |
| Caller-stated reason | Required; neutral statement, not a diagnosis | PHI |
| Outcome type | Required and allowlisted | PHI context |
| Requested action | Required; exact action requested of staff | PHI context |
| Urgency | Required and allowlisted | Caller-stated operational urgency |
| Callback preference | Required; never a promised callback time | PHI context |
| Identity-verification status | Required | `unverified`, `partially_verified`, `verified`, or `not_required` |
| Consent to contact | Required boolean | No implied consent |
| Evidence source | Required non-empty allowlist | Caller statement, caller ID, verified record, or tool result |
| Date of birth | Conditional | Collect only when required for patient-specific verification |
| Patient identity/contact | Conditional | Separate from caller identity; collect only when a different patient's reference is necessary |
| Organization name | Required for pharmacy, lab, facility, and referring-office callers | Never collect the professional caller's DOB |

The supported persisted outcome types are appointment request, reschedule request, cancellation request, callback request, billing question, prescription-refill request, records request, staff message, general question, and urgent escalation.

## Tools and truthfulness controls

| Tool | Role permission | Required proof before execution | Truthfulness rule |
| --- | --- | --- | --- |
| `createServiceTicket` | Allowed | Complete structured outcome, confirmed callback number, consent, verification state, and evidence sources | A durable outbox success means submitted for staff review; it never means an appointment or clinical action is complete |
| `lookupSchedule` | Allowed, read-only | Verified identity and a lookup identifier | Never claims availability, booking, reschedule, or cancellation |
| `escalate_to_human` | Allowed | Accurate escalation reason; priority when applicable | Never claims a transfer completed unless the handoff path confirms it |

The ticket tool validates allowlisted enums, caller and patient phone formats, bounded text, professional-caller organization, required evidence, and tenant/call/outcome-scoped idempotency. A carrier call SID is preferred; a persisted call-log ID is the fallback, and the handler refuses a healthcare side effect if neither exists. An idempotent outbox hit does not create another local ticket or connector dispatch. Optional local projection or connector failure does not erase an already durable outbox result, and durable failure never returns a success claim. Legacy answering-service calls without a healthcare outcome retain their existing payload behavior.

Human escalation uses a role/call-scoped idempotency key, a transaction-level advisory lock, and an existing-task lookup before insertion. A duplicate invocation returns the existing escalation and does not fan out another notification. The active role tool schema—not the legacy global answering-service schema—governs realtime input validation.

## Multilingual and scenario evidence

The role has AI-disclosing greetings in English, Spanish, French, German, Portuguese, Italian, Dutch, Chinese, Japanese, Korean, Arabic, and Hindi. The acceptance suite requires English, Spanish, French, German, Portuguese, Chinese, and a Chinese/English code switch while keeping the same Master Voice Agent session.

The deterministic healthcare suite covers all 15 required scenario categories:

1. New appointment request.
2. Reschedule request.
3. Cancellation request.
4. Callback request.
5. Billing question.
6. Refill request with a language change.
7. Records request.
8. Approved operational fact.
9. Explicit human request.
10. Life-threatening emergency.
11. Urgent post-procedure concern.
12. Medical-advice refusal.
13. Pharmacy/business-to-business coordination.
14. Required-tool failure.
15. Missed-call recovery.

Recorded audio, measured latency, real interruption behavior, and live Twilio/OpenAI tool execution are not represented as WP3 proof. They remain mandatory WP2/WP6 production-activation evidence.

## Security review

- Tenant database prompts cannot replace the approved healthcare role contract.
- Arbitrary `system_prompt` and legacy `customInstructions` metadata cannot enter the healthcare role. Optional practice facts must be a bounded object using only the categories hours, locations, services, insurance, contact, preparation, and routing; instruction-like content is rejected.
- Tenant metadata cannot relabel the implementation as an unapproved role-package version. Every healthcare/answering-service alias resolves to the locked `healthcare-receptionist@1.0.0`, and the deployment manifest marks the version as locked.
- Practice identity is validated as bounded, printable, non-instructional data. Invalid identity falls back to a neutral practice label rather than entering the role prompt.
- Caller ID enters the role prompt only when it is strict E.164. Malformed or instruction-like caller-ID text is treated as unavailable.
- Tool permissions deny unrelated vertical capabilities, and deployment overrides may disable but never expand the healthcare allowlist.
- Patient-specific schedule lookup requires verified identity.
- Emergency and clinical behavior fails toward 911 or human escalation, never model-generated medical judgment.
- Required tool inputs are validated before durable persistence.
- Logs record tenant/call/tool state and invalid field names without adding raw sensitive values to new warning events.
- Ticket idempotency is scoped by tenant, role, stable call identifier, and outcome type. Human escalation is transactionally deduplicated by tenant, role, call, and action.
- Professional-caller identity is preserved through outbox and ticketing normalization without inventing patient identity.
- No public API, database schema, migration, or retained backend object was deleted by this package.
- The repository dependency audit still reports pre-existing high/critical advisories in shared packages. No dependency manifest or lockfile change belongs to WP3, and no forced audit remediation was applied.

## Changed-file manifest

### Role package and registration

- `platform/agent-templates/healthcare-receptionist/rolePackage.ts` — role objective, prompt, greetings, tools, data requirements, and guardrails.
- `platform/agent-templates/healthcare-receptionist/scriptedScenarios.ts` — required scenario and language matrix plus deterministic evaluator.
- `platform/agent-templates/healthcare-receptionist/index.ts` — package exports.
- `platform/agent-templates/healthcare-receptionist/manifest.json` — managed-service metadata and locked configuration fields.
- `platform/agent-templates/registry.ts` — role registration.
- `platform/agent-templates/toolPermissions.ts` — healthcare allow/deny policy.
- `server/voice-gateway/services/agentLoader.ts` — answering-service aliases resolve to the approved role; database prompts cannot replace it.

### Outcome, safety, and runtime integration

- `platform/agent-templates/answering-service/tools/createServiceTicketTool.ts` — structured healthcare outcome, validation, idempotency, and truthful durable-result handling.
- `platform/integrations/connectors/adapters/ticketing.ts` — caller-first normalization with an optional, distinct patient reference.
- `platform/reasoning/types.ts` — healthcare receptionist role identifier.
- `platform/reasoning/SafetyGate.ts` — healthcare structured-evidence, schedule-verification, and medical-response controls.
- `platform/reasoning/ReasoningEngine.ts` — one fail-closed tool authorization entrypoint, including multilingual structured evidence.
- `server/voice-gateway/services/openaiSession.ts` — shared authorization entrypoint used by tool calls.
- `platform/tools/ToolRegistry.ts` — validates tool input against the active compiled role schema.
- `platform/tools/HumanEscalationService.ts` — transactionally idempotent human-escalation creation and duplicate-notification suppression.
- `server/voice-gateway/routes/stream.ts` — normalized compiled role ID reaches telephony and widget authorization.

### Tests

- `platform/agent-templates/healthcare-receptionist/rolePackage.test.ts`
- `platform/agent-templates/healthcare-receptionist/scriptedScenarios.test.ts`
- `platform/agent-templates/answering-service/tools/createServiceTicketTool.healthcare.test.ts`
- `platform/agent-templates/toolPermissions.healthcare.test.ts`
- `platform/reasoning/healthcareReceptionistSafety.test.ts`
- `platform/integrations/connectors/adapters/ticketing.healthcare.test.ts`
- `platform/tools/HumanEscalationService.idempotency.test.ts`
- `platform/tools/registerTools.test.ts`
- `tests/voice-gateway/healthcareReceptionistIntegration.test.ts`
- `server/voice-gateway/services/agentLoader.test.ts`
- `tests/agentLoader.greeting-translations.test.ts`

## Final integrity audit — `GTM-009`

The final completion audit re-derived every WP3 requirement from the canonical execution document and inspected the current implementation rather than relying on the earlier completion label. Three gaps were reproduced with failing tests and repaired:

1. Tenant `metadata.rolePackageVersion` could relabel the same implementation as an arbitrary semantic version. The healthcare path now supplies a locked role identity to the shared compiler finalization step, direct construction rejects unapproved versions, aliases retain `1.0.0`, and the manifest locks the field.
2. An instruction-like practice name could enter the role prompt and greeting. The shared role validator now rejects it, while the loader safely substitutes `our healthcare practice` without logging the raw value.
3. Untrusted caller-ID text could enter the role prompt. Only strict E.164 caller ID is now admitted; all other values become “Caller ID is unavailable.”

The audit did not create a new model, runtime, constructor, session, healthcare engine, schema, migration, or public API. It tightened role/deployment input boundaries around the existing Master Voice Agent `1.0.0` contract.

The first root-suite comparison also exposed an existing WP6 diagnostic race: a valid zero-millisecond WebSocket upgrade was classified as “not connected” because latency was tested by truthiness. The diagnostic now checks whether connection evidence exists, and a fixed-clock regression proves the correct `session_setup / closed_early` result. This verification repair does not change live call construction, model/session policy, or role behavior.

## Verification record

| Check | Result |
| --- | --- |
| Failing-first role/tool/alias tests | Observed failing before implementation |
| Final Task 3 focused suite | 15 files, 132 tests passed |
| Realtime diagnostic fixed-clock regression | 6/6 tests pass, including a deterministic zero-millisecond connection |
| Hardened role-package and loader coverage | 91.35% statements / 81.01% branches / 100% functions / 93.24% lines |
| Healthcare role package alone | 95.08% statements / 89.79% branches / 100% functions / 96.36% lines |
| Changed production-file ESLint | Passed with zero errors |
| Diff whitespace and manifest/lockfile guard | Passed |
| Client typecheck | Passed |
| Production app and public builds | Passed; 65 sitemap URLs generated; remote case-study fetch unavailable and skipped as designed |
| Root TypeScript project | 273 pre-existing errors in unrelated routes/tests; no changed Task 3 path reported |
| Full Vitest comparison | 5,544 passed / 257 failed / 129 skipped across 5,930 assertions versus the GTM-008 baseline of 5,540 / 257 / 129 across 5,926; all four new assertions pass and no Task 3 failure exists |

The full-suite failing files remain outside the healthcare role, reasoning, loader, voice-session, and route-integration scope. They include missing-database security tests, stale UI/source assertions, local-storage environment failures, and unrelated integration/UI defects already present in the repository baseline.

## Production activation gates

WP3 is complete as an implemented and deterministically verified role package. It is not authorization to accept production healthcare traffic. Activation still requires:

- WP2 recorded/live gold evaluation and measured latency/interruption evidence;
- WP4 end-to-end persistence and focused-dashboard proof;
- WP6 real Twilio/OpenAI/database validation;
- WP7 PHI, recording, retention, vendor, and compliance approval; and
- WP10 pilot-customer acceptance.
