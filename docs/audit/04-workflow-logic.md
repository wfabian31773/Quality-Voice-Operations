# 04 — Workflow & Logic

Each major surface mapped start-to-end. Findings call out broken transitions, missing error paths, redundant steps, and absent automation triggers.

---

## W-01 — Call lifecycle (inbound)

`Twilio /voice → number_routing lookup → checkBudget → TwiML <Connect><Stream> → /twilio/stream WS → openaiSession → workflow engine → tool executions → connectors → call_sessions write → usage_metrics write → Stripe meter sync`

Findings:
- **No fallback agent.** If `number_routing` lookup fails (number deleted, RLS misconfigured), the gateway returns an empty TwiML and Twilio rejects the call. There is no "default reception" agent that can answer with "we are experiencing an issue, please leave a voicemail".
- **Budget rejection is opaque.** When `checkBudget` rejects a call, the TwiML returned is silent — the caller hears dead air. Should say a 5-second message ("Service temporarily unavailable").
- **Session manager has no max-duration cap.** A stuck session can hold the WebSocket open indefinitely, billing AI minutes against the tenant. Should hard-cut after a configurable max (e.g. 20 minutes).
- **Tool failures are surfaced as transcripts but not as alerts.** Operations Console > Reliability shows tool execution health, but a single high-severity tool failure does not auto-create an `operations_alerts` row.

## W-02 — Call lifecycle (outbound, campaign)

`CampaignScheduler poll → OutboundDialer → DNC check → Twilio API → call → outcome classifier → retries`

- **DNC check is per-tenant only.** A call can succeed for tenant A while the same number is on tenant B's DNC. Required by TCPA. (This is by design and arguably correct, but the carrier-level DNC is not consulted.)
- **Outcome classifier writes the disposition but does not trigger a connector dispatch on `disposition = 'qualified-lead'`.** Should fan out to CRM connectors automatically.
- **Retry logic** in `migrations/021_campaign_outcome_retries.sql`: configurable but the UI to edit retry policy lives only on a per-campaign edit modal, not at the tenant level.

## W-03 — Ticket lifecycle (enterprise ticketing)

`Create → triage → assign → SLA timer → activity timeline → resolve → CSAT`

- **SLA timers do not pause when the ticket is in `pending-customer` state.** Per migration 049 there is a status, but the timer math counts pending-customer time against SLA breach.
- **Macros run on apply but their effect (status change, tag add) is not surfaced in the activity timeline.**
- **Bulk actions** are exposed via `POST /tickets/bulk` but the UI only allows status change in bulk; assignment and tagging are individual-ticket only.
- **Linked tickets** can form cycles (A→B→A); no cycle detection on create.

## W-04 — Dispatch lifecycle

`Job created → assignment-rules engine → resource (technician) accepts → en-route → on-site → completed → invoice handoff`

- **Assignment-rules engine** chooses the first matching rule by `priority`; if two rules tie there is no deterministic tie-breaker (creates flapping in the UI).
- **No notification template fired on `en-route`** — only on `assigned` and `completed`. A "I'm on my way" SMS to the customer is universally expected in field-service.
- **Resource availability** does not consider personal `schedule_overrides` (D-15 cross-link).
- **Exception resolution** marks the exception "resolved" but does not write back to the parent job — the parent job remains in whatever status the exception interrupted.

## W-05 — Scheduling (appointment booking)

`Self-schedule public link → availability lookup → booking → reminder → no-show / completed`

- **Availability lookup misses overrides** (D-15).
- **Reminder configurations** support SMS/email but the SMS adapter is global per tenant — different appointment types cannot use different SMS sender numbers.
- **Recurring appointments** create N child rows up front; cancelling the series leaves orphan rows in `scheduling_audit_log` referencing dead booking ids.
- **Waitlist** offers no automatic promotion when a slot opens — manual only.

## W-06 — Marketplace install + post-install setup

`Browse → install (free) or purchase (paid) → entitlement → installation → checklist → customize → assign phone → enable widget → publish agent`

- **Free vs paid path** branches inside `MarketplacePurchaseService` but there is no `installations.purchase_required` flag exposed on the listing card. Tenants click install on a paid template and are surprised by a Stripe redirect.
- **Checklist** has 7 items; if a tenant skips one and "publishes anyway", the system allows it but the PostInstallSetup page reports the install as "incomplete forever" — no way to dismiss.
- **Customization schema** writes back to `agents.customization_overrides` but the agent loader does not re-read overrides until the next call session, so users see a delay between save and effect.

## W-07 — Billing / trial guardrails

`Trial start → usage accrual → guardrails check → soft warn → hard cut → suspend`

- **Soft warn** at 80% usage is sent via in-app notification only; no email until 100%.
- **Hard cut** sets `tenants.status = 'suspended'` but the auth middleware does not differentiate "pending" vs "suspended" — both produce the same generic 403. Suspended tenants get the same "Your account setup is not complete. Please finish checkout." message intended for `pending`. Misleading.
- **Stripe webhook race** on `checkout.session.completed` (B-30).

## W-08 — Federated ingest

`POST /ingest/calls → API key auth → idempotency check → write call_session + usage → Stripe sync on next worker tick`

- **Idempotency** is keyed on `(tenant_id, external_id)`; collisions are silently treated as duplicates with the same response. A genuine retry of a failed write is indistinguishable from a duplicate, so a partial failure that wrote half the call's events leaves the second half permanently missing.
- **No backfill endpoint.** External agents that go offline for hours have no way to backfill — the ingest accepts events only with `occurred_at` within the last 7 days (per inspection of `routes/ingest.ts`).

## W-09 — Signup → onboarding

`Public signup → Turnstile → email verify → checkout → webhook → tenant ready → onboarding wizard → first agent → first phone → first call`

- **Turnstile** is verified server-side but the public signup form does **not include** the Turnstile widget when `TURNSTILE_SITE_KEY` is set, so server verification always passes silently (B-38).
- **Email verify** uses a JWT-backed token; expiry is 24 hours but the public verify page does not render a "request a new link" CTA on expiry.
- **Welcome email** does not include a calendar link to book onboarding help (sales-assist).
- **First-call detection** — a milestone ("first inbound call answered") is fired by the milestone scheduler, but the welcome email triggered by it is sent regardless of when the tenant subscribes (could fire weeks after signup).

## W-10 — Connector OAuth flows

`Connect → state cookie set → redirect → provider auth → callback → exchange code → token store → first sync`

- **State CSRF** is set as a cookie; on cross-site nav this depends on `SameSite=Lax` (verify in `connectorOAuth.ts`).
- **Token refresh** lives in `tokenRefresh.ts` but is on-demand only (refresh when an outbound call gets 401). No proactive refresh worker; long-idle tenants always pay the latency penalty on first reconnect.
- **First sync** is fire-and-forget; if it fails the user sees "Connected" with no warning until the first event.
- **OAuth scope downgrade** — if a provider returns fewer scopes than requested (Google does this when the user unticks a permission), there is no compare/warn. Operations later silently fail.

## W-11 — Maintenance mode

`Admin sets maintenance flag → MaintenanceGate blocks all routes → admin cannot get back in`

- **MaintenanceGate** wraps everything (B-25). No carve-out for `/login` or `/admin/*`.
- No admin UI to toggle (#214).

## W-12 — Account deletion (30-day cool-off)

- DB schema and request endpoints exist (`/privacy/deletion-request`).
- **No background worker** purges accounts at end of the cool-off (#210, #216).
- The user-facing UI implies the deletion will happen automatically; today it requires manual ops intervention.

## W-13 — Notifications

- Notification table exists (`platform/notifications`).
- The pipeline that fires notifications from real events (calls, billing, SMS, integrations) is partially wired (#217).
- The bell badge counts unread, but the Ops console does not render a bell at all (B-09).

## W-14 — Documentation feedback

- `support.ts` has the largest backend (1.1k LOC) and powers `/docs/feedback/*`.
- A scheduled alerter and reply-digest run as background workers.
- **Search-no-result tracking** — when a user searches help and gets zero results, nothing is recorded (#220).

## W-15 — Onboarding wizard re-entry

- If a user logs out mid-onboarding, on next login they hit `Onboarding` again. But the wizard does not remember which step they were on; restarts at step 1.
- Fix: persist `onboarding_step` per-user in `users.preferences`.
