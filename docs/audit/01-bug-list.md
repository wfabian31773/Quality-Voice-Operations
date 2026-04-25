# 01 — Bug List

Format: each entry has **id, severity, area, repro, expected, actual, suspected fix, related task**.
Severity: **P0** = blocks usage / data loss / security; **P1** = breaks a primary flow; **P2** = degraded UX or edge case; **P3** = polish.

---

## P0

### B-01 — `Autopilot` UI page is an orphan; backend worker runs anyway
- **Area:** Tenant Portal navigation, `client-app/src/App.tsx`, `pages/Autopilot.tsx`.
- **Repro:** Navigate to any sidebar entry. There is no link to `/autopilot`. Manually visit `/autopilot` → 404 (`NotFound`). Yet `server/admin-api/routes/autopilot.ts` is registered (~24 endpoints) and `pages/Autopilot.tsx` is 952 LOC and imports working components.
- **Expected:** Either expose the page as a navigable route, or remove the dead UI + endpoints behind a feature flag.
- **Actual:** Component code, backend endpoints, and DB tables all exist; the route is missing from `App.tsx`. Customers paying for "AI Business Autopilot" cannot reach it.
- **Suspected fix:** Add `<Route path="/autopilot" element={<Autopilot />} />` to the tenant section of `App.tsx`, plus a sidebar entry under "Operations". Or delete the page + routes if Autopilot has been replaced.
- **Related task:** none (does not overlap #209 "Remove unused backend endpoints for the deleted orphan pages" — that task is about the *opposite* problem of stale endpoints; this is a stale page).

### B-02 — Express 5 SPA fallback uses legacy wildcard syntax (`app.get('*', …)`) — silently fails route registration in Express 5
- **Area:** `server/admin-api/app.ts` line `app.get('*', (_req, res) => res.sendFile(...))`.
- **Repro:** Build for production (`APP_ENV=production npm run build && npx tsx server/admin-api/start.ts`). In Express 5, `path-to-regexp@8` no longer accepts the bare `*` token — it throws `TypeError: Missing parameter name at 1`.
- **Expected:** Static SPA falls back to `index.html` for unknown routes.
- **Actual:** In production the admin API process exits at startup with a path-to-regexp error, so the bundled SPA is never served. Dev mode is unaffected because Vite proxies. This is invisible until the next deploy.
- **Suspected fix:** Use `app.get('/*splat', …)` (Express 5 named wildcard) or `app.use((_req, res) => res.sendFile(...))` mounted last.
- **Related task:** none.

### B-03 — Webhook URL SSRF allow-list is string-based (no DNS resolution); attacker can register a public hostname that resolves to RFC1918
- **Area:** `platform/integrations/connectors/adapters/zapier.ts:isAllowedWebhookUrl`.
- **Repro:** As any tenant manager, install the Zapier connector and set `webhook_url` to `https://attacker-controlled-domain.example/`, where DNS for that hostname resolves to `10.0.0.7`. The check examines only the literal hostname string, so the request is sent to the internal IP via DNS resolution at fetch time.
- **Expected:** Webhook fetch is blocked when DNS resolves to a private/loopback/link-local/metadata IP.
- **Actual:** Fetch reaches the internal address; response is returned to the adapter (limited to 200 chars in the error message but exfiltration is possible by chunking).
- **Suspected fix:** Resolve the hostname first (`dns.lookup` for both A and AAAA), reject if any resolved address falls in any of: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`, `::1/128`, `0.0.0.0/8`. Then `fetch` with the resolved IP literal in a `lookup` callback option to defeat DNS rebinding mid-request, or cache the resolved IP and call by IP with `Host:` header.
- **Related task:** none.

### B-04 — `auth.ts` middleware silently swallows DB errors during role resolution and surfaces them as `403 No active role in this tenant`
- **Area:** `server/admin-api/middleware/auth.ts:resolveCurrentRole`.
- **Repro:** Cause a transient DB error (e.g. drop the `user_roles` table briefly during a seed run). Every authenticated request returns 403 "No active role in this tenant" instead of 5xx; the operator has no signal that the DB failed.
- **Expected:** DB errors surface as 500 with a logged correlation id; 403 only when the user genuinely has no role.
- **Actual:** `try { … } catch { return null }` collapses both the empty-rows and DB-error paths into one. The earlier `await client.query('ROLLBACK')` is reachable even when `BEGIN` succeeded but is not awaited inside the rollback path's try, so `ROLLBACK` of a closed transaction also throws and gets swallowed.
- **Suspected fix:** Distinguish the two: catch only the DB error, log it, return a sentinel `{ error: true }` and have `requireAuth` map that to 500.
- **Related task:** none.

---

## P1

### B-05 — Tenant pending-status check runs a synchronous DB query on **every authenticated request**
- **Area:** `server/admin-api/middleware/auth.ts` (after `resolveCurrentRole`).
- **Repro:** Send 1,000 authenticated requests in 5 seconds — observe one extra `SELECT status FROM tenants WHERE id = $1` per request, plus a dynamic `await import('../../../platform/db')`.
- **Expected:** The pending status is cached for at least a few seconds, or stored on the JWT and re-resolved only on `tenants/me/verify-checkout`.
- **Actual:** Every request hits the DB twice (`user_roles` for role + `tenants` for status). Under load this dominates the auth middleware budget.
- **Suspected fix:** Add a 30-second in-memory LRU keyed by `tenantId` that caches `status === 'ready'`; invalidate on `verify-checkout` success.
- **Related task:** none.

### B-06 — `requireTenantContext` does not check URL path params; cross-tenant id in `:id` slugs relies entirely on each route's own SQL `WHERE` clause
- **Area:** `server/admin-api/middleware/tenantGuard.ts`.
- **Repro:** Confirm by inspection — guard inspects `req.body` and `req.query` only. A handler that forgets the `WHERE tenant_id = req.user.tenantId` clause and is not wrapped in `withTenantContext` would leak data from `/calls/:id` if `:id` is a foreign UUID. Tests in `tests/security/crossTenantEndpoints.test.ts` do cover the major resources, but new endpoints added since #108 (e.g. dispatch, scheduler, ticketing extensions in migrations 048–065) are not all covered.
- **Expected:** Guard inspects path params and forces `withTenantContext` for any `:id` route.
- **Actual:** Path param leaks are caught only by per-route SQL discipline + RLS at the row level. RLS does protect, but only when `withTenantContext` runs first; routes that use `pool.query` directly without `withTenantContext` (a common pattern in lighter handlers) bypass RLS entirely.
- **Suspected fix:** Add an audit check that any handler reading from a tenant-scoped table either runs inside `withTenantContext` or includes an explicit `tenant_id = $X` predicate. Add a lint rule or runtime assertion in dev.
- **Related task:** none.

### B-07 — SSE endpoints (`callsLive`, parts of `operations`) have no per-tenant rate limit
- **Area:** `server/admin-api/routes/callsLive.ts`, `operations.ts`.
- **Repro:** Open `/calls-live/stream` (or whatever the SSE endpoint is) repeatedly; only the demo SSE has an IP-keyed limiter (`platform/infra/rate-limit/createRateLimiter` is used only by `demoLive.ts`).
- **Expected:** Per-tenant connection cap (e.g. 20 concurrent SSE per tenant; 60 connects/min).
- **Actual:** A single user can open hundreds of SSE streams and exhaust connections. Existing PROPOSED task #64 covers the *demo* side but not the tenant-portal SSE.
- **Suspected fix:** Reuse `createRateLimiter` keyed on `req.user.tenantId` for `callsLive` and any other SSE route in `operations.ts`.
- **Related task:** none (#64 is demo-only).

### B-08 — `Operations` and `OpsLayout` mount `PlatformAssistant` *only* on tenant routes — operations users can't get the in-app assistant
- **Area:** `client-app/src/App.tsx`, `OpsLayout.tsx`, `AdminLayout.tsx`.
- **Repro:** Sign in as an ops-only user, navigate `/ops/monitor`. The Platform Assistant FAB is missing. The component is imported in all three layouts but only rendered in tenant; admin/ops layouts import but never instantiate it.
- **Expected:** Assistant is available in all three control planes, scoped to its console.
- **Actual:** `import PlatformAssistant from './PlatformAssistant'` is unused in `AdminLayout.tsx` and `OpsLayout.tsx` (dead imports).
- **Suspected fix:** Render `<PlatformAssistant />` at the bottom of each layout's JSX, or remove the unused imports.
- **Related task:** none.

### B-09 — `OpsLayout` lacks the `NotificationsCenter` bell that `TenantLayout` and `AdminLayout` both render
- **Area:** `client-app/src/components/OpsLayout.tsx` header.
- **Repro:** Open `/ops/monitor`. The header has no notifications bell; ops users miss connector-sync errors and outage alerts.
- **Expected:** Notifications surface in all three consoles.
- **Actual:** Header element is `<div className="w-5 lg:hidden" />` (placeholder). Notification feed is generated by routes already shared.
- **Suspected fix:** Add `<NotificationsCenter />` to the right-hand side of the ops header.
- **Related task:** none.

### B-10 — `TenantLayout` polls `/tenants/me/provisioning-status` on every mount with no cache and no jitter
- **Area:** `client-app/src/components/TenantLayout.tsx:useEffect`.
- **Repro:** Navigate between any two pages inside the tenant portal (e.g. `/dashboard` → `/agents`). Each navigation re-mounts `TenantLayout`'s effect and refires `GET /tenants/me/provisioning-status`.
- **Expected:** Provisioning status fetched once per session and cached via React Query (already imported in this file).
- **Actual:** Direct `api.get` instead of `useQuery`; one extra request per navigation.
- **Suspected fix:** Move the call into a `useQuery(['provisioning-status'], …)` with `staleTime: 60_000`.
- **Related task:** Possibly overlaps #208 ("Tenant portal polish") but that task does not name this; treat as new.

### B-11 — `Settings` page reuses one component for 5 routes and re-fetches everything on tab change
- **Area:** `client-app/src/pages/Settings.tsx`, `App.tsx`.
- **Repro:** All five `/settings/*` routes render the same `<Settings />` component. The component reads the path to decide which tab to show but mounts and re-fetches all sections (general, roles, security, api-keys, privacy) on every tab change because each `<Route element={<Settings/>} />` is a fresh mount.
- **Expected:** Either a single route with internal tabs (no remount) or per-tab routes that each render their own focused component.
- **Actual:** Network waterfall on every tab switch.
- **Suspected fix:** Switch to a single `<Route path="/settings/:tab" />` and use `useParams().tab` to switch panels without remount.
- **Related task:** none.

### B-12 — `BookDemo.tsx` form has no real backend integration; it pretends to submit
- **Area:** `client-app/src/pages/public/BookDemo.tsx`.
- **Repro:** Fill the form on `/book-demo` and submit. The form posts (the route handler exists) but does not create a calendar event or notify sales — the existing PROPOSED task **#206** explicitly covers this.
- **Expected:** Form creates a real calendar booking.
- **Actual:** Lead is recorded in `marketing-leads` only.
- **Related task:** **#206** (already PROPOSED). Listed here for completeness; not added to the new backlog.

### B-13 — `Maintenance` page exists, but Platform Admin has no UI to toggle maintenance mode
- **Area:** `pages/Maintenance.tsx`, `routes/productionEssentials.ts:PUT /platform/maintenance`.
- **Repro:** Endpoint requires only platform admin. There is no admin page that calls `PUT /platform/maintenance`.
- **Related task:** **#214** (already PROPOSED).

### B-14 — Public marketing dark mode is broken on multiple pages
- **Area:** `client-app/src/pages/public/*` and `Demo.tsx`.
- **Repro:** Toggle dark mode (button only present after login, but persisted across logout) → many public pages have hardcoded light backgrounds with white text.
- **Related task:** **#218** (Demo dark-mode), **#219** (public marketing dark-mode). Not added to the new backlog.

### B-15 — Empty/loading/error states are inconsistent across the long mini-system pages (`Tickets`, `Dispatch`, `Scheduling`, `SmsInbox`)
- **Area:** All four files (1.4–1.9k LOC each).
- **Repro:** Open any of these pages with a brand-new tenant (no rows). Some panels show a friendly empty illustration, others show an empty `<table>` with just headers, others show a perpetual skeleton.
- **Expected:** Shared `<EmptyState>` and `<ErrorState>` components used uniformly.
- **Actual:** Mixed conventions; new operators are confused.
- **Suspected fix:** Audit the four files, normalise to one `<EmptyState illustration="…" title="…" actionLabel="…" />` component; add an `<ErrorState retryFn={…} />`.
- **Related task:** none.

---

## P2

### B-16 — `console.log('[REQ] …')` in `app.ts` runs for every non-GET and every auth path; not redacted
- **Area:** `server/admin-api/app.ts` middleware.
- **Repro:** Any login → `console.log` records `req.path` and `req.ip`. Body is not logged but the IP is, and there is no PHI redaction tied in.
- **Expected:** Use `createLogger('REQ')` so the formatter applies log levels and the central PHI redactor (`platform/core/phi`) intercepts.
- **Actual:** Bare `console.log` bypasses log-level filtering and JSON formatting.
- **Suspected fix:** Replace with `logger.info`.

### B-17 — Trial banner re-renders on every notification poll because of `useQuery` key collision
- **Area:** `client-app/src/components/TrialBanner.tsx` (used inside `TenantLayout`).
- **Repro:** Open Network tab; observe that `GET /tenants/me/trial-status` re-fires every 30s without a `staleTime`, causing the banner to flash.
- **Expected:** `staleTime` of at least 5 minutes for trial status.
- **Actual:** Default of 0.
- **Suspected fix:** Set `staleTime: 5 * 60 * 1000`.

### B-18 — `RevenueAnalytics.tsx` is a 534-LOC page imported nowhere, kept only because `Navigate to="/analytics"` redirects from `/revenue-analytics`
- **Area:** `App.tsx`, `pages/RevenueAnalytics.tsx`.
- **Repro:** Code search shows the import is gone from `App.tsx`, only the redirect remains. The 534-LOC component is dead code.
- **Expected:** Remove the file or restore as a tab if still useful.
- **Actual:** Compiles into the bundle; ~50 KB of dead JS.
- **Suspected fix:** Delete the file.

### B-19 — `TenantLayout` keyboard handler swallows `?` even inside contenteditable elements
- **Area:** `TenantLayout.tsx:useEffect` keydown handler.
- **Repro:** Focus a `contenteditable` rich-text panel (knowledge-base editor) and press `?`. The shortcuts modal opens.
- **Expected:** Skip when target is `INPUT`, `TEXTAREA`, *or* `[contenteditable]`.
- **Actual:** Only `INPUT`/`TEXTAREA` are skipped.
- **Suspected fix:** Add `tag !== 'DIV' || !target.isContentEditable` check.

### B-20 — Login `redirectTo` query param is not validated against an allow-list
- **Area:** `client-app/src/pages/Login.tsx`.
- **Repro:** Visit `/login?redirectTo=https://attacker.com`. After login the SPA navigates to that absolute URL → open redirect.
- **Expected:** Only same-origin paths starting with `/`.
- **Actual:** No validation visible.
- **Suspected fix:** `if (!redirectTo.startsWith('/') || redirectTo.startsWith('//')) { redirectTo = '/dashboard' }`.

### B-21 — `KnowledgeBase` document upload accepts `multipart/form-data` with no MIME allow-list
- **Area:** `server/admin-api/routes/knowledgeDocuments.ts:POST /knowledge-documents/upload`.
- **Repro:** Upload an `.exe` masquerading as `.pdf`. Accepted, stored, attempted-parsed.
- **Expected:** Reject by both extension and sniffed magic bytes; log rejection.
- **Actual:** Multer config likely accepts any file (need confirmation; the route has `upload.single('file')` with no fileFilter visible).
- **Suspected fix:** Add `fileFilter` allowing `.pdf .docx .txt .md .html` and a max file size, and enforce a MIME sniff.

### B-22 — Phone-number provisioning is documented as "manual" in PLATFORM_READINESS_AUDIT but the UI implies automated purchase
- **Area:** `pages/PhoneNumbers.tsx`, `routes/phoneNumbers.ts`.
- **Repro:** Click "Provision number" — the modal lists Twilio search results. But the merged backend implementation is "manual registration" per the readiness audit. If a number is selected, the backend may stub the purchase silently.
- **Expected:** Either implement Twilio purchase or label clearly "register a number you already own in Twilio".
- **Actual:** UX implies one-click purchase; backend may not actually buy.
- **Suspected fix:** Confirm by checking `routes/phoneNumbers.ts:POST /phone-numbers/provision`; if it does not call `client.incomingPhoneNumbers.create`, gate behind a feature flag and adjust the modal copy.

### B-23 — `Marketplace` page is one component for three routes (browse, installed, detail) — relies on `useParams().id` and pathname switching
- **Area:** `pages/Marketplace.tsx` (~1.6k LOC).
- **Repro:** Navigating between the three modes triggers a full re-render and re-fetch.
- **Suspected fix:** Split into `MarketplaceBrowse`, `MarketplaceInstalled`, `MarketplaceDetail`.

### B-24 — `Changelog` page exists in tenant portal, but admin task #215 calls out that admins can't author entries — the read-side has no "unread" badge in the sidebar
- **Area:** `Changelog.tsx`, `TenantLayout.tsx` sidebar.
- **Repro:** Navigate to `/changelog` — UI fine. Sidebar has no link and no unread count.
- **Related task:** **#215** (admin authoring) is PROPOSED; the missing sidebar link is new.

### B-25 — `MaintenanceGate` blocks all routes including `/login` and `/healthz` when maintenance is on, locking platform admins out
- **Area:** `client-app/src/components/MaintenanceGate.tsx` wraps `App.tsx` Routes.
- **Repro:** Toggle maintenance on (via the API directly per #214) → admins cannot log in to turn it off.
- **Expected:** `/login`, `/healthz`, and `/admin/*` paths bypass the gate; or admins authenticated by JWT can override.
- **Actual:** Universal block.
- **Suspected fix:** Whitelist auth and admin paths, or add an `?override=<adminToken>` escape hatch.

### B-26 — Many empty / disabled buttons (e.g. "Coming soon" pills) silently no-op rather than redirecting
- **Area:** Multiple — sample seen in `Autopilot`, `EvolutionEngine`, `DigitalTwin` industry-pack tabs.
- **Repro:** Click any "Coming soon" pill — nothing happens, no tooltip, no link to a roadmap.
- **Expected:** Tooltip explaining the feature, or link to product roadmap.
- **Actual:** Dead pixels.

### B-27 — `AcceptInvite.tsx` does not handle expired tokens distinctly — same generic error as "invalid token"
- **Area:** `pages/AcceptInvite.tsx`.
- **Repro:** Use a token older than the configured expiry. UI shows "Invalid invite" with no path to request a new one.
- **Expected:** Differentiate "expired" vs "invalid"; offer "request a new invite".

### B-28 — `Dispatch` and `Scheduling` pages do not surface RBAC errors clearly
- **Area:** Both pages.
- **Repro:** As a `support_reviewer` (viewer-equivalent), open `/dispatch` — many buttons are visible but each click yields a 403 toast at the bottom.
- **Expected:** Hide or disable write buttons for users without `requireMiniSystemWrite`.
- **Actual:** Buttons render; clicks fail.

### B-29 — `Compliance` page is rendered both at `/compliance` and `/admin/security` with the same component — no admin-specific cross-tenant view
- **Area:** `App.tsx` route map.
- **Repro:** `/admin/security` shows only the current admin's tenant data, not platform-wide compliance posture.
- **Related:** Already noted as a "deferred follow-up" in `docs/tenant-admin-isolation-audit.md` §4. Not new but worth flagging.

### B-30 — `Onboarding` does not handle Stripe webhook race — if checkout completes before the polling cycle, the tenant briefly sees "still provisioning"
- **Area:** `pages/Onboarding.tsx`.
- **Repro:** Complete Stripe checkout in a fast flow. The Onboarding page polls every 5s but the webhook may arrive 1s later.
- **Expected:** Subscribe to a server-sent push (SSE) or call `verify-checkout` immediately on return from Stripe before polling kicks in.
- **Actual:** Up to 5s latency before the page advances.

---

## P3

### B-31 — `OpsLayout` and `AdminLayout` mobile menu close button overlaps with notification bell on narrow viewports.
### B-32 — `Calls.tsx` table column widths overflow on 1280-px screens with long agent names.
### B-33 — `AgentBuilder` node search uses `.includes()` (case-sensitive) — typing "intent" misses "Intent capture" nodes.
### B-34 — `KnowledgeBase` markdown rendering does not sanitise raw `<script>` tags from older imports (rare; only legacy data).
### B-35 — `Settings → API Keys` masks the secret only after page navigation away — the freshly-created key remains in memory in plain text on history navigation back.
### B-36 — Dashboard "Today's calls" card shows `NaN%` change when yesterday had 0 calls.
### B-37 — Footer copyright on the public site is hardcoded "2025"; needs a `new Date().getFullYear()`.
### B-38 — `BookDemo` and `Contact` pages do not include the Cloudflare Turnstile widget even when `TURNSTILE_SITE_KEY` is set, so server-side verification always passes.
### B-39 — `Demo` page audio element does not pause when the user navigates away mid-call.
### B-40 — `Notifications` API returns `created_at` as ISO string but the badge label uses `Date(value).toLocaleString()` without a tenant-timezone setting.
