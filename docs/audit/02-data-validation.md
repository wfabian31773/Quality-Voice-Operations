# 02 — Data Validation

UI ↔ backend ↔ DB consistency. Findings here are about **rendered values that don't match the source of truth**, formatting issues, null/undefined leakage, and possible cross-tenant exposure.

---

## D-01 — `Dashboard` "Today's calls" comparison shows `NaN%` when yesterday's count is 0 (also B-36)
- The card calculates `(today - yesterday) / yesterday * 100` without guarding the divide-by-zero.
- Fix: render "—" when `yesterday === 0`.

## D-02 — `Calls` list and `CallDebug` show different `duration_seconds` for the same call
- `Calls.tsx` formats from `usage_metrics.duration_seconds` (rounded to nearest second by the recorder).
- `CallDebug.tsx` formats from `call_sessions.end_time - start_time` (sub-second precision).
- A call recorded at 31.4s shows as **31s** in the list and **31.4s** in the debugger.
- Fix: pick one source (recommend `call_sessions` for the canonical duration; `usage_metrics` is a billing-rounded copy).

## D-03 — `Currency` formatting is inconsistent
- `Billing.tsx` uses `Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })`.
- `RevenueAnalytics.tsx` (embedded in the Analytics → Revenue & Sentiment tab) uses string `"$" + value.toFixed(2)`.
- `AdminAnalytics.tsx` uses `value / 100` (cents → dollars) for some Stripe-derived fields and full dollars for others.
- Fix: centralise in a `formatCurrency(value, unit)` helper that takes `'cents'` or `'dollars'`.

## D-04 — `Created at` and `Last activity` columns mix UTC ISO strings and locale-formatted timestamps
- `Tickets`, `SmsInbox`, `Dispatch`, `Scheduling` each call `new Date(x).toLocaleString()` directly.
- No tenant timezone preference is read from `tenants.settings`.
- Fix: add `tenant_timezone` to the user/tenant settings; format via `Intl.DateTimeFormat(timezone)`.

## D-05 — Tenant `status` rendered raw in `PlatformAdmin` table
- `pages/PlatformAdmin.tsx` shows the raw enum `pending | ready | suspended | deleted` instead of human strings ("Setup in progress", "Active", "Suspended", "Deleting").
- Fix: a `formatTenantStatus(status)` helper.

## D-06 — `null` agent names render as the literal string `"null"` in `Calls.tsx` when `agents.name IS NULL` (legacy rows from before #28)
- Cause: `${row.agent_name}` template literal, no fallback.
- Fix: `${row.agent_name ?? '(unnamed agent)'}`.

## D-07 — `usage_metrics` table is empty in dev — many UI cards show zeroed values, but the labels (e.g. "Cost this month") imply real data
- Acceptable in dev, but the empty state should clarify "no usage yet" rather than "$0.00".

## D-08 — `Cost` columns mix cents and dollars across tables
- `cost_optimization` table stores cents (per migration 046).
- `usage_metrics` stores dollars (per migration 026).
- `analytics/costs` endpoint sums both and the total is therefore wrong by 100×.
- Fix: pick one unit at the schema level. Recommend converting all to **integer cents** to avoid float drift.

## D-09 — `Phone numbers` page shows `assigned_to` as a UUID when the assigned agent has been deleted
- The UI joins `agents.name` but does not handle the `LEFT JOIN` returning `null` after agent deletion.
- Fix: display "(deleted agent)" and a button to re-route the number.

## D-10 — `KnowledgeBase` article counts in the sidebar drift from the actual article count
- The sidebar count is fetched once on mount; creating an article does not invalidate the React Query cache key for the count.
- Fix: invalidate `['knowledge-counts']` on `mutate` success.

## D-11 — `Marketplace` template ratings show stale averages because they are denormalised on `templates` and only recalculated when a review is created (not when one is moderated/deleted)
- A 1-star review that is moderated to "rejected" still influences the average until a new review arrives.
- Fix: recompute the average inside the moderation hook in `MarketplaceReviewService`.

## D-12 — `Onboarding` page polls `provisioning-status` and shows `phoneNumberCount` from the response, but if the user adds a number elsewhere mid-flow the count refreshes only on the next poll (10s)
- Minor; documenting for completeness.

## D-13 — `Operations` live board includes calls from "demo" tenant when an admin views it (because the cross-tenant filter is `req.user.isPlatformAdmin || tenant_id = req.user.tenantId`)
- Demo calls inflate platform admin numbers.
- Fix: explicitly exclude `tenant_id = 'demo'` in the platform-wide query, or expose a "include demo" toggle.

## D-14 — `Tickets` `priority` shown as raw string `low|normal|high|urgent` without color cues
- Polish; current rendering uses Tailwind `text-gray-*` consistently, no semantic color.

## D-15 — `Scheduling` "next available slot" calculation does not account for `schedule_overrides` rows when the override `is_blocked = true` falls inside the requested window
- Result: customers can be booked into a blocked window.
- Fix: include `schedule_overrides` in the availability query (the override rows exist; the SELECT in `scheduling.ts:availabilityHandler` likely misses them).

## D-16 — `AuditLog` entries show `payload` as `[object Object]` for some legacy events that pre-date migration 027
- Fix: render `<pre>{JSON.stringify(payload, null, 2)}</pre>`; null-guard.

## D-17 — `Compliance → SOC 2 checklist` items list "evidence_url" but the column is sometimes a relative path, sometimes a full URL
- Fix: normalise to absolute URLs at write time.

## D-18 — `AdminAnalytics` "MRR" includes trialing tenants whose Stripe subscription is `status=trialing` and have no successful payment yet
- Fix: filter `status IN ('active', 'past_due')`; classify "trialing" separately under "Pipeline MRR".

## D-19 — Connector `last_synced_at` updates only on success; on failure the UI claims "synced X minutes ago" because the last successful sync is shown without the parallel error indicator
- The error column is added in migration `061_connector_last_sync_error.sql` but the UI does not surface it consistently.
- Fix: render "Last sync failed at <ts>" when there is a non-null error.

## D-20 — Cross-tenant exposure check (read-only inspection)
- `tests/security/crossTenantEndpoints.test.ts` covers agents/calls/phone-numbers/tickets/scheduling/dispatch/sms-inbox listing and detail endpoints.
- **Not covered** by that test: `/scheduling/recurring`, `/dispatch/jobs/batch`, `/marketplace/installations/:id/customize`, `/autopilot/recommendations/:id/*`, `/digital-twin/*`, `/evolution/*`, `/gin/recommendations/:id/status`, `/improvements/suggestions/:id`, `/case-studies/:id`, `/widget/tokens/:id`, `/knowledge-documents/:id` (download), `/tool-executions/:id` (replay).
- Recommend extending `tests/security/crossTenantEndpoints.test.ts` to cover these.
- **Out of scope** (no admin-api handlers exist): `/workforce/*` and standalone `/insights/*`. The `platform/workforce/*` services are consumed in-process by the voice gateway and the workforce scheduler started from `server/admin-api/start.ts`; they are never mounted as HTTP routes. The only `/insights*` endpoint is `/autopilot/insights`, which is already covered by the cross-tenant matrix above. To prevent silent regressions, `tests/security/crossTenantEndpoints.test.ts` includes a "Reserved route families" suite that asserts `/workforce/teams`, `/workforce/members`, `/workforce/handoffs`, `/insights`, and `/insights/summary` all return 404; the moment any of those families is mounted, the guard will fail and force the author to add proper two-tenant tests alongside the new routes.

## D-21 — `users.email_verified` is shown as boolean in the `Settings → Roles` table but the underlying column was added inconsistently (some rows are `true`, some `null`)
- Treat `null` as `false`; backfill via migration.
