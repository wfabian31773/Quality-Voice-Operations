# Tenant / Admin Component Split & Data Isolation Audit

_Last reviewed: Task #108_

This document records the audit of frontend components and backend API
endpoints for cross-tenant data exposure, and explains the tenant/admin
split implemented for Marketplace and Analytics.

## 1. Frontend split

| Route | Component | Scope |
|-------|-----------|-------|
| `/marketplace`, `/marketplace/installed`, `/marketplace/:id` | `pages/Marketplace.tsx` (Tenant) | Tenant-scoped: browse, install, manage installed templates for the current tenant. Calls only `/marketplace/*` endpoints which derive `tenant_id` from `req.user.tenantId`. |
| `/admin/marketplace` | `pages/AdminMarketplace.tsx` (Admin) | Platform-wide: global registry analytics, developer submission moderation, marketplace revenue. Calls only `/platform/*` endpoints guarded by `requirePlatformAdmin`. |
| `/analytics` | `pages/Analytics.tsx` (Tenant) | Tenant-scoped KPIs, call volume, costs, tool reliability, campaigns. Calls `/analytics/*` and `/tool-health/*` endpoints which scope by `req.user.tenantId`. |
| `/admin/analytics` | `pages/AdminAnalytics.tsx` (Admin) | Cross-tenant aggregates with explicit "Global / All Tenants" labelling, tenant-by-tenant breakdown, template performance, platform economics. Calls `/platform/*` endpoints guarded by `requirePlatformAdmin`. |

Both admin pages render `components/GlobalScopeBanner.tsx` so the
admin always knows they are looking at platform-wide data.

### Other shared components reviewed

A code search for components imported by both tenant and admin route
files showed no other tenant/admin reuse beyond Marketplace and
Analytics. Pages such as `Billing` (`/billing` and `/admin/billing`) and
`Compliance` (`/compliance` and `/admin/security`) are reused but they
already scope by `req.user.tenantId` on the server and do not surface
cross-tenant data.

## 2. Backend tenant scoping

### Defense-in-depth layers

1. **`requireAuth` middleware** (server/admin-api/middleware/auth.ts)
   - Verifies the JWT, resolves the user's role for the embedded
     `tenantId`, and writes `req.user = { userId, tenantId, email,
     role, isPlatformAdmin }`. Routes never read `tenantId` from the
     URL/query/body for scoping.
2. **`requireTenantContext`** (auto-invoked from `requireAuth`)
   - Blocks any request whose body or query carries a `tenantId` /
     `tenant_id` value that differs from `req.user.tenantId`
     (platform admins are exempted only on the query path).
3. **`withTenantContext`** sets `app.current_tenant_id` for the
   transaction so RLS policies enforce tenant isolation at the DB
   level even if a handler forgets `WHERE tenant_id = ...`.
4. Most SQL queries also include a redundant
   `WHERE tenant_id = req.user.tenantId` clause.
5. **`requirePlatformAdmin`** guards every `/platform/*` route that
   exposes cross-tenant data.

### Per-route findings (audit summary)

- All read endpoints under `agents`, `calls`, `campaigns`,
  `scheduling`, `tickets`, `dispatch`, `smsInbox`, `phoneNumbers`,
  `knowledgeBase`, `knowledgeDocuments`, `toolExecutions`,
  `analytics`, `billing`, `audit`, `quality`, `toolHealth`,
  `workflows`, `users` derive `tenantId` exclusively from
  `req.user.tenantId`. URL `:id` params are always paired with
  `WHERE tenant_id = req.user.tenantId` and/or executed inside
  `withTenantContext`.
- `ingest.ts` POST endpoints intentionally use
  `requireApiKeyOrJwt`; the API key is bound to a tenant on issuance.
- `billing.ts` Stripe webhook intentionally lacks `requireAuth` — it
  validates `stripe-signature`.
- All admin-only mutation endpoints (`/platform/templates/...`,
  `/platform/marketplace/submissions/...`,
  `/platform/marketplace/reviews/.../moderate`,
  `/platform/tenants/...`, `/platform/template-analytics`,
  `/platform/cost-monitoring`) are guarded by both
  `requireAuth` and `requirePlatformAdmin`.

### Marketplace

- Tenant endpoints (`/marketplace/...`) use
  `req.user.tenantId` and require `requireRole('manager')` for any
  install / mutation operation.
- Admin endpoints live under `/platform/...` and require
  `requirePlatformAdmin`. The new admin UI uses:
  - `GET /platform/template-analytics` (registry overview)
  - `GET /platform/templates/:id/versions` (version list — added
    in this task)
  - `POST /platform/templates/:id/versions/:versionId/publish`
    (publish a draft version)
  - `PATCH /platform/templates/:id/versions/:versionId/deprecate`
    (deprecate a published version)
  - `GET /platform/marketplace/submissions` (developer submissions;
    supports `?status=approved|rejected` for the audit tab)
  - `POST /platform/marketplace/submissions/:id/review` (moderation)
  - `GET /platform/marketplace/revenue` (marketplace revenue)

### Analytics

- Tenant endpoints (`/analytics/*`) accept only `req.user.tenantId`.
- The new admin UI uses:
  - `GET /platform/stats`
  - `GET /platform/tenants`
  - `GET /platform/cost-monitoring`
  - `GET /platform/template-analytics`

## 3. Tests

- `tests/security/tenantIsolation.test.ts` – verifies RLS is enabled
  on tenant tables, that cross-tenant reads/writes via raw SQL are
  blocked by RLS, and that `requireTenantContext` rejects a body
  carrying a foreign `tenantId`.
- `tests/security/adminEndpointGuard.test.ts` – verifies that
  `requirePlatformAdmin` blocks non-admin users with a 403 (and not a
  silent pass-through), and that the new `/platform/*` admin
  endpoints used by `AdminAnalytics` and `AdminMarketplace` are
  registered behind both `requireAuth` and `requirePlatformAdmin`.
- `tests/security/crossTenantEndpoints.test.ts` – end-to-end HTTP
  tests that boot the real express app, seed two tenants with one
  user and one of each resource (agent, call, phone number, ticket,
  booking, dispatch job, SMS conversation), sign a real JWT for
  tenant A, and assert:
  - tenant A's listing endpoints (`/agents`, `/calls`,
    `/phone-numbers`, `/tickets`, `/scheduling/bookings`,
    `/dispatch/jobs`, `/sms-inbox/threads`) never include tenant B's
    resource ids;
  - tenant A's detail endpoints
    (`/agents/:id`, `/calls/:id`, `/tickets/:id`,
    `/scheduling/bookings/:id`, `/dispatch/jobs/:id`,
    `/sms-inbox/threads/:id`) return 403/404 when handed a tenant B
    id;
  - `?tenantId=<other>` is rejected by `requireTenantContext`;
  - a `tenant_owner` from tenant A receives 403 from every
    `/platform/*` admin endpoint used by `AdminAnalytics` and
    `AdminMarketplace`.

### Tools registry (Task #122)

- `GET /tools/registry` is now tenant-scoped: it returns only tools
  that are enabled for at least one of the tenant's agents (using the
  same template-permission + `agent_tools` override logic as
  `GET /agents/:id/tools`). It is gated by `requireAuth` and scoped
  via `req.user.tenantId`.
- `GET /platform/tools/registry` returns the full platform-wide
  `unifiedToolRegistry` snapshot and is gated by both `requireAuth`
  and `requirePlatformAdmin`.

## 4. Open follow-ups (out of scope for #108)

- Frontend route `/admin/security` reuses tenant `Compliance` page;
  acceptable today (it already scopes by `req.user.tenantId`) but
  future security overview features for the admin console should
  use a dedicated admin component and `/platform/security/*`
  endpoints.
