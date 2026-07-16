# QVO route and customer-surface inventory

> Supporting evidence for [QVO GTM execution control](./qvo-gtm-execution-control.md), the canonical plan. This inventory records Work Package 1 implementation details and does not define an independent roadmap.

## Verification record

- Repository: `/Users/waynefabian/Downloads/Quality-Voice-Operations-main`
- Remote: `https://github.com/wfabian31773/Quality-Voice-Operations.git`
- Baseline branch/commit: `main` at `748c7bb8871aba0de597ac89a03d96a468c85626`
- Implementation branch: `codex/qvo-surface-reduction`
- Public router entrypoints: `client-app/src/App.tsx` and `client-app/src/PublicApp.tsx`
- Shared marketing request classifier: `shared/spa/marketingRoutes.ts`
- Customer/internal policy: `client-app/src/lib/surfacePolicy.ts`
- No applicable `AGENTS.md` was present.
- Validation/build commands use npm. Both npm and pnpm lockfiles are present at the root and in `client-app`; this package did not modify either lockfile.

The pre-existing untracked `.claude/` directory belongs to the local workspace and is not part of this work package.

## Visibility contract

| Audience | Navigation and route access |
| --- | --- |
| Anonymous prospect | Focused home, pricing, demo, contact/book-demo, healthcare/dental, case-study proof, and legal/security pages |
| Tenant member/viewer | Dashboard, calls, tickets, knowledge base, phone numbers, billing, settings, users/support |
| Tenant manager/owner | Same product surfaces as other tenant users; tenant-level permissions may still enable management inside an allowed surface |
| QVO staff | All customer routes plus retained internal tools, platform administration, and operations |
| Platform admin | The current explicit QVO-staff identity: JWT/database `isPlatformAdmin === true` |

Tenant role names such as `tenant_owner`, `tenant_admin`, `operations_manager`, and `agent_developer` are customer roles and do not grant QVO-staff route access.

## Public routes

| Route | Current exposure | Final classification | Guard/behavior | Notes |
| --- | --- | --- | --- | --- |
| `/` | Public | Customer-facing | `PublicLayout` | Focused landing page |
| `/pricing` | Public | Customer-facing | `PublicLayout` | Retained |
| `/demo` | Public | Customer-facing | `PublicLayout` | Retained receptionist demo |
| `/contact` | Public | Customer-facing | `PublicLayout` | Retained |
| `/book-demo` | Public | Customer-facing | `PublicLayout` | Primary conversion route |
| `/industries/healthcare` | Public | Customer-facing | `PublicLayout` | Approved healthcare use case |
| `/industries/dental` | Public | Customer-facing | `PublicLayout` | Healthcare-adjacent use case |
| `/case-studies`, `/case-studies/:slug` | Public | Customer-facing | `PublicLayout` | Retained as outcome proof |
| `/terms`, `/privacy` | Public | Customer-facing | `PublicLayout` | Legal |
| `/security`, `/security/posture`, `/subprocessors` | Public | Customer-facing | `PublicLayout` | Security/compliance posture |
| `/product`, `/features`, `/ai-agents`, `/use-cases`, `/integrations` | Public before package | Hidden/deferred | Standard public `*` not-found | Generic platform positioning; source retained |
| `/product/federated-ingest`, `/product/global-intelligence-network` | Public before package | Hidden/deferred | Standard public `*` not-found | GIN/federated platform positioning; source retained |
| `/docs`, `/docs/:slug` | Public before package | Hidden/deferred | Standard public `*` not-found | Self-service developer/product docs; source retained |
| `/resources`, `/resources/:slug` | Public before package | Hidden/deferred | Standard public `*` not-found | Current guides advertise self-service Agent Builder, integrations, and campaigns; source retained |
| `/blog`, `/blog/:slug` | Public before package | Hidden/deferred | Standard public `*` not-found | Broad generic voice-agent positioning; source retained |
| `/signup` | Public before package | Hidden/deferred | Standard public `*` not-found | Managed setup replaces self-service signup; source retained |
| `/industries/vertical-agents`, `/industries/legal`, `/industries/real-estate`, `/industries/home-services` | Public before package | Hidden/deferred | Standard public `*` not-found | Non-launch verticals; source retained |

Localized variants use the same classification after stripping `/en`, `/es`, `/pt-BR`, `/fr`, or `/de`. Hidden public routes are absent from both SPA route entrypoints, the shared marketing classifier, public navigation/search, and the generated sitemap.

## Authentication and standalone routes

| Route | Classification | Guard/behavior |
| --- | --- | --- |
| `/login`, `/signin`, `/forgot-password`, `/accept-invite`, `/auth/verify-email` | Authentication | Existing authentication flow |
| `/track/:token` | Public utility | Token-scoped booking tracker |
| `/internal/design-directions` | Internal-only utility | `ProtectedRoute` + `PlatformAdminGuard` |
| `/onboarding` | Internal-only | `ProtectedRoute` + `PlatformAdminGuard` |
| `/agents/:id/builder` | Internal-only | `ProtectedRoute` + `PlatformAdminGuard` |

## Authenticated tenant routes

| Route | Final classification | Guard/behavior |
| --- | --- | --- |
| `/dashboard` | Customer-facing | `ProtectedRoute`; internal dashboard cards/links filtered with `isQvoStaff` |
| `/calls` | Customer-facing | `ProtectedRoute` |
| `/tickets`, `/tickets/:id` | Customer-facing | `ProtectedRoute` |
| `/knowledge-base` | Customer-facing | `ProtectedRoute` |
| `/phone-numbers` | Customer-facing | `ProtectedRoute`; connector remediation links are staff-only |
| `/billing` | Customer-facing | `ProtectedRoute` |
| `/settings`, `/settings/:tab` | Customer-facing | `ProtectedRoute`; `/settings/api-keys` is staff-only and normalizes to General for customers |
| `/users` | Customer-facing | `ProtectedRoute`; existing tenant role controls remain in effect |
| `/agents`, `/workflows`, `/campaigns`, `/connectors`, `/analytics` | Internal-only | Nested `PlatformAdminGuard`; customer direct URLs redirect to `/dashboard` |
| `/marketplace`, `/marketplace/installed`, `/marketplace/purchases`, `/marketplace/:id`, `/marketplace/updates`, `/marketplace/installations/:installationId/setup` | Internal-only | Nested `PlatformAdminGuard` |
| `/trusted-callers`, `/quality`, `/audit-log`, `/compliance`, `/widget`, `/developer` | Internal-only | Nested `PlatformAdminGuard` |
| `/sms-inbox`, `/scheduling`, `/dispatch`, `/autopilot` | Internal-only | Nested `PlatformAdminGuard` |
| `/tickets/reporting`, `/tickets/admin`, `/changelog` | Internal-only | Nested `PlatformAdminGuard` |
| `/revenue-analytics` | Legacy internal alias | Redirects to guarded `/analytics`; cannot bypass the destination guard |

Query strings, nested route segments, notification deep links, and authentication return URLs resolve through the same guarded route registrations. There is no customer route alias around the guard.

## Platform-admin routes

All routes below are wrapped by `ProtectedRoute`, `PlatformAdminGuard`, and `AdminLayout`:

- `/admin/dashboard` (index redirects to `tenants`)
- `/admin/dashboard/tenants`
- `/admin/dashboard/templates`
- `/admin/dashboard/analytics`
- `/admin/dashboard/cost-monitoring`
- `/admin/dashboard/activation`
- `/admin/dashboard/docs-feedback`
- `/admin/dashboard/support`
- `/admin/dashboard/integrations`
- `/admin/dashboard/connector-health`
- `/admin/dashboard/push-health`
- `/admin/dashboard/billing-health`
- `/admin/dashboard/retention`
- `/admin/dashboard/plan-emails`
- `/admin/analytics`
- `/admin/analytics/tenants/:tenantId`
- `/admin/analytics/tenants/:tenantId/calls`
- `/admin/analytics/tenants/:tenantId/campaigns/:campaignId`
- `/admin/analytics/tenants/:tenantId/connectors`
- `/admin/marketplace`
- `/admin/sales-inbox`
- `/admin/billing`
- `/admin/security`
- `/admin/governance`
- `/admin/evolution` (redirect to guarded governance tab)
- `/admin/conversion` (redirect to guarded governance tab)
- `/admin/intelligence` (redirect to guarded governance tab)
- `/admin/ingest-backfill`
- `/admin` (legacy redirect to guarded `/admin/dashboard`)

## Operations routes

All routes below are wrapped by `ProtectedRoute` and `OpsGuard`. `OpsGuard` now accepts only `isPlatformAdmin === true`, matching the QVO-staff policy:

- `/ops/monitor`
- `/ops/call-debug`
- `/ops/integration-diagnostics`
- `/ops/cost`
- `/ops/reliability`
- `/ops/backfill-calls`
- `/ops/digital-twin`
- `/ops/tool-logs` (redirect to guarded reliability)
- `/ops/observability` (redirect to guarded reliability)

## Exposure-point inventory

| Exposure point | Location | Final behavior |
| --- | --- | --- |
| Desktop/mobile/sidebar navigation | `TenantLayout.tsx` | Customer allowlist only; internal groups rendered only for staff |
| Public header/mobile/footer | `PublicLayout.tsx` | Focused public routes only |
| Command palette/quick actions | `CommandPalette.tsx` | Internal commands carry `internalOnly` and are filtered for customers |
| Dashboard cards/setup/onboarding | `Dashboard.tsx` | Agent Builder, templates, connector remediation, and management actions are staff-only |
| Phone routing-status remediation | `PhoneNumbers.tsx` | Customers see status; only staff receive connector deep links |
| Settings navigation | `Settings.tsx` | API-key tab filtered and direct tab access normalized for customers |
| Notification actions | `NotificationsCenter.tsx` | Metadata links to internal paths render as non-clickable for customers |
| Keyboard help | `KeyboardShortcuts.tsx` | Agent/analytics shortcuts shown only to staff |
| Dashboard tour | `TenantLayout.tsx`, `components/tours/dashboard.ts` | Customers receive only calls/help steps; generic build/campaign/analytics steps remain staff-only |
| Help widget/drawer | `HelpWidget.tsx`, `HelpDrawer.tsx` | Inline docs remain; no hidden `/docs` link; changelog is staff-only |
| Marketing search | `data/marketingPages.ts` | Pricing, demo, healthcare, and dental only |
| Public CTAs | Landing, demo, pricing, book-demo, case-study, calculator/widget components | Self-service signup CTAs replaced with demo/book-demo paths |
| Sitemap/static route manifest | `generate-sitemap.mjs`, `marketingRoutes.ts` | Hidden/deferred paths omitted; localized variants follow the same policy |
| Robots/canonical/metadata | Public route ownership and sitemap generation | No hidden route is registered or emitted; no `noindex` transition route is relied on |

## Authorization model

- The client decodes `isPlatformAdmin` from the authenticated JWT in `client-app/src/lib/auth.ts`.
- `PlatformAdminGuard` uses that explicit flag and redirects unauthorized users to `/dashboard`.
- `OpsGuard` uses the same `isQvoStaff` predicate and the established operations access-denied page.
- The server authentication middleware reloads `users.is_platform_admin` and exposes `req.user.isPlatformAdmin`; server platform endpoints use `requirePlatformAdmin` in `server/admin-api/middleware/rbac.ts`.
- This package intentionally changes frontend route availability only. Existing APIs, tenant-scoped server authorization, database objects, migrations, and schemas are unchanged, as required by the work-package compatibility boundary.

## Validation baseline

Captured before implementation on commit `748c7bb8871aba0de597ac89a03d96a468c85626`:

| Command | Baseline | Classification |
| --- | --- | --- |
| `npm run typecheck:client` | Pass | Green baseline |
| `npm --prefix client-app run build` | Pass | Green baseline |
| `npm run lint` | Fail: two `local/no-literal-analytics-label` findings in `platform/analytics/ConversionFunnelService.test.ts` | Pre-existing, outside modified area |
| `npm test` | Fail: 172 failed files/662 passed/10 skipped; 547 failed tests/9,199 passed/263 skipped; two errors | Pre-existing environment/repository state: root discovery includes `.claude/worktrees/vibrant-thompson-a4bbd3`, plus missing DB/Stripe/dependency/localStorage conditions |

Targeted Vitest commands exclude `.claude/**` because that pre-existing untracked worktree duplicates the repository test tree. UI tests set a concrete Node local-storage file because the environment injects `--localstorage-file` without a path.

## Deferred deletion candidates

The following are deliberately retained and must not be deleted in this package: generic public page components, Blog/Resources/Docs data, Agent Builder, marketplace, campaign, connector, analytics, developer, scheduling/SMS, dispatch, autopilot, digital-twin, governance/evolution/GIN components, their APIs, tests, migrations, and database structures. Deletion requires a separate dependency/telemetry review and explicit approval.

## Final validation

| Command | Final result |
| --- | --- |
| Focused route/navigation/sitemap suite (8 files) | Pass: 119/119 tests |
| `npm run typecheck:client` | Pass |
| `npm run check:i18n-keys` | Pass |
| `npm run check:sitemap-coverage` | Pass: 13 static public routes synchronized across both entrypoints |
| `SITEMAP_CASE_STUDIES_URL=none npm --prefix client-app run build` | Pass: application and public production bundles |
| Generated sitemap hidden-route audit | Pass: 65 localized static entries and no hidden/deferred URL |
| `npm run lint` | Same two pre-existing analytics-label errors as baseline; no modified-file lint errors |
| Authoritative `npm test -- --reporter=dot` | Blocked by the same baseline repository/environment conditions: duplicate `.claude` worktree discovery, missing DB/services, and invalid injected local-storage option |
| Full real-repository suite with `.claude/**` excluded and valid local storage | 414 files passed, 49 failed, 5 skipped; 5,573 tests passed, 100 failed, 134 skipped. Failures are pre-existing DB/service/configuration and unrelated contract failures; all modified-area tests pass |

Because the authoritative full suite is not green or stable in this workspace, Task 7's environment-dependent full-suite checkbox remains a reported validation blocker. The implementation, modified-area tests, typecheck, sitemap checks, i18n checks, and production build are complete.

## Work-package task status

| Task | Status | Evidence |
| --- | --- | --- |
| 0 — Verify repository | Complete | QVO entrypoints/surfaces verified; repository synchronized to `origin/main` before branching |
| 1 — Route and validation baseline | Complete | This inventory and baseline command table classify all App routes and exposure points |
| 2 — Target surface policy | Complete | Shared typed policy and role matrix implemented |
| 3 — Tenant navigation | Complete | Desktop/mobile layout, dashboard, settings, help, shortcuts, notifications, and command palette reduced |
| 4 — Direct-route access | Complete | Internal route tree and standalone internal routes use the existing platform-admin guard; focused guard tests pass |
| 5 — Public route exposure | Complete | Both entrypoints, bundle classifier, navigation, marketing search, and sitemap reduced; source retained |
| 6 — Secondary exposure | Complete | Reference audit documented above; remaining links are staff-gated or live inside retained internal/deferred source |
| 7 — Complete validation | Blocked (environment) | Modified-area checks/build pass; authoritative full suite remains non-green for recorded pre-existing environment/repository reasons |
| 8 — Engineering handoff | Complete | Route matrix, command evidence, changed-file manifest, deferred candidates, and manual checks are documented here |

Work Package 1 must not be marked fully complete until the Task 7 full-suite blocker is resolved or an owner formally accepts the recorded baseline failures.

## Changed-file manifest

| File | Purpose |
| --- | --- |
| `client-app/src/lib/surfacePolicy.ts` | Defines customer, internal, and public route policy plus staff/internal-path predicates |
| `client-app/src/App.tsx` | Reduces public routes and wraps retained internal tenant/standalone routes with staff guards |
| `client-app/src/PublicApp.tsx` | Keeps the split public bundle aligned with the focused route set |
| `client-app/src/components/TenantLayout.tsx` | Reduces desktop/mobile tenant navigation and filters staff-only groups, badges, and tour steps |
| `client-app/src/components/PublicLayout.tsx` | Reduces public header, mobile menu, footer, and self-service CTAs |
| `client-app/src/components/CommandPalette.tsx` | Filters internal navigation and creation commands for customers |
| `client-app/src/components/OpsGuard.tsx` | Restricts operations routes to the QVO-staff identity |
| `client-app/src/components/HelpDrawer.tsx` | Keeps help inline without linking to hidden public Docs routes |
| `client-app/src/components/HelpWidget.tsx` | Keeps inline help, focused marketing search, and staff-only changelog exposure |
| `client-app/src/components/KeyboardShortcuts.tsx` | Hides agent/analytics shortcut advertising from customers |
| `client-app/src/components/NotificationsCenter.tsx` | Removes customer click-through for notification metadata targeting internal routes |
| `client-app/src/components/ROICalculator.tsx` | Replaces self-service signup CTA with managed book-demo CTA |
| `client-app/src/components/WebsiteSalesWidget.tsx` | Replaces plan signup CTA with managed plan-discussion CTA |
| `client-app/src/pages/Dashboard.tsx` | Staff-gates builder/template/connector/agent-management exposure while retaining operational data |
| `client-app/src/pages/PhoneNumbers.tsx` | Shows connector status to customers without internal remediation links |
| `client-app/src/pages/Settings.tsx` | Makes API-key management and onboarding restart staff-only |
| `client-app/src/pages/Demo.tsx` | Converts signup CTA to book-demo |
| `client-app/src/pages/public/Landing.tsx` | Focuses verticals and conversion CTAs; removes marketplace promotion |
| `client-app/src/pages/public/Pricing.tsx` | Converts self-service plan selection to book-demo flow |
| `client-app/src/pages/public/BookDemo.tsx` | Replaces self-service prompt with live-demo exploration |
| `client-app/src/pages/public/CaseStudies.tsx` | Converts retained proof-page CTAs to managed book-demo flow |
| `client-app/src/pages/public/VerticalLanding.tsx` | Keeps healthcare/dental routes and managed conversion behavior |
| `client-app/src/pages/public/Resources.tsx` | Removes the hidden public Docs destination from retained source |
| `client-app/src/data/marketingPages.ts` | Limits search/discovery catalog to focused live pages |
| `shared/spa/marketingRoutes.ts` | Aligns server bundle selection with the active public route set |
| `scripts/generate-sitemap.mjs` | Emits only focused public routes and defers generic blog/resource slugs |
| `client-app/public/sitemap.xml` | Regenerated focused sitemap for five locales |
| `client-app/src/locales/en/common.json` | Adds focused phone-number and billing tenant-nav labels |
| `client-app/src/locales/es/common.json` | Adds Spanish focused tenant-nav labels |
| `client-app/src/locales/fr/common.json` | Adds French focused tenant-nav labels |
| `client-app/src/locales/de/common.json` | Adds German focused tenant-nav labels |
| `client-app/src/locales/pt-BR/common.json` | Adds Portuguese focused tenant-nav labels |
| `tests/routing/customerSurfacePolicy.test.ts` | Adds allowlist, role, nested-path, route-registration, guard, command, and sitemap contract tests |
| `tests/routing/marketingRoutes.test.ts` | Updates public bundle-classification tests for focused/deferred routes |
| `tests/routing/autopilotRouting.test.ts` | Updates source routing contract for staff-only Autopilot access |
| `tests/routing/autopilotRuntime.test.tsx` | Updates runtime nav assertions for the typed localized navigation model |
| `tests/routing/autopilotIntegration.test.tsx` | Proves tenant managers cannot see Autopilot and staff retain it |
| `tests/scripts/generateSitemap.test.ts` | Updates sitemap expectations and hidden-route regressions |
| `client-app/src/lib/translateMarketingPage.test.ts` | Proves hidden generic marketing pages no longer appear in search |
| `docs/launch/route-surface-inventory.md` | Records inventory, role matrix, baseline/final evidence, blockers, and handoff |

No lockfile, backend route, API, migration, database schema, or retained feature implementation was deleted or changed.

## Manual verification checklist

1. Sign in as an ordinary tenant member, manager, and owner; confirm the sidebar contains Dashboard, Calls, Tickets, Knowledge Base, Phone Numbers, Billing, and Settings only.
2. For each customer role, try `/agents`, `/agents/example/builder`, `/marketplace/installed`, `/developer`, `/autopilot?tab=actions`, `/ops/monitor`, and `/internal/design-directions`; confirm the established redirect/access-denied behavior and no loop.
3. Sign in as a platform admin; confirm the retained internal tenant groups, operations routes, Agent Builder, and admin console still open.
4. As a customer, open command search, notifications, help, keyboard shortcuts, dashboard cards, and phone-number status; confirm no internal route can be launched.
5. As an anonymous visitor, open the retained public routes and confirm `/features`, `/product/global-intelligence-network`, `/docs`, `/resources`, `/blog`, `/signup`, and non-healthcare verticals render the standard not-found page.
6. Inspect `/sitemap.xml`; confirm it contains the focused localized routes and none of the hidden URLs.
