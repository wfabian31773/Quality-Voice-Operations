# 09 — Prioritized Backlog

This is the **deduped, prioritised** backlog of new work surfaced by the audit. Every item:

- Has a stable id (`BL-NNN`).
- Has been cross-referenced against the 99 existing project tasks (`/tmp/tasks.json` snapshot at audit time, IDs #1–#100, the 24 PROPOSED tasks #200–#223, and the 4 in-progress placeholder ids #20, #64, #65, #66).
- Carries a `Related task: #N` pointer when an existing task overlaps, or `Related task: none` when this work is genuinely new.

The bug list (`01-bug-list.md`), data validation (`02-data-validation.md`), UX/UI report (`03-ux-ui-report.md`), workflow logic (`04-workflow-logic.md`), integration & performance (`05-integration-and-performance.md`), and security/compliance (`06-security-compliance.md`) all feed into the entries below. Many findings are intentionally bundled into a single backlog item (one platform-wide empty-state pass instead of seven separate tickets, etc.).

Order within each priority is **execution order**: the higher item should be done first.

---

## P0 — Do now (security, data integrity, broken navigation)

### BL-001 — Fix Zapier webhook SSRF allow-list bypass (DNS rebinding)
- **Source:** B-03 / I-01 / S-01
- **Summary:** `platform/integrations/connectors/adapters/zapier.ts:isAllowedWebhookUrl` only inspects the literal hostname string. An attacker registers a public hostname whose DNS resolves to RFC1918 / loopback / cloud metadata. Resolve via `dns.lookup`, validate every resolved IP, then `fetch` against the resolved IP literal with the original `Host:` header to defeat rebinding mid-request. Apply the same hardening to any other adapter that calls a customer-supplied URL (`hubspot` and `slack` accept user-provided webhook endpoints in some flows).
- **Acceptance:** SSRF tests in `tests/security/` exercise IPv4/IPv6 private ranges, link-local, cloud-metadata IPs, and a DNS-rebinding fixture. Test passes; production fetch refuses to call the resolved address.
- **Effort:** S
- **Related task:** none

### BL-002 — Verify Twilio webhook signatures on `/twilio/voice` and `/twilio/status`
- **Source:** I-03 / S-02
- **Summary:** `voice-gateway/routes/twilio.ts` does not call `twilio.validateRequest`. Any unauthenticated POST can spoof an inbound call and consume OpenAI minutes. Add a middleware that pulls the signature header, the raw URL (including the proxy domain), and the form-encoded params, and rejects on mismatch. Pin to `TWILIO_AUTH_TOKEN`.
- **Acceptance:** A request without `X-Twilio-Signature` returns 403; a request with a stale signature returns 403; a real Twilio request passes.
- **Effort:** S
- **Related task:** none

### BL-003 — Restore `Autopilot` page to navigation
- **Source:** B-01
- **Summary:** Add the route, sidebar entry under "Operations" (or wherever Autopilot logically sits), and a one-line marketing reference. Add a smoke test that verifies the sidebar link reaches a 200-rendered page. Audit the other 952 LOC component for any code that assumes mount order — the file has been quiescent for some time.
- **Acceptance:** A logged-in tenant can click "Autopilot" in the sidebar and reach the page; the page mounts without console errors; backend `/autopilot/*` routes return data.
- **Effort:** S
- **Related task:** none

### BL-004 — Fix Express 5 wildcard SPA fallback
- **Source:** B-02
- **Summary:** Replace `app.get('*', …)` with `app.get('/*splat', …)` (Express 5 named wildcard) or move to a final `app.use((_req, res, next) => …)` handler. Wire a smoke test that does a production-mode boot (`APP_ENV=production`) and ensures the server starts without a `path-to-regexp` exception, then serves `/dashboard` as `index.html`.
- **Acceptance:** Production-mode boot succeeds; SPA route returns the bundled `index.html`.
- **Effort:** S
- **Related task:** none

### BL-005 — Fix auth-middleware error swallowing + tenant pending DB cache
- **Source:** B-04, B-05, I-14
- **Summary:** Two related fixes in `server/admin-api/middleware/auth.ts`. (1) `resolveCurrentRole`'s catch block currently collapses real DB errors into the same path as "no rows" → 403 "No active role in this tenant". Distinguish: log the DB error, return a sentinel that translates to 500. (2) Cache the per-tenant pending status check for 30s in an LRU; invalidate on `tenants/me/verify-checkout` success. (3) Pre-import `platform/db` instead of dynamic `await import` per request.
- **Acceptance:** Forced DB error returns 500 with a logged correlation id; auth latency drops to a single roundtrip on hot path.
- **Effort:** S
- **Related task:** none

---

## P1 — High value (security defense-in-depth, RBAC, performance)

### BL-006 — Tenant-scope guard for URL params + RLS-vs-direct-pool audit
- **Source:** B-06 / S-05
- **Summary:** `requireTenantContext` only inspects `body` and `query`, not URL `:id` slugs. Add a path-param check; make `withTenantContext` mandatory for any handler that touches a tenant-scoped table. Add a runtime assertion in dev mode that throws when a `pool.query` is issued without `withTenantContext` against a known tenant-scoped table. Extend `tests/security/crossTenantEndpoints.test.ts` to cover the 14 routes called out in D-20.
- **Acceptance:** New tests pass; dev assertion fires on any direct `pool.query` against tenant tables.
- **Effort:** M
- **Related task:** none

### BL-007 — Eliminate the three biggest N+1 patterns (dispatch list, scheduling list, tickets list)
- **Source:** I-06, I-07, I-08
- **Summary:** Rewrite `routes/dispatch.ts:listJobsHandler`, `routes/scheduling.ts` booking list, and `routes/tickets.ts:GET /tickets` to use single-query CTEs / `LEFT JOIN LATERAL` patterns. Add a slow-query test that measures wall-time vs row-count.
- **Acceptance:** Page load under a 200-row tenant drops from ~600 queries to ≤ 5; latency budget < 250ms.
- **Effort:** M
- **Related task:** none

### BL-008 — Add per-tenant SSE connection limit + heartbeat
- **Source:** B-07 / I-10
- **Summary:** Reuse `platform/infra/rate-limit/createRateLimiter` keyed on `req.user.tenantId` for `callsLive` and any SSE in `operations.ts`. Cap concurrent connections per tenant (e.g. 20). Emit a `: heartbeat\n\n` comment every 15s.
- **Acceptance:** A single user opening > 20 SSE connections is rate-limited; idle clients auto-disconnect after 60s of no heartbeat ack.
- **Effort:** S
- **Related task:** **#64** is demo-only; this covers tenant + ops.

### BL-009 — Lazy-load 78 React pages (route-level code splitting)
- **Source:** I-16
- **Summary:** Convert eager `import Page from './pages/Page'` lines in `App.tsx` to `React.lazy` with `<Suspense fallback={<PageSkeleton/>}>`. Measure first-paint bundle size before/after.
- **Acceptance:** First-paint JS drops by ≥ 40% (target ~800 KB gzipped → ~450 KB gzipped).
- **Effort:** M
- **Related task:** none

### BL-010 — Audit-log coverage middleware
- **Source:** S-06
- **Summary:** Implement `auditMutation()` middleware that, by default, records every non-GET tenant-scoped request to `audit_log` (resource, action, actor, target id, payload diff). Wire into the routes called out in S-06. Make exclusions opt-in.
- **Acceptance:** New audit entries visible for connector connect/disconnect, widget-token create/delete, phone-number routing change, user invite + role change, encryption rotate, GDPR erase.
- **Effort:** M
- **Related task:** none

### BL-011 — Lock down JWT, cookies, CORS in production
- **Source:** S-07, S-08, S-18, S-19, S-20
- **Summary:** Pin JWT `algorithms: ['HS256']`. Verify `auth_token` cookie sets `HttpOnly`, `Secure`, `SameSite=Lax` by `APP_ENV` (not `NODE_ENV`). In production, replace `cors({ origin: true, credentials: true })` with an explicit `ALLOWED_ORIGINS` env list. Make `X-Frame-Options` only `DENY` in production; `SAMEORIGIN` in dev so the preview iframe works. Make `TURNSTILE_SECRET_KEY` mandatory in production startup validation.
- **Acceptance:** A startup failure when any of the secrets are missing in production; CORS rejects unknown origins in prod; preview iframe still works in dev.
- **Effort:** S
- **Related task:** none

### BL-012 — Open-redirect fix on `/login?redirectTo=`
- **Source:** B-20 / S-03
- **Summary:** Validate `redirectTo` is a same-origin absolute path (`startsWith('/')`, not `startsWith('//')`); fall back to `/dashboard`. Add a Playwright test.
- **Acceptance:** Cross-origin redirect attempts are scrubbed; same-origin paths are honoured.
- **Effort:** S
- **Related task:** none

### BL-013 — `MaintenanceGate` lockout escape
- **Source:** B-25 / S-13 / W-11
- **Summary:** Whitelist `/login`, `/healthz`, and `/admin/*` from the `MaintenanceGate`. Combined with the missing maintenance UI in #214, make sure the admin UI built for #214 displays the maintenance status across all consoles.
- **Acceptance:** Toggling maintenance does not lock platform admins out; tenant users see the maintenance screen.
- **Effort:** S
- **Related task:** **#214** (existing PROPOSED) for the toggle UI; this entry is for the gate behaviour.

### BL-014 — Add HTTPS connector retry + back-off helper
- **Source:** I-02 / I-22
- **Summary:** Single helper `retryWithBackoff(fn, opts)` (3 attempts, 1s/4s/16s, jitter, respect `Retry-After`). Wire into HubSpot, Salesforce, Pipedrive, Slack, Zapier adapters. Drain a separate periodic worker for the `connector_outbox` table to deal with stuck rows.
- **Acceptance:** A 429 from HubSpot is retried after the recommended interval; total adapter latency stays under 60s.
- **Effort:** M
- **Related task:** none

### BL-015 — Account deletion purge worker + email notifications
- **Source:** S-16 / W-12
- **Summary:** Background worker reads `deletion_requests` where `requested_at + 30 days < now()` and `status = 'scheduled'`. Idempotent; transactional per-tenant; writes a final `audit_log` entry; emails the owner before and after.
- **Acceptance:** Test with a synthetic deletion request fast-forwarded by 31 days; row is purged; audit recorded.
- **Effort:** M
- **Related task:** **#210** (PROPOSED) is the API + UI side. BL-015 focuses on the worker. Not duplicate.

---

## P2 — Medium (UX consistency, integration polish, observability)

### BL-016 — Empty/loading/error state design system pass
- **Source:** B-15 / U-03 / W-04 (mini-systems)
- **Summary:** Build `<EmptyState>`, `<ErrorState>`, `<Skeleton>` components in `client-app/src/components/state/`. Sweep Tickets, Dispatch, Scheduling, SmsInbox, KnowledgeBase, Marketplace, Workflows, Calls, Agents, AdminAnalytics, Compliance.
- **Acceptance:** Every list/detail page in the audited 78 uses the shared trio.
- **Effort:** M
- **Related task:** none

### BL-017 — Per-vertical pre-built analytics dashboards
- **Source:** R-03 / C-13
- **Summary:** Five dashboards: medical/dental, field-service, real-estate, legal, restaurant. Each is a saved view with a curated set of charts on the existing analytics endpoints, plus a small JSON metadata file under `client-app/src/pages/analytics/dashboards/`.
- **Acceptance:** A medical-vertical tenant lands on `/analytics` and sees the medical dashboard by default; can switch via dropdown.
- **Effort:** M
- **Related task:** none

### BL-018 — In-product walkthroughs for Autopilot, Digital Twin, Evolution Engine, GIN
- **Source:** C-17 / R-06
- **Summary:** Use the existing `ProductTour` component to ship one tour per surface; each is invoked from a "What is this?" affordance in the page header.
- **Acceptance:** First-time tenant visit to each page triggers a guided tour; can be replayed from a "?" button.
- **Effort:** M
- **Related task:** none

### BL-019 — Public marketing posture page (compliance badges + posture endpoint)
- **Source:** C-18 / R-04 / S-15
- **Summary:** New `/security/posture` page in the public marketing site listing SOC 2 / HIPAA / GDPR posture, sub-processor list, and BAA availability. Backed by a public endpoint `/public/posture` returning the same JSON.
- **Acceptance:** Page renders; JSON validates against a posture schema; subprocessor list pulls from `routes/legalCompliance.ts`.
- **Effort:** M
- **Related task:** **#211, #212, #213** touch the legal/subprocessor surface but are about admin authoring; this is the public posture page.

### BL-020 — Per-minute pricing transparency on `/pricing`
- **Source:** C-19 / R-07
- **Summary:** Add a calculator widget under each plan tier: choose monthly minutes, see effective price; show overage rate.
- **Acceptance:** Calculator is interactive; numbers match billing meter.
- **Effort:** S
- **Related task:** none

### BL-021 — Multi-language preference per agent
- **Source:** C-21 / R-08
- **Summary:** Add a `language` field to `agents` (default `en`). Surface in `AgentBuilder`. Forward as the `language` parameter to OpenAI Realtime session config.
- **Acceptance:** A Spanish-language agent answers in Spanish; admin can pick from a dropdown of 12 languages.
- **Effort:** M
- **Related task:** none

### BL-022 — Connector OAuth proactive token refresh worker
- **Source:** I-05 / W-10
- **Summary:** Worker that scans `connector_tokens` and refreshes any token with < 24h to expiry.
- **Acceptance:** No 401 on first call after long idle.
- **Effort:** S
- **Related task:** none

### BL-023 — `formatCurrency` helper + canonical "cents-everywhere" migration
- **Source:** D-03 / D-08
- **Summary:** Centralise currency formatting; migrate `usage_metrics` and `cost_optimization` columns to integer cents; rewrite the analytics rollups to match.
- **Acceptance:** All currency values pass through `formatCurrency`; analytics costs stop being off by 100×.
- **Effort:** M
- **Related task:** none

### BL-024 — Twilio webhook + STIR/SHAKEN attestation prep
- **Source:** I-03 (separate from BL-002) + C-20
- **Summary:** Add Twilio Trusted Caller flow for outbound campaigns; data model for verified caller IDs; admin UI to register and rotate.
- **Acceptance:** Outbound campaign can be configured to use a verified Trusted Caller; carriers attest A.
- **Effort:** L
- **Related task:** none

### BL-025 — Discoverability sweep on the public marketing site
- **Source:** C-02, C-05, C-07 / R-15
- **Summary:** Three new sections: "Federated Ingest" (developer marketing), "Global Intelligence Network" (cross-tenant benchmarks story), "Vertical Agents" (Azul Vision + medical/dental/field-service templates).
- **Acceptance:** Three new pages under `/product/*` and `/industries/*`; nav and search updated.
- **Effort:** M
- **Related task:** **#221** is one part of the GIN story; BL-025 expands beyond it.

### BL-026 — Workforce / autopilot endpoints cross-tenant test coverage
- **Source:** D-20
- **Summary:** Extend `tests/security/crossTenantEndpoints.test.ts` to cover `/workforce/*`, `/autopilot/*`, `/digital-twin/*`, `/evolution/*`, `/insights/*`, `/improvements/*`, `/case-studies/*`, `/widget/tokens/*`, `/knowledge-documents/:id`, `/tool-executions/:id/replay`, `/marketplace/installations/:id/customize`.
- **Acceptance:** All 14 endpoints tested across two tenants in CI.
- **Effort:** M
- **Related task:** none

### BL-027 — Secure cookie + state cookie verification on `connectorOAuth`
- **Source:** I-04 / W-10
- **Summary:** Audit `connectorOAuth.ts` to confirm `state` cookie has `Secure`, `HttpOnly`, `SameSite=Lax`, max-age 600s. Add a regression test.
- **Acceptance:** Set-Cookie header in tests asserts the four attributes.
- **Effort:** S
- **Related task:** none

### BL-028 — Mobile app for dispatch + scheduling (Expo)
- **Source:** C-14 / R-05
- **Summary:** A new Expo project under `mobile/` with screens for: assigned jobs (Dispatch), upcoming appointments (Scheduling), accept/decline, en-route status, customer contact.
- **Acceptance:** Builds for iOS and Android via Expo EAS; reads from existing admin-api endpoints with API key.
- **Effort:** L
- **Related task:** none

### BL-029 — Outbound dialer hardening: TCPA-class controls + carrier DNC scrub
- **Source:** C-20 / R-09
- **Summary:** Pre-flight every outbound campaign against the carrier-level DNC; surface a "compliance score" per campaign; add quiet-hours per area code.
- **Acceptance:** Campaign with DNC-listed numbers refuses to launch; quiet-hours block dialing in those windows.
- **Effort:** L
- **Related task:** none

---

## P3 — Polish + low-risk wins

### BL-030 — Replace bare `console.log('[REQ]')` with `createLogger('REQ')`
- **Source:** B-16 / S-11
- **Summary:** Use the centralised PHI-redacting logger.
- **Effort:** S
- **Related task:** none

### BL-031 — `RevenueAnalytics.tsx` deletion
- **Source:** B-18
- **Summary:** Delete the 534-LOC orphan; keep the redirect.
- **Effort:** S
- **Related task:** none

### BL-032 — `Settings` page route + remount fix
- **Source:** B-11 / U-04
- **Summary:** Single `/settings/:tab` route; render with internal tabs; one mount.
- **Effort:** S
- **Related task:** none

### BL-033 — Trial banner `staleTime` + provisioning-status caching
- **Source:** B-10 / B-17
- **Summary:** Add `staleTime` to both queries; reduce request volume.
- **Effort:** S
- **Related task:** none

### BL-034 — Footer year + small a11y sweep
- **Source:** B-37, A-01..A-08
- **Summary:** Dynamic year; aria-label sweep; focus traps; modal primitive standardisation.
- **Effort:** S
- **Related task:** none

### BL-035 — KnowledgeBase upload MIME allow-list + magic-byte sniffing
- **Source:** B-21
- **Summary:** Multer `fileFilter` and a magic-byte check.
- **Effort:** S
- **Related task:** none

### BL-036 — `Compliance` cross-tenant view at `/admin/security`
- **Source:** B-29 (also called out in `tenant-admin-isolation-audit.md` §4)
- **Summary:** Build a platform-wide compliance view; for now `/admin/security` reuses the tenant component which is misleading.
- **Effort:** M
- **Related task:** none

### BL-037 — `OpsLayout` notifications bell + assistant FAB
- **Source:** B-08, B-09
- **Summary:** Render `<NotificationsCenter />` and `<PlatformAssistant />` in `OpsLayout` (and admin); remove the dead imports.
- **Effort:** S
- **Related task:** none

### BL-038 — Calendar / appointment availability includes overrides
- **Source:** D-15 / W-05
- **Summary:** Include `schedule_overrides` in `availabilityHandler` and downstream booking eligibility.
- **Effort:** S
- **Related task:** none

### BL-039 — `AdminAnalytics` MRR excludes trialing
- **Source:** D-18
- **Summary:** Filter `status IN ('active', 'past_due')`; add a separate "Pipeline MRR" card.
- **Effort:** S
- **Related task:** none

### BL-040 — `KnowledgeBase` markdown XSS hardening + autosave
- **Source:** B-34 / S-21 / P-KnowledgeBase
- **Summary:** DOMPurify wrap on render; autosave on the article editor.
- **Effort:** S
- **Related task:** none

### BL-041 — Federated ingest backfill endpoint + 7-day window relaxation
- **Source:** W-08
- **Summary:** A `/ingest/calls/backfill` endpoint that accepts older `occurred_at` with explicit attestation; widen the window to 30 days; idempotency token decoupled from external_id.
- **Effort:** M
- **Related task:** none

### BL-042 — Onboarding wizard step persistence
- **Source:** W-15
- **Summary:** Persist `onboarding_step` in `users.preferences`; resume on next login.
- **Effort:** S
- **Related task:** none

### BL-043 — Bundle/performance baseline metrics
- **Source:** I-16
- **Summary:** Add a `npm run analyze` script using `vite-bundle-visualizer`; record baseline numbers in `docs/perf/baseline.md`.
- **Effort:** S
- **Related task:** none

### BL-044 — `usage_metrics` composite index + `call_events` retention partition
- **Source:** I-23, I-24
- **Summary:** Add `(tenant_id, recorded_at DESC, metric_type)` index; partition `call_events` by month with a 90-day prune job.
- **Effort:** M
- **Related task:** none

---

## Summary counts

- P0: 5 items
- P1: 10 items
- P2: 14 items
- P3: 15 items
- **Total: 44 new backlog items**, all cross-checked against the 99 existing project tasks.
- **Items that intentionally pair with existing PROPOSED tasks:** BL-008 (#64), BL-013 (#214), BL-015 (#210), BL-019 (#211/#212/#213), BL-025 (#221).
- All remaining 39 items carry `Related task: none`.

The `00-system-audit-report.md` summarises coverage; this document is the actionable output. Review and accept/defer per priority tier; pull P0 items into the next sprint.
