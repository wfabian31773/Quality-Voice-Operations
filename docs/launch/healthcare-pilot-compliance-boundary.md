# QVO Healthcare Pilot Compliance Boundary

**Execution:** `GTM-010`, hardened by `GTM-011`–`GTM-014`
**Work package:** WP7, Tasks 7.0–7.4
**Evidence date:** 2026-07-12
**Status:** Engineering controls and the production-equivalent database/migration/RLS gate are verified; caller-key reconciliation, retention/deletion proof, independent owner evidence, readiness approval, and production PHI activation remain blocked

## 1. Launch decision

QVO is **not approved for production PHI traffic** by this document. Until every activation gate in section 9 is signed, the permitted boundary is:

- synthetic test identities and synthetic call content only;
- call recording disabled (`policy=disabled`, `status=not_recorded`);
- no representation that QVO is HIPAA compliant, HIPAA-ready, certified, covered by a complete BAA chain, GDPR/CCPA compliant, or contractually committed to a processing region;
- no clinical advice, diagnosis, treatment guidance, result interpretation, or clinical triage;
- emergency-first direction to call 911 or the local emergency number before collecting data;
- minimum-necessary operational intake for appointment requests, messages, and staff follow-up;
- no production activation based only on code tests, a vendor feature page, or this inventory.

This is an engineering and operating-control record, not legal advice or compliance approval.

## 2. Control-state legend

| State | Meaning |
| --- | --- |
| `VERIFIED IN CODE` | Deterministic code/test evidence exists in this worktree. |
| `PARTIAL` | A control exists, but coverage is incomplete or a contradictory path remains. |
| `ENVIRONMENT` | Code supports the control, but production configuration/evidence is unavailable. |
| `MISSING` | Required engineering control or complete evidence does not exist. |
| `OWNER/VENDOR` | Requires a named legal, compliance, infrastructure, customer, or vendor owner. |

## 3. Healthcare data-flow inventory

| Stage | Data classes | Repository evidence | Current protection | State / launch consequence |
| --- | --- | --- | --- | --- |
| Carrier ingress | live audio, caller/called number, Twilio call SID, carrier metadata | `server/voice-gateway` Twilio media path; `healthcare_deployment_approvals` | Signed webhook, required production WebSocket token, and a tenant/agent/version/evidence activation gate now deny unapproved healthcare calls before streaming and again at the start frame; production account, number, transport, and BAA evidence are not recorded | `VERIFIED IN CODE` gate + `ENVIRONMENT` + `OWNER/VENDOR`; no production PHI approval exists |
| Realtime model | live audio, partial/final transcript, role prompt, operational facts, current date/time, tool arguments/results | Master Voice Agent runtime and `healthcare-receptionist@1.0.0` | One locked core/role contract; prompt injection and tool permissions tested | `PARTIAL`; OpenAI org/model/retention/BAA eligibility must be approved |
| Session | caller/called number, transcript, summary, outcome, escalation, recording state | `migrations/005_call_lifecycle.sql`; `callPersistence.ts` | caller number and the full transcript copied into session context use envelope encryption; recording defaults disabled | `PARTIAL`; other JSON/text fields and infrastructure encryption are not fully proven |
| Transcript lines | speaker role and utterance content | `call_transcripts.content` | tenant RLS exists | `MISSING`; normalized transcript lines are plaintext at the application-field layer |
| Call events | lifecycle state and arbitrary JSON payload | `call_events.payload` | tenant RLS; partition retention exists for this table | `PARTIAL`; payload PHI minimization/encryption is not complete |
| Tool execution | tool name, input, output, error, timing | `tool_invocations` | tenant RLS and role/tool schema checks | `PARTIAL`; input/output/error remain plaintext-capable JSON/text |
| Durable delivery | callback/outcome payload, provider error, retry state | `outbox_messages` | tenant RLS, idempotency, lease/retry controls | `PARTIAL`; payload and error fields remain plaintext-capable; connector destinations need approval |
| Staff outcomes | subject, description, notes, caller details, metadata, ownership | `tickets`; `escalation_tasks` | tenant RLS and role-scoped APIs; durable idempotent projection | `PARTIAL`; several PHI-capable fields remain plaintext at the application-field layer |
| Cross-call memory | caller phone, patient name/DOB, preferences and prior context | `PiiLookupHash.ts`; `callPersistence.ts`; `platformAdapters.ts`; `CallerLookupHashBackfill.ts` | new sessions persist a purpose- and tenant-separated HMAC plus key version; reads use current and one explicitly versioned previous candidate during rotation; a bounded resumable job can reconcile historical rows without outputting numbers | `PASS FOR DEMO TARGET`; guarded backfill reconciled all 14 demo rows, healthcare scope is `3/3` current with zero missing/stale, and no key or caller identifier was emitted |
| Knowledge | practice facts, article content, embeddings | `knowledge_articles`; role-package fact categories | tenant RLS; role restricts knowledge to approved operational facts | `PARTIAL`; content/embedding fields are plaintext-capable and approval/provenance workflow is not complete |
| Logs and audit | identifiers, errors, changes, IP, user agent, arbitrary context | `redact.ts`; `audit_logs`; `error_logs` | PHI redaction utility and append-only audit controls exist | `PARTIAL`; regex redaction is not proof of complete PHI removal from every logging sink |
| Portal/API | transcripts, summaries, outcomes, phone display, tickets | Calls/Tickets contract and tenant APIs | tenant context, role guards, RLS, focused customer UI | `PARTIAL`; production access assignments, MFA, session, export, and support-access evidence are environment/owner controlled |
| Export | tenant, users, agents, numbers, sessions, audit rows | `/privacy/export` in `legalCompliance.ts` | owner guard and audit log | `PARTIAL`; export is capped and does not prove coverage of transcripts, tools, outbox, tickets, escalation, backups, logs, or vendors |
| Deletion | tenant-linked rows and downstream vendor copies | scheduled deletion route; `healthcareDataControlManifest.ts`; `HealthcareDeletionVerificationService.ts` | admin execution discovers every live public `tenant_id` table, blocks unclassified/unsafe stores, explicitly removes approved non-cascade stores, verifies zero first-party rows before commit, and retains a redacted evidence record | `PARTIAL`; fail-closed first-party verification is implemented, but the production-equivalent schema has not been classified/run and vendor, backup, cache, file, legal-hold, and restoration behavior still requires evidence |
| Backups/object storage | database snapshots, logs, media/import objects | no production evidence in repository | none provable from code | `OWNER/VENDOR`; retention, encryption, location, restore access, and destruction evidence required |

## 4. Verified engineering invariants

- `createCallSession` envelope-encrypts a supplied caller number.
- New call sessions start with recording disabled and not recorded.
- RLS is enabled for call sessions, events, transcript lines, tool invocations, outbox messages, tickets, escalation tasks, and knowledge articles.
- The healthcare role says it is an AI receptionist, is not a clinician, and must not pretend to be human.
- The role prohibits diagnosis, clinical triage, medication changes, medical advice, and patient-specific knowledge without identity verification.
- Emergency language directs the caller to 911 or the local emergency number before details or tools.
- The role permits only the healthcare outcome tool, schedule lookup, and human escalation.
- Public compliance posture now fails closed: every framework is `not_verified`, BAA availability is false, approved plans are empty, and residency is not contractually committed.
- Public security, landing, pricing, healthcare, privacy, subprocessor, DPA, and deletion-email copy no longer turns an unverified control into a positive claim.
- A healthcare deployment has no implicit default: inbound, outbound, Twilio stream, and widget entry points deny the healthcare role unless an active tenant-and-agent approval matches core `1.0.0`, model `gpt-realtime-2`, role package `healthcare-receptionist@1.0.0`, recording disabled, live evidence, and a live independently verified activation-readiness attestation.
- Synthetic approvals contain only purpose-separated caller HMACs and expire within 30 days; raw test numbers are not stored or returned. Production records expire within 90 days and require the complete bounded evidence-reference set.
- Only platform administrators can create, list, or revoke healthcare activation records; tenant roles cannot use those endpoints.
- Compact E.164 phone numbers are redacted from shared application logs, including international carrier metadata.
- Production/staging startup requires `VOICE_GATEWAY_STREAM_TOKEN`, a strong `QVO_PII_LOOKUP_HMAC_KEY`, and an explicit `QVO_PII_LOOKUP_HMAC_KEY_VERSION`; a previous key/version is optional only as a complete, distinct rotation pair.
- Catalog version `3.0.0` classifies all 188 final root tenant tables in ordered migrations. Equality tests model table renames, exclude compatibility views and managed partition children, preserve partitioned parents, and force every later root tenant table to receive a data-control decision.
- Production approval creation resolves all eleven references against metadata-only, digest-bound, tenant/agent/production-scoped, independently verified evidence records with an exact accountable owner role. Revoked, expired, missing, mismatched, wrong-owner, or arbitrary string references deny.
- A production approval cannot be created or honored without a short-lived readiness record binding the exact Master Voice Agent identity, catalog/schema/RLS counts, evidence snapshot, caller-HMAC reconciliation, retention proof, deletion proof, all-pass statuses, and independent platform-admin verification. Later readiness revocation or expiry denies at runtime.
- The retention contract requires an explicit owner-approved duration for every first-party, backup, and external-processor scope. The planner is read-only and supplies no engineering default or destructive execution path.

These invariants do not establish compliance by themselves.

## 5. Unresolved engineering controls

### P0 — required before production PHI

- [x] Add an explicit healthcare activation gate controlled by a versioned tenant-and-agent deployment record. This is an engineering authorization mechanism; production use still requires authentic evidence and written owner approval.
- [ ] Select and document the PHI storage strategy for every plaintext-capable transcript, event, tool, outbox, ticket, escalation, knowledge, log, and export field.
- [ ] Prove production transport, database, backup, object-storage, key-management, secret-management, and restore-path controls.
- [ ] Implement one approved retention schedule across sessions, transcript lines, events, tools, outbox, tickets, escalation, knowledge, audit/error logs, files, backups, and vendors.
- [ ] Complete deletion across all tenant tables, caches, files, backups, logs, subprocessors, and legal holds. The first-party database path now fails closed on unclassified stores and verifies zero rows, but it has not passed against the production-equivalent schema or external systems.
- [ ] Add recording enablement as a fail-closed deployment policy requiring approved disclosure, jurisdiction, purpose, retention, access, and vendor configuration.
- [ ] Prove least-privilege production roles, support access, MFA, session controls, periodic review, emergency access, and access revocation.
- [ ] Reconcile the subprocessor register with the actual production data path and each provider's approved service/configuration.
- [ ] Execute the guarded historical caller-lookup backfill and production key/rotation proof. The dual-read/write-current implementation and dry-run/apply guard are complete; historical memory remains unproven until production-equivalent reconciliation reports zero missing and stale rows.

### P1 — required for a controlled pilot operating program

- [ ] Define incident detection, severity, escalation, customer notice, evidence preservation, and accountable on-call ownership.
- [ ] Define knowledge approval, provenance, expiration, and patient-specific authorization.
- [ ] Define transcript/summary correction, staff follow-up, failed-delivery reconciliation, and manual recovery procedures.
- [ ] Add production evidence collection for RLS, retention sweeps, deletion runs, access review, backup restore, and vendor configuration.
- [ ] Validate every localized public claim against the same approved claim register.

## 6. Vendor and agreement gate

| Processor / system | Likely data | Required evidence | Owner | Status |
| --- | --- | --- | --- | --- |
| Twilio | audio stream, phone numbers, call metadata; recording only if enabled | executed BAA where required; HIPAA-eligible service list; designated account/project; security edition/configuration; region/retention/recording evidence | Infrastructure + compliance | `BLOCKED / OWNER-DEFERRED`; owner confirms no BAA and tabled outreach on 2026-07-13 while account issues are resolved; Security/Enterprise Edition and exact account/subaccount HIPAA designation must still be obtained |
| OpenAI API / Realtime | audio, transcript, prompt, tool data, identifiers | executed BAA where required; approved organization/project; exact model and endpoint eligibility; retention setting (including Modified Retention/ZDR/MAM if approved); data-control evidence | AI platform + compliance | `BLOCKED / VENDOR RESPONSE PENDING`; owner confirms no BAA or retention approval; an API BAA and Modified Retention inquiry for the exact organization/project was sent and verified in Sent Items on 2026-07-13 |
| Supabase PostgreSQL | all durable healthcare records | executed BAA plus HIPAA add-on where required; designated project; High Compliance configuration; region; encryption; keys; access; logging; actual backup/PITR window; restore; deletion; incident terms | Infrastructure + compliance | `DIRECTION APPROVED / EXECUTION DEFERRED`; Team plus HIPAA/PITR is approved for the go-live window; Pro remains demo-only until upgrade, BAA, add-ons, and controls are complete |
| Replit application hosting | live application traffic, environment secrets, logs, transient and deployed workload data | written authorization for the exact PHI-bearing workload; agreement/BAA where required; deployment visibility; region; encryption; access; logs; retention; deletion; incident terms | Infrastructure + compliance | `BLOCKED / VENDOR RESPONSE PENDING`; public security material does not establish BAA/HIPAA authorization; a written eligibility inquiry was sent and verified in Sent Items on 2026-07-13, and written eligibility or replacement hosting is still required |
| Email/SMS/connectors | outcome, callback details, message content, provider errors | minimum-necessary payload; approved recipient/destination; agreement; encryption/retention; delivery and deletion evidence | Integrations + compliance | `OWNER/VENDOR` |
| Support/monitoring/logging | errors, identifiers, traces, operator access | PHI-safe configuration; redaction validation; access/retention/deletion; incident access | Security/operations | `OWNER/VENDOR` |
| Pilot customer | caller population, workflows, notices, staff access | BAA/contract as applicable; documented instructions; approved role facts; consent scripts; retention; emergency/escalation contacts; acceptance | Customer owner + QVO compliance | `OWNER` |

Vendor marketing eligibility is not an agreement and does not prove that QVO's exact account, model, service, or configuration is approved.

## 7. Recording, consent, and clinical boundary

- Federal interception law contains a one-party-consent provision in specified circumstances, but it does not resolve stricter state law, caller location, cross-border calls, purpose-specific notices, or sector-specific requirements.
- QVO must obtain jurisdiction-specific counsel and customer approval before recording or representing an approved consent script.
- Recording remains disabled by default. `noindex`, UI copy, or a tenant preference alone is not an adequate recording control.
- The agent handles operational receptionist work only. It must not diagnose, recommend treatment, interpret results, change medication, or present itself as a clinician.
- Life-threatening or stated emergencies receive immediate emergency-services direction before collection. Non-life-threatening urgent or clinical requests go to an approved human pathway.
- The customer must approve escalation targets, business hours, response expectations, backup contacts, and what happens when no human answers.

## 8. Authoritative source register

These sources establish obligations and vendor eligibility boundaries; they do not approve QVO:

- HHS, HIPAA Security Rule: <https://www.hhs.gov/hipaa/for-professionals/security/index.html>
- HHS, cloud computing and business associates: <https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html>
- HHS, Business Associates guidance: <https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html>
- HHS, sample BAA provisions: <https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html>
- 18 U.S.C. § 2511: <https://uscode.house.gov/view.xhtml?req=%28title%3A18+section%3A2511%29>
- OpenAI, obtaining a BAA: <https://help.openai.com/en/articles/8660679-how-can-i-get-a-business-associate-agreement-baa-with-openai/>
- OpenAI, HIPAA-eligible products and functionality: <https://help.openai.com/en/articles/20001069-hipaa-eligible-products-and-functionality>
- OpenAI API data controls and retention: <https://platform.openai.com/docs/models/default-usage-policies-by-endpoint>
- OpenAI business-data commitments: <https://openai.com/business-data/>
- Twilio HIPAA overview: <https://www.twilio.com/en-us/hipaa>
- Twilio HIPAA-eligible products and shared responsibility: <https://www.twilio.com/docs/iam/twilio-editions/hippa>
- Twilio, Programmable Voice HIPAA eligibility announcement: <https://www.twilio.com/en-us/changelog/programmable-voice--sip--and--sms-are-now-hipaa-eligible>
- Twilio Call resource retention and deletion: <https://www.twilio.com/docs/voice/api/call-resource>
- Supabase HIPAA project requirements: <https://supabase.com/docs/guides/platform/hipaa-projects>
- Supabase healthcare shared-responsibility requirements and minimum Team plan: <https://supabase.com/docs/guides/deployment/shared-responsibility-model>
- Supabase plan features and HIPAA add-on availability: <https://supabase.com/pricing>
- Supabase database backup and PITR windows: <https://supabase.com/docs/guides/platform/backups>
- Replit shared-responsibility model: <https://docs.replit.com/references/security/shared-responsibility-model>
- Replit security and published-workload controls: <https://replit.com/security/>

## 9. Production healthcare activation checklist

Every row is a hard gate. Blank means no production PHI.

### Legal/compliance owner

- [ ] Name and role recorded: ____________________
- [ ] Written pilot operating boundary approval attached: ____________________
- [ ] QVO/customer BAA or documented non-applicability approved: ____________________
- [ ] Twilio agreement/account/service/configuration approved: ____________________
- [ ] OpenAI agreement/org/project/model/endpoint/retention approved: ____________________
- [ ] Hosting and all other subprocessors approved: ____________________
- [ ] Privacy notice, DPA, transfer terms, and jurisdiction analysis approved: ____________________
- [ ] Recording remains disabled, or approved consent/jurisdiction packet attached: ____________________

### Security/infrastructure owner

- [ ] Production data-flow and subprocessor register match deployed reality.
- [ ] TLS, storage, backup, key, secret, access, MFA, logging, monitoring, and restore evidence attached.
- [ ] RLS and cross-tenant tests run against the production-equivalent database.
- [ ] PHI-capable field coverage decision and remediation are complete.
- [ ] Retention and deletion tests pass across first-party and vendor systems.
- [ ] Incident, rollback, and emergency-access runbooks have accountable responders.

### Product/clinical-safety owner

- [ ] Approved operational facts and minimum-necessary fields are recorded.
- [ ] Emergency, urgent, clinician-request, and human-request scripts are approved.
- [ ] The agent's non-clinician identity and appointment-request truthfulness are accepted.
- [ ] Staff follow-up, failed delivery, no-answer escalation, and correction workflows are accepted.

### Pilot-customer owner

- [ ] Authorized test callers, phone numbers, business hours, escalation contacts, and callback expectations are recorded.
- [ ] Staff roles and least-privilege access are accepted.
- [ ] Retention, deletion, recording, notice, and data-use instructions are signed.
- [ ] Scripted acceptance calls pass with synthetic data before real caller traffic.

## 10. `GTM-011` activation-control evidence

| Control | Enforced behavior | Proof state |
| --- | --- | --- |
| Runtime identity | Database checks and runtime policy require Master Voice Agent `1.0.0`, `gpt-realtime-2`, `healthcare-receptionist@1.0.0`, and recording disabled. Version drift, revocation, expiry, wrong tenant, and wrong agent deny. | `VERIFIED IN CODE` |
| Synthetic boundary | An authorized platform administrator supplies test numbers once; only tenant/purpose-separated HMACs are stored. A call must match an active synthetic approval and the synthetic evidence-reference set. | `VERIFIED IN CODE`; production-equivalent test number and approval still need owner setup |
| Production boundary | The record cannot be created without all named customer, vendor, storage, retention, deletion, security, recording-disabled, and acceptance reference fields. | `PARTIAL`; `GTM-012` now authenticates registry state and artifact digest metadata, but only named owners can establish the underlying artifact's legal/vendor sufficiency |
| Ingress enforcement | Inbound and outbound Twilio routes gate before streaming. The Twilio start frame gates again with the database-backed agent type; untrusted WebSocket parameters cannot relabel the role. The widget path uses the same healthcare policy. | `VERIFIED IN CODE`; deployed carrier/gateway proof pending |
| Approval administration | Create/list/revoke endpoints are platform-admin-only, bounded, audited, and do not expose raw test numbers or stored hashes. | `VERIFIED IN CODE`; production role assignments and audit review pending |
| Caller memory | New sessions store a deterministic tenant/purpose-separated lookup HMAC; history reads never send plaintext phone candidates to PostgreSQL and return no history when key material is unavailable. | `VERIFIED IN CODE AND DEMO TARGET`; `GTM-012` adds versioned current/previous rotation and a guarded backfill; `GTM-014` reconciled 14/14 demo rows and the healthcare scope at zero gap |
| First-party deletion | Runtime schema discovery, identifier validation, manifest classification, explicit non-cascade deletion, zero-row verification, transaction rollback on failure, and a surviving redacted proof record with a non-reversible executor fingerprint are implemented. | `PARTIAL`; live schema classification/dry run and external deletion remain pending |
| Secret and log controls | Production/staging refuse missing or weak stream/HMAC keys. Compact E.164 values are scrubbed before shared logging. | `VERIFIED IN CODE`; secret manager and deployed log-sink evidence pending |

The approval API is not a legal-signature system. `GTM-012` prevents an arbitrary well-formed string from satisfying activation by requiring an independently verified registry record and digest, but the named owner must still verify and retain the underlying artifact and determine its legal/vendor sufficiency.

No approval row was created, no migration was applied to a live database, no live healthcare call was placed, and no production PHI was activated during `GTM-011`.

Verification evidence: 15 focused files pass 178 assertions. Each of the five new control modules exceeds 80% statements, branches, functions, and lines; across those modules plus the shared PHI scrubber the measured result is 93.44% statements, 90.36% branches, 100% functions, and 98.08% lines, with the deletion verifier subsequently driven to 100% in every category. Client typecheck, affected production lint, application/public production builds, diff integrity, secret-pattern scan, migration/static tests, and all affected root TypeScript paths pass. Root TypeScript retains 272 unrelated pre-existing errors. The bounded-worker root-only suite records 5,628 pass / 261 fail / 129 skip across 6,018 versus `GTM-010`'s 5,558 / 256 / 134 across 5,948: all 70 added assertions pass, no affected test fails, and five unrelated formerly skipped assertions execute into the existing failure baseline. One unbounded retry was discarded after nine Vitest fork-runner startup timeouts; the bounded rerun completed all 494 files.

## 11. `GTM-011` changed-file and control matrix

| Files | Purpose |
| --- | --- |
| `migrations/114_healthcare_deployment_approvals.sql` | Version-locked approval table/RLS, caller lookup index, surviving deletion evidence, and narrowly authorized audit deletion. |
| `shared/compliance/healthcareDeploymentApproval.ts` and `.test.ts` | Pure deny-by-default role/tenant/agent/version/evidence/expiry/revocation/synthetic policy. |
| `platform/security/PiiLookupHash.ts` and `.test.ts` | Strict E.164 normalization plus tenant- and purpose-separated HMAC with no weak fallback. |
| `platform/compliance/HealthcareDeploymentApprovalService.ts` and `.test.ts` | Privileged, RLS-safe active approval lookup and synthetic-caller comparison without plaintext query/log output. |
| `platform/compliance/healthcareDataControlManifest.ts` and `.test.ts` | Versioned PHI-capable first-party store classification and fail-closed live-schema plan. |
| `platform/compliance/HealthcareDeletionVerificationService.ts` and `.test.ts` | Safe table discovery, parameterized explicit deletion, and count-only zero-row verification. |
| `platform/core/phi/redact.ts` and `.test.ts` | Compact international E.164 log redaction. |
| `server/voice-gateway/services/callPersistence.ts`, `platformAdapters.ts`, and their tests | Persist and query caller lookup HMAC; never issue plaintext phone variants to PostgreSQL. |
| `server/voice-gateway/routes/twilio.ts`, `stream.ts`, `twilio.test.ts`, and `streamHangupDuringConnect.test.ts` | Inbound, outbound, direct Twilio stream, and widget activation enforcement using trusted database agent identity. |
| `server/admin-api/routes/platformCompliance.ts` and `.test.ts` | Platform-admin-only approval create/list/revoke plus durable deletion-evidence visibility after tenant removal. |
| `server/admin-api/routes/legalCompliance.ts` and `.test.ts` | External evidence requirement, live schema classification, verified transactional deletion, and redacted surviving proof. |
| `scripts/validate-env.ts` and `tests/scripts/validateEnv.test.ts` | Production/staging hard requirements and minimum strength for stream and HMAC keys. |
| `tests/security/healthcareCallIngressGate.test.ts` and `healthcareDeploymentApprovalMigration.test.ts` | Static/integration proof that every ingress and SQL constraint remains present. |
| `docs/deployment-checklist.md`, this boundary, and `qvo-gtm-execution-control.md` | Operator configuration, truthful control state, blockers, verification evidence, and next execution. |

No Master Voice Agent runtime, model, role prompt, role package, tool contract, customer route, public API contract, or retained generic feature was forked or deleted. The `GTM-011` schema change is migration `114`; it was not applied to a live environment in that execution.

## 12. `GTM-012` production-equivalent data-control evidence

| Control | Enforced behavior | Proof state |
| --- | --- | --- |
| Complete tenant catalog | `GTM-012` originally recorded version `2.0.0` and 186 tables. `GTM-013` corrected that historical claim: version `3.0.0` classifies 188 final root tenant tables after modeling renames, excluding compatibility views/partition children, and adding the readiness table. Runtime discovery still blocks any unknown or unsafe root table. | `VERIFIED IN CODE`; external target equality blocked |
| Evidence authenticity | Migration `115` stores metadata, external artifact locator, SHA-256, scope, owner role, submitter, independent verifier, expiry, and revocation. Artifact identity is immutable, RLS is service-only, platform-admin workflow is strict and audited, and client responses omit the locator. | `VERIFIED IN CODE`; registry is empty and migration unapplied here |
| Approval resolution | Production approval creation and every production runtime re-evaluation resolve the exact eleven references. Missing, wrong-control, wrong-scope, staging, pending, same-person, revoked, expired, short-lived, or malformed-digest evidence denies. | `VERIFIED IN CODE`; artifact sufficiency remains owner-controlled |
| HMAC rotation | One current write key/version and at most one distinct previous read key/version are accepted. New rows store hash/version together; memory queries current and previous hashes only; partial, weak, duplicate, or malformed keyrings deny. | `VERIFIED IN CODE`; deployed secret-manager rotation pending |
| Historical backfill | The batch is bounded to 500, resumable by opaque cursor, dry-run by default, and apply requires `APPLY CALLER LOOKUP HASH BACKFILL`. It decrypts through the envelope service one row at a time, conditionally writes only hash/version, and returns counts only. | `VERIFIED IN CODE`; no live row was read or written |
| Retention planning | Version `1.0.0` requires explicit durations for sessions, transcripts, events, tools, outbox, tickets, escalations, knowledge, logs, control evidence, files, backups, and external processors, bound to verified `retention_controls` evidence. The planner performs parameterized counts only and always returns `executionAuthorized: false`. | `VERIFIED IN CODE`; durations, legal-hold implementation, sweepers, backups, and processors remain owner/external gates |
| Operator preflight | The command reports migration, schema, role/RLS, keyring, evidence, caller reconciliation, retention, and deletion status and emits the normalized all-pass readiness payload using only counts, status, and digests. Tenant/agent IDs, artifact locators, rows, phones, ciphertext, secrets, provider errors, and database URLs are excluded. | `VERIFIED IN CODE`; available target was inspected read-only and does not pass |

### External evidence matrix

| Evidence still required | Accountable owner | Exact next proof | State |
| --- | --- | --- | --- |
| Migrations `112`, `114`, `115`, and `116`, actual application/service role, tenant-table RLS, and catalog equality | Infrastructure + security | After the target owner identifies an isolated production-equivalent DB, apply migrations through `116`, then run `QVO_PREFLIGHT_TENANT_ID=… QVO_PREFLIGHT_AGENT_ID=… npm run preflight:healthcare-data-controls` | `BLOCKED — EXTERNAL EVIDENCE` |
| Synthetic tenant deletion rollback, zero first-party rows, and durable redacted evidence | Infrastructure + compliance | Run the existing guarded deletion dry run against the production-equivalent schema and attach count/status/digest evidence | `BLOCKED — EXTERNAL EVIDENCE` |
| Historical caller hash and key rotation | Infrastructure + security | Run `npm run backfill:caller-lookup-hashes`, perform acknowledged batches, then prove zero missing/stale counts before removing the previous key | `BLOCKED — EXTERNAL EVIDENCE` |
| Approved retention durations, legal holds, sweep completion, backups, and processor deletion | Compliance + infrastructure + vendor owners | Verify the `retention_controls` artifact, run the read-only planner, implement approved sweepers, and attach completion evidence | `BLOCKED — OWNER/EXTERNAL EVIDENCE` |
| Customer, Twilio, OpenAI, hosting, privacy, recording/jurisdiction, and pilot acceptance | Founder/compliance + vendor/customer owners | Submit external artifact metadata, independently verify each record, and complete section 9 in writing | `BLOCKED — OWNER/VENDOR` |
| Credentialed gold call | Infrastructure + product safety + pilot owner | After every WP7 gate passes, create one short-lived approval and execute the WP6 controlled gold-call procedure | `BLOCKED — DEPENDS ON WP7` |

No migration was applied, no evidence or approval row was created, no backfill/retention/deletion write ran, no live call was placed, and no production PHI was activated. Eighteen focused files pass 156 assertions. Across the five new platform control modules, coverage is 100% statements, 93.38% branches, 100% functions, and 100% lines; the two shared policies reach 97.22% / 95.34% / 100% / 97.01%, and `PiiLookupHash.ts` reaches 87.93% / 87.14% / 90.90% / 95.83%. Client typecheck, affected root TypeScript, production-source lint, migration/static tests, and both production builds pass. Root TypeScript retains 272 unrelated errors and zero affected errors. The bounded root suite is 5,682 pass / 261 fail / 129 skip across 6,072 versus `GTM-011`'s 5,628 / 261 / 129 across 6,018: all 54 additional assertions pass and no failure or skip was added.

## 13. `GTM-012` changed-file and control matrix

| Files | Purpose |
| --- | --- |
| `migrations/115_healthcare_control_evidence.sql` and `tests/security/healthcareControlEvidenceMigration.test.ts` | Metadata-only evidence registry, immutable workflow/RLS, HMAC version column/pair constraint, and static SQL proof. |
| `platform/compliance/tenantDataControlCatalog.ts`, `healthcareDataControlManifest.ts`, deletion verifier, and tests | Historical `GTM-012` catalog work, corrected by `GTM-013` to the final 188-root-table model. |
| `shared/compliance/healthcareControlEvidence.ts`, `HealthcareControlEvidenceService.ts`, and tests | Pure evidence policy plus parameterized privileged repository that never returns artifact locators. |
| `server/admin-api/routes/platformCompliance.ts` and `.test.ts` | Platform-admin submit/list/independent-verify/revoke registry workflow and authenticated approval creation. |
| `platform/compliance/HealthcareDeploymentApprovalService.ts` and `.test.ts` | Runtime revalidation so later expiry/revocation denies an already-created production approval. |
| `platform/security/PiiLookupHash.ts`, call persistence/memory adapters, and tests | Versioned current/previous keyring, write-current behavior, dual-read memory, paired hash/version persistence, and fail-closed environment contract. |
| `platform/compliance/CallerLookupHashBackfill.ts`, `scripts/backfill-caller-lookup-hashes.ts`, and tests | Bounded count-only dry-run/apply reconciliation with exact acknowledgement and no plaintext output. |
| `shared/compliance/healthcareRetentionPolicy.ts`, `HealthcareRetentionPlanner.ts`, and tests | Owner-evidence-bound complete retention contract and non-destructive count planner with no default durations. |
| `HealthcareDataControlPreflight.ts`, `scripts/healthcare-data-control-preflight.ts`, and tests | Counts/status/keyed-digest operator proof with fail-closed external evidence states. |
| `scripts/validate-env.ts`, `tests/scripts/validateEnv.test.ts`, `package.json`, and deployment documentation | Production current-version requirement, safe optional previous pair, and operator commands. |

## 14. `GTM-013` owner proof and activation-readiness convergence

`GTM-013` corrects the final-schema model and adds a durable prerequisite between evidence collection and production approval. The attestation is not a compliance declaration: it is a short-lived, tenant/agent/environment-scoped record proving that the normalized engineering and owner-evidence gates were all reported as passing and independently reviewed.

### Accountable evidence-owner contract

| Control key | Required owner role |
| --- | --- |
| `compliance_owner_approval`, `customer_agreement`, `retention_controls`, `deletion_controls` | `compliance` |
| `twilio_approval`, `openai_approval`, `hosting_approval`, `storage_controls`, `deployment_security` | `infrastructure` |
| `recording_disabled` | `product_safety` |
| `pilot_acceptance` | `pilot_customer` |

The pure policy, platform-admin API, and migration `116` enforce this mapping. Submission and verification must use different platform administrators. A verified record can only transition to revoked; proof identity, exact runtime versions, all-pass checks, counts, digests, scope, submitter, and expiry are immutable.

### Readiness and approval enforcement

| Control | Enforced behavior | State |
| --- | --- | --- |
| Final schema | Catalog `3.0.0` contains 188 root tenant tables. Migration-history parsing applies renames; live discovery excludes views and partition children and retains base/partitioned parents. | `VERIFIED IN CODE` |
| Readiness proof | Migration `116` stores exact Master Voice Agent/model/role/recording identity, reconciled catalog/RLS/evidence/caller counts, eight all-pass states, four SHA-256 proof bindings, bounded expiry, and independent workflow identity under service-only RLS. The API recomputes the canonical normalized preflight digest and rejects mismatches. | `VERIFIED IN CODE` and disposable PostgreSQL; no external row created |
| Administrative workflow | Platform-admin-only list/submit/verify/revoke endpoints use strict schemas and parameterized SQL, omit proof digests from responses, reject customer roles and wrong-owner evidence, and audit every transition. | `VERIFIED IN CODE`; production assignments pending |
| Approval creation | Production approval input requires a valid production readiness reference. Application policy and a database trigger require matching tenant, agent, runtime identity, verified status, no revocation, and readiness expiry covering approval expiry. Synthetic approvals cannot attach production readiness. | `VERIFIED IN CODE`; no approval created |
| Runtime re-evaluation | Every healthcare production authorization re-resolves both the eleven evidence records and readiness record. Later evidence/readiness revocation, expiry, drift, or count/status mismatch denies. | `VERIFIED IN CODE`; credentialed rehearsal pending |
| Operator preflight | The count/status/digest-only report includes a normalized readiness payload. `external_required`, a failed status, catalog/RLS drift, missing evidence, or caller-HMAC gap makes overall status fail. | `VERIFIED IN CODE`; target reports hard-stop state |

### Read-only external target report

The gitignored database credential was used only inside an explicit read-only transaction. The target remains unclassified because no owner/environment designation is present; therefore no migration, evidence/readiness/approval row, backfill, retention/deletion write, call, or PHI activation was attempted.

| Observation | Redacted result |
| --- | --- |
| Catalog | version `3.0.0`, 188 expected root tenant tables |
| Live root tenant relations | 184 |
| Unknown live root tables | 0 |
| Expected but absent | `billing_reconciliation`, `healthcare_control_evidence`, `healthcare_deployment_approvals`, `healthcare_activation_readiness` |
| Required migrations | `112`, `114`, `115`, and `116` all unapplied |
| RLS | 161 of 184 root tenant relations enabled; not complete |
| Decision | `BLOCKED — UNCLASSIFIED TARGET AND FAILED PREFLIGHT PREREQUISITES` |

### Changed-file/control matrix

| Files | Purpose |
| --- | --- |
| `migrations/116_healthcare_activation_readiness.sql` and migration test | Immutable readiness registry, service-only RLS, exact owner-role constraint, controlled state transitions, production-approval FK/check/trigger binding. |
| `shared/compliance/healthcareActivationReadiness.ts` and test | Pure exact-scope/identity/schema/RLS/evidence/caller/status/digest/two-person/expiry/revocation policy. |
| `platform/compliance/HealthcareActivationReadinessService.ts` and test | Parameterized reference resolution with no proof digests or sensitive identifiers in the decision. |
| `shared/compliance/healthcareControlEvidence.ts`, repository tests, and API tests | Exact accountable owner role per evidence control. |
| `shared/compliance/healthcareDeploymentApproval.ts`, `HealthcareDeploymentApprovalService.ts`, and tests | Required readiness reference plus live runtime revalidation. |
| `tenantDataControlCatalog.ts`, deletion discovery, RLS preflight, and tests | Correct final migration-state catalog and root-relation discovery. |
| `HealthcareDataControlPreflight.ts` and test | Migration `116` requirement and normalized all-pass readiness payload. |
| `server/admin-api/routes/platformCompliance.ts` and test | Strict platform-admin readiness workflow and readiness-bound production approval creation. |
| This boundary and `qvo-gtm-execution-control.md` | Corrected historical catalog claim, owner actions, external facts, verification, and next execution. |

Verification: 16 focused files pass 131 tests. The two new readiness modules measure 100% statements, branches, functions, and lines; the hardened preflight module measures 100% statements, 94.44% branches, 100% functions, and 100% lines. Migration `116` also passes an isolated disposable PostgreSQL exercise covering self-verification denial, independent verification, scope/identity approval binding, owner-role enforcement, revocation finality, and denial after revocation. Affected production-source lint and affected root TypeScript pass; client typecheck and application/public production builds pass. Root TypeScript retains 272 unrelated pre-existing errors and zero affected-path errors. The bounded root suite records 5,719 pass / 261 fail / 129 skip across 6,109 versus `GTM-012`'s 5,682 / 261 / 129 across 6,072: all 37 additional tests pass and no failure or skip was added. No Master Voice Agent core/model/role fork, backend/API deletion, destructive external database operation, external write, live call, or production PHI activation occurred.

## 15. `GTM-014` production-equivalent database gate clearance

The owner classified the available Supabase target as a non-production, production-equivalent demo environment: all rows are demo data and the imported Azul Vision tenant must be preserved. After failing-first migration, alias, and discovery hardening, the target passed a rolled-back exact-schema rehearsal and the normal migration runner applied only the seven genuine pending migrations. Post-state evidence is redacted and count-only: zero local migrations pending, 188 final root tenant relations, 188 with RLS, 188 with at least one policy, configured non-superuser `BYPASSRLS` identity verified, and unchanged representative row counts.

Migration `117` closes the 23 prior RLS gaps with forced, fail-closed tenant policies. Branch migration aliases are accepted only when both their historical ledger record and final schema are proven. Root discovery now returns one relation when multiple tenant foreign-key paths exist and treats any non-cascade path conservatively. The corrected preflight passes migrations, catalog/schema (`188/188`, drift `0`), database role, and RLS.

The owner installed a dedicated durable caller-HMAC key/version without exposing it. A guarded dry-run identified 14 eligible demo rows; acknowledged apply updated all 14 with zero failures. Global post-reconciliation has zero eligible rows, and the healthcare scope is `3/3` current with zero missing/stale. Keyring and caller-hash preflight sections pass with dual-read disabled.

A rollback-only synthetic deletion rehearsal found and fixed a mixed tenant-identifier defect between legacy text tenant IDs and UUID marketplace IDs. The repeated rehearsal discovered all 188 root relations, classified 158 cascade, 28 explicit-delete, one controlled-audit, and one preserved-evidence relation, proved zero first-party rows plus the redacted evidence shape, rolled back, and left zero residue. It intentionally does not claim cache, file, backup, log, Twilio, OpenAI, Supabase, hosting, or durable deletion-completion evidence.

Evidence remains `0/11`; owner-approved retention and external deletion remain `external_required`. On 2026-07-13 the owner confirmed that no third-party BAA is currently executed, that the Supabase organization is on Pro, and that Replit HIPAA/BAA eligibility is unknown. Team plus HIPAA/PITR is the approved production direction, with execution intentionally deferred until the go-live readiness window. Pro remains demo-only: the upgrade, BAA, add-ons, and High Compliance controls must complete before production readiness or PHI. Authorized OpenAI BAA/Modified Retention and Replit workload-eligibility inquiries were sent from `wfabian@azulvision.com` through Outlook Web and verified in Sent Items; vendor responses and any resulting agreements remain pending. The owner tabled Twilio outreach while account issues are resolved. Wayne Fabian is designated as the independent platform-administrator reviewer. Yaritza Ferreras Fernandez is the separate evidence submitter, with owner-confirmed QVO sign-in `yferrera05@hotmail.com`. Migration `118` and the fail-closed, audited platform-admin TOTP MFA and invitation path are implemented, tested, and applied to the demo target. The target still has only one active administrator and no invitation was created: deploy the code with a public `APP_URL`, complete SMTP and encryption configuration, enroll Wayne in MFA, then invite Yaritza and verify her MFA-protected access. No purchase, second active identity, durable deletion proof, readiness, approval, call, or PHI activation was created.

Checkpoint verification: eight focused files pass 38 tests; changed preflight/deletion production modules measure 96.62% statements, 90.47% branches, 100% functions, and 96.34% lines; configured affected lint and diff checks pass; root TypeScript retains 272 unrelated pre-existing errors and zero GTM-014-path errors.

## 16. Remaining production blockers and next evidence run

1. `CLEARED BY GTM-014`: owner-classified target, migrations through `117`, migration-ledger convergence, exact 188-root-table catalog equality, 188/188 RLS/policy coverage, and configured database-role proof.
2. `FIRST-PARTY MECHANISM CLEARED BY GTM-014`: rollback-only synthetic deletion across all 188 relations, zero first-party rows, mixed text/UUID tenant handling, redacted evidence shape, rollback, and zero residue. Cache/file/backup/vendor/legal-hold and durable evidence remain external.
3. `CLEARED BY GTM-014 FOR CURRENT KEY`: guarded HMAC backfill reconciled 14/14 demo rows and healthcare scope `3/3` with zero missing/stale. A future key change must still use the controlled current/previous rotation procedure.
4. Obtain owner-approved retention durations, implement the approved legal-hold-aware sweepers, and prove completion across database stores, files, backups, and external processors.
5. Confirm the actual Supabase backup plan/BAA status, OpenAI BAA plus Modified Retention/ZDR status, Twilio BAA/HIPAA-project status, and hosting authorization for PHI before recording vendor evidence.
6. Attach production-equivalent TLS, storage, backup, restore, key, secret, least-privilege, MFA, access-review, monitoring, and log-sink evidence.
7. `IDENTITY CLEARED / ACTIVATION PENDING`: Yaritza Ferreras Fernandez (`yferrera05@hotmail.com`) is the designated evidence submitter and Wayne Fabian is the independent reviewer. Migration `118` and the audited MFA invitation flow are ready. Deploy with `APP_URL`, SMTP, and encryption configuration; enroll Wayne in MFA; invite Yaritza; complete her MFA enrollment and access review; then populate and independently verify the eleven exact evidence records. Registry authentication does not replace written legal/vendor/customer approval.
8. Run the all-pass preflight, submit and independently verify one short-lived readiness record, then create one readiness-bound short-lived production approval only for the credentialed synthetic WP6 rehearsal.
9. Obtain the customer, Twilio, OpenAI, hosting, recording/jurisdiction, privacy, pilot-acceptance, and compliance-owner approvals in section 9 before any real caller traffic.

## 17. Completion rule

Tasks 7.0–7.3 have completed their repository-backed engineering scope, and `GTM-014` has cleared the target/migration/RLS/catalog/database-role gates, the current-key caller-HMAC reconciliation, and the rollback-only first-party deletion mechanism. **WP7 remains blocked** until external deletion and approved retention proof, named-owner independent verification of every required artifact and section 9, and the readiness-bound credentialed synthetic activation rehearsal all succeed. No engineer may convert `GTM-010`–`GTM-014` to WP7 complete solely because code tests, database migrations, backfill counts, rollback rehearsals, or this document exist.
