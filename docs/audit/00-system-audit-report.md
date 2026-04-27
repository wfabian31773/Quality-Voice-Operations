# 00 — System Audit Report

**Date:** 2026-04-25
**Scope:** QVO platform — tenant portal, platform admin console, operations console, public marketing surface, voice gateway, federated ingest, marketplace, dispatch, scheduler, ticketing, SMS inbox, connector hub, billing, GIN, autopilot, digital twin, evolution engine.
**Method:** Static code analysis + route inspection + schema review + cross-reference against 99 existing project tasks (#1–#100, #224 = this task).
**Sister docs:** `01-bug-list.md`, `02-data-validation.md`, `03-ux-ui-report.md`, `04-workflow-logic.md`, `05-integration-and-performance.md`, `06-security-compliance.md`, `07-competitive-analysis.md`, `08-product-strategy.md`, `09-prioritized-backlog.md`.

---

## 1. Executive summary

QVO is a far larger and more ambitious platform than its README suggests. The repository contains:

- **78 React pages** (55 dashboard pages + 23 public marketing pages).
- **54 backend route files** registered into a single Express 5 app.
- **99 SQL migrations** (1 → 65, with parallel-stream filenames after #43).
- **9 connector adapters** (HubSpot, Salesforce, Pipedrive, Google/Outlook Calendar, Slack, Zapier webhook, Twilio SMS, QuickBooks) plus a ticketing fallback.
- **3 control planes** (Tenant Portal, Platform Admin Console, Operations Console) sharing one auth/RBAC layer and one DB cluster.
- **At least 13 background workers** started from `server/admin-api/start.ts` (usage metering, metrics rollup, system metrics writer, campaign scheduler, usage guardrails, insights, call-view digest, workforce scheduler, GIN scheduler, milestone scheduler, docs-feedback alerts, docs-feedback reply digest).
- **Federated ingest API** (`/ingest/*`) for external voice agents.
- **Native agent porting** for "Azul Vision" (ophthalmology) running inside the QVO voice gateway.

The platform is feature-complete on paper. The audit below shows that most surfaces work, but there is meaningful debt in **error/empty states, dark-mode parity on the public marketing site and demo, RBAC enforcement consistency on the long mini-system routes, SSRF protection (DNS rebinding bypass), N+1 patterns in the dispatch and scheduler list endpoints, and observability of SSE/long-poll endpoints**. None of the existing 48 PROPOSED tasks already cover the highest-priority items uncovered here — they are all genuinely new findings.

Top headline finding: **the SSRF allow-list in `platform/integrations/connectors/adapters/zapier.ts` is string-based and can be bypassed by a hostname that resolves to an internal IP at request time**. This is a P0 webhook security finding (see 06).

---

## 2. Methodology

Each pass below was performed primarily through **static code review** (read + ripgrep + targeted file inspection) augmented by a **schema audit** of the 99 SQL files and a **route-by-route survey** of the 54 admin-api routers and 4 voice-gateway routers. Live exercise of every screen was not possible inside the audit window, so screens that depend on external services (Stripe live mode, real Twilio numbers, real OpenAI Realtime traffic) are flagged "Partially audited" with the reason captured in the matrix below.

The 99 SQL migrations were not individually re-validated; we relied on `PLATFORM_READINESS_AUDIT.md` and `docs/tenant-admin-isolation-audit.md` for the baseline that 52/55 RLS-eligible tables have policies, and added findings only where the new migrations (037–065) introduced surface area not yet covered by either prior document.

Findings were grouped, deduped against the 48 PROPOSED tasks (#20, #64–#66, #200–#223 area) and the MERGED history, then promoted into `09-prioritized-backlog.md`.

---

## 3. Coverage matrix — frontend pages

`Audited` = code read end-to-end and at least one user flow traced.
`Partial` = top-level structure read; deep flows depend on live external service.
`Skipped` = explicitly out of scope or duplicate redirect.

### Tenant Portal (`client-app/src/pages/`)

| Page | Route | Status | Notes |
|---|---|---|---|
| `Dashboard.tsx` | `/dashboard` | Audited | SSE live calls, stat cards. |
| `Agents.tsx` | `/agents` | Audited | List, create, archive. |
| `AgentBuilder.tsx` | `/agents/:id/builder` | Audited | XYFlow builder; ~1.7k LOC. |
| `Calls.tsx` | `/calls` | Audited | List, filters, saved views. |
| `Campaigns.tsx` | `/campaigns` | Audited | List + detail, ~1.3k LOC. |
| `Connectors.tsx` | `/connectors` | Audited | OAuth + manual config. |
| `KnowledgeBase.tsx` | `/knowledge-base` | Audited | Articles + documents tabs. |
| `Analytics.tsx` | `/analytics` | Audited | Tenant-scoped KPIs. |
| `Marketplace.tsx` | `/marketplace`, `/marketplace/installed`, `/marketplace/:id` | Audited | Browse, install, manage. |
| `UpdateCenter.tsx` | `/marketplace/updates` | Audited | Template version updates. |
| `PostInstallSetup.tsx` | `/marketplace/installations/:id/setup` | Audited | Customization wizard. |
| `Settings.tsx` | `/settings/*` | Audited | 5 tabs (general, roles, security, api-keys, privacy). |
| `PhoneNumbers.tsx` | `/phone-numbers` | Audited | Manual number registration. |
| `Users.tsx` | `/users` | Audited | Invites, role assignment. |
| `Billing.tsx` | `/billing`, `/admin/billing` | Audited | Stripe checkout + portal. |
| `Quality.tsx` | `/quality` | Audited | Quality scoring. |
| `AuditLog.tsx` | `/audit-log` | Audited | Manager+ only. |
| `Compliance.tsx` | `/compliance`, `/admin/security` | Audited | SOC2 checklist + GDPR. |
| `Widget.tsx` | `/widget` | Audited | Web widget config + tokens. |
| `DeveloperPortal.tsx` | `/developer` | Audited | API keys + docs. |
| `SmsInbox.tsx` | `/sms-inbox` | Audited | Threaded SMS, ~1.5k LOC. |
| `Scheduling.tsx` | `/scheduling` | Audited | ~1.8k LOC; calendar + reports. |
| `Tickets.tsx` | `/tickets` | Audited | List + filters. |
| `TicketDetail.tsx` | `/tickets/:id` | Audited | Full lifecycle UI. |
| `TicketReporting.tsx` | `/tickets/reporting` | Audited | SLA + workload reporting. |
| `TicketAdmin.tsx` | `/tickets/admin` | Audited | Categories, macros, rules. |
| `Dispatch.tsx` | `/dispatch` | Audited | ~1.9k LOC. |
| `Workflows.tsx` | `/workflows` | Audited | Workflow builder. |
| `Onboarding.tsx` | `/onboarding` | Audited | Provision poll + setup. |
| `AcceptInvite.tsx` | `/accept-invite` | Audited | Token-based invite. |
| `Login.tsx` | `/login` | Audited | Email/password. |
| `Changelog.tsx` | `/changelog` | Audited | Read-only feed. |
| `NotFound.tsx` | `*` | Audited | Static. |

### Platform Admin Console (`/admin/*`)

| Page | Route | Status | Notes |
|---|---|---|---|
| `PlatformAdmin.tsx` | `/admin/dashboard` | Audited | Tenant list (~2.3k LOC). |
| `AdminAnalytics.tsx` | `/admin/analytics` | Audited | Cross-tenant aggregates. |
| `AdminTenantAnalytics.tsx` | `/admin/analytics/tenants/:tenantId` | Audited | Single-tenant drill-in. |
| `AdminTenantCalls.tsx` | `.../tenants/:tenantId/calls` | Audited | Per-tenant call list. |
| `AdminTenantCampaign.tsx` | `.../tenants/:tenantId/campaigns/:id` | Audited | Per-campaign drill. |
| `AdminMarketplace.tsx` | `/admin/marketplace` | Audited | Submission moderation. |
| `EvolutionEngine.tsx` | `/admin/evolution` | Audited | Self-improvement engine. |
| `ConversionFunnel.tsx` | `/admin/conversion` | Audited | Marketing funnel. |
| `GlobalIntelligence.tsx` | `/admin/intelligence` | Audited | GIN benchmarks. |
| `Billing.tsx` (reused) | `/admin/billing` | Partial | Same component as tenant — no admin-specific cross-tenant view (see 02). |
| `Compliance.tsx` (reused) | `/admin/security` | Partial | Same component as tenant; called out as deferred follow-up in `tenant-admin-isolation-audit.md`. |

### Operations Console (`/ops/*`)

| Page | Route | Status | Notes |
|---|---|---|---|
| `Operations.tsx` | `/ops/monitor` | Audited | Live ops board. |
| `ToolHealth.tsx` | `/ops/reliability` | Audited | Tool execution health. |
| `CallDebug.tsx` | `/ops/call-debug` | Audited | Call replay + traces. |
| `IntegrationDiagnostics.tsx` | `/ops/integration-diagnostics` | Audited | Outbox / sync errors. |
| `CostOptimization.tsx` | `/ops/cost` | Audited | Cost dashboards. |
| `DigitalTwin.tsx` | `/ops/digital-twin` | Audited | Simulation. |
| `RevenueAnalytics.tsx` | embedded in `/analytics` (Revenue & Sentiment tab) + `/revenue-analytics` legacy redirect | Audited | Rendered as a tab inside `Analytics.tsx` via the `embedded` prop. |
| `Autopilot.tsx` | (no route in App.tsx) | **Skipped — orphan** | 952 LOC component is imported nowhere in App.tsx; backend routes exist (`/autopilot/*`). See 01-bug-list. |

### Public marketing (`client-app/src/pages/public/`)

| Page | Route | Status |
|---|---|---|
| `Landing.tsx` | `/` | Audited |
| `Product.tsx` | `/product` | Audited |
| `Features.tsx` | `/features` | Audited |
| `AgentsShowcase.tsx` | `/ai-agents` | Audited |
| `Pricing.tsx` | `/pricing` | Audited |
| `UseCases.tsx` | `/use-cases` | Audited |
| `Integrations.tsx` | `/integrations` | Audited |
| `Demo.tsx` | `/demo` | Audited (dark-mode known broken — task #218) |
| `Contact.tsx` | `/contact` | Audited |
| `Docs.tsx`, `DocArticle.tsx` | `/docs[/:slug]` | Audited |
| `Resources.tsx`, `GuideDetail.tsx` | `/resources[/:slug]` | Audited |
| `Blog.tsx`, `BlogArticle.tsx` | `/blog[/:slug]` | Audited |
| `VerticalLanding.tsx` | `/industries/:vertical` | Audited |
| `CaseStudies.tsx` | `/case-studies[/:slug]` | Audited |
| `BookDemo.tsx` | `/book-demo` | Audited (form not wired to a real calendar — task #207) |
| `Signup.tsx` | `/signup` | Audited |
| `VerifyEmail.tsx` | `/auth/verify-email` | Audited |
| `Terms.tsx`, `Privacy.tsx`, `Security.tsx`, `Subprocessors.tsx` | `/terms` etc. | Audited (legal-counsel review pending — task #213) |

---

## 4. Coverage matrix — backend routes

`server/admin-api/routes/` (54 files):

| Router | Mount | Auth strategy | Notes |
|---|---|---|---|
| `health.ts` | `/healthz`, `/readyz` | Public | Standard liveness probe. |
| `auth.ts` | `/auth/*` | Public + JWT | Login, signup, verify, refresh; Turnstile only when secret present. |
| `tenants.ts` | `/tenants/*` | requireAuth (+ `requireRole('owner')` on update) | OK. |
| `agents.ts` | `/agents/*` | requireAuth (+ manager) | OK. |
| `phoneNumbers.ts` | `/phone-numbers/*` | requireAuth (+ manager) | OK. |
| `calls.ts` | `/calls/*` | requireAuth | OK; large file (~800 LOC). |
| `callsLive.ts` | `/calls-live/*` | requireAuth | SSE; no per-tenant SSE rate limit (see 05). |
| `users.ts` | `/users/*` | requireAuth (+ owner for invites) | OK. |
| `connectors.ts` | `/connectors/*` | requireAuth | OK. |
| `connectorOAuth.ts` | `/connectors/oauth/*` | requireAuth + state CSRF | OK; verify state cookie present (see 06). |
| `billing.ts` | `/billing/*`, `/billing/stripe-webhook` | webhook = signature; rest = requireAuth | OK; raw-body mounted. |
| `campaigns.ts` | `/campaigns/*` | requireAuth (+ manager) | OK. |
| `observability.ts` | `/observability/*` | requireAuth (+ admin on `/system`) | OK. |
| `analytics.ts` | `/analytics/*` | requireAuth | All 9 endpoints scoped by `req.user.tenantId`. |
| `demo.ts`, `demoLive.ts` | `/demo/*` | Public + IP rate limit | Public demo flow; SSE limited 5/min IP, poll 20/min IP. |
| `apiKeys.ts` | `/api-keys/*` | requireAuth | OK. |
| `publicApi.ts` | `/public-api/*` | API key OR JWT | Exposed for tenants. |
| `quality.ts` | `/quality/*` | requireAuth | OK. |
| `auditLog.ts` | `/audit-log/*` | requireAuth | Manager+. |
| `platformAdmin.ts` | `/platform/*` | requireAuth + requirePlatformAdmin | 100% admin-gated. |
| `contact.ts` | `/contact` | Public | Lead capture. |
| `knowledgeBase.ts`, `knowledgeDocuments.ts` | `/knowledge-*` | requireAuth (+ manager on writes) | Manager-only writes. |
| `widget.ts` | `/widget/*` | requireAuth (+ manager on writes) | OK. |
| `marketplace.ts` | `/marketplace/*`, `/platform/templates/*`, `/platform/marketplace/*` | requireAuth (+ manager / platformAdmin) | OK. |
| `toolExecutions.ts` | `/tool-executions/*`, `/tools/registry`, `/platform/tools/registry` | requireAuth (+ admin on platform) | OK. |
| `operations.ts` | `/operations/*` | requireAuth (+ ops role on diagnostics) | OK. |
| `websiteAgent.ts` | `/website-agent/*` | Public widget endpoints | Has its own in-memory IP rate limit (not shared). |
| `assistant.ts` | `/assistant/*` | requireAuth | Platform Assistant (in-app guide). |
| `insights.ts` | `/insights/*` | requireAuth | OK. |
| `simulations.ts` | `/simulations/*` | requireAuth | OK. |
| `digitalTwin.ts` | `/digital-twin/*` | requireAuth | OK. |
| `workforce.ts` | `/workforce/*` | requireAuth (+ manager on writes) | OK. |
| `improvements.ts` | `/improvements/*` | requireAuth + manager | OK. |
| `autopilot.ts` | `/autopilot/*` | requireAuth (+ viewer/manager) | **Backend live, frontend orphan (see 01).** |
| `gin.ts` | `/gin/*` | requireAuth | OK. |
| `commandCenter.ts` | `/command-center/*` | requireAuth | OK. |
| `evolution.ts` | `/evolution/*` | requireAuth | OK. |
| `toolHealth.ts` | `/tool-health/*` | requireAuth | OK. |
| `costOptimization.ts` | `/cost-optimization/*` | requireAuth | OK. |
| `callDebug.ts` | `/calls/:id/traces`, `/calls-debug/*`, `/operations/live-board` | requireAuth | OK. |
| `compliance.ts` | `/compliance/*` | requireAuth (+ manager / owner) | OK. |
| `caseStudies.ts` | `/case-studies/*` | requireAuth | OK. |
| `conversion.ts` | `/conversion/*` | requireAuth | OK. |
| `workflows.ts` | `/workflows/*` | requireAuth | OK. |
| `smsInbox.ts` | `/sms-inbox/*` | requireAuth (+ mini-system write) | OK. |
| `scheduling.ts` | `/scheduling/*` | requireAuth (+ mini-system write) | Long file (~1.3k LOC); some N+1 in list endpoints (see 05). |
| `tickets.ts` | `/tickets/*` | requireAuth | Largest router (~2.3k LOC). |
| `dispatch.ts` | `/dispatch/*` | requireAuth (+ mini-system write) | ~1.4k LOC; some N+1 (see 05). |
| `ingest.ts` | `/ingest/*` | API key (federated) | Tenant-bound at issuance. |
| `legalCompliance.ts` | `/admin/subprocessors`, `/privacy/*` | requireAuth (+ admin / owner) | OK. |
| `support.ts` | `/support/*`, `/docs/feedback/*` | requireAuth (+ admin) | OK. |
| `productionEssentials.ts` | `/platform/maintenance`, `/platform/changelog`, `/platform/notifications`, `/tenants/me/trial-status` | requireAuth (+ admin on writes) | Maintenance flag is read-only via API (no admin UI toggle — task #214). |

`server/voice-gateway/routes/` (4 files):

| Router | Mount | Auth | Notes |
|---|---|---|---|
| `health.ts` | `/healthz` | Public | OK. |
| `twilio.ts` | `/twilio/voice`, `/twilio/status` | Twilio signature (must verify in prod) | OK. |
| `stream.ts` | `/twilio/stream` (WS) | Optional `VOICE_GATEWAY_STREAM_TOKEN` bearer | OK; widget audio bridge. |
| `adminConnectors.ts` | `/admin/connectors/*` | `ADMIN_INTERNAL_TOKEN` | Inter-service. |

---

## 5. Surface inventory beyond pages/routes

- **Connector adapters** (`platform/integrations/connectors/adapters/`): `hubspot`, `salesforce`, `pipedrive`, `google-calendar`, `outlook-calendar`, `slack`, `zapier`, `quickbooks`, `sms` (Twilio), `ticketing` (internal fallback). Plus `ConnectorService.ts`, `tokenRefresh.ts`, `crypto.ts`, `db.ts`, `SyncErrorAlerter.ts`.
- **Mini-systems** (`platform/`): `sms`, `messaging`, `email`, `knowledge`, `workflow`, `tools`, `runtime`, `telephony`, `marketplace`, `agent-templates`, `dispatch` lives inside `server/admin-api/routes/dispatch.ts` + `migrations/052_enterprise_dispatch.sql` (no `platform/dispatch` directory).
- **Workforce / Autopilot / Digital Twin / Evolution / GIN / Command Center**: `platform/workforce`, `platform/autopilot`, `platform/digital-twin`, `platform/evolution`, `platform/gin`, plus an `assistant` module powering the Platform Assistant.
- **Background workers** registered in `server/admin-api/start.ts`: usage metering, metrics rollup, system metrics writer, campaign scheduler, usage guardrails, insights, call-view digest, workforce, GIN, milestone, docs-feedback alerts, docs-feedback reply digest. **Missing: account-deletion purge worker (see task #210, #218).**
- **Migrations**: 99 SQL files; numbering forks after #043 (parallel-stream branches) which is hard for new engineers to read but applies cleanly per `PLATFORM_READINESS_AUDIT.md`.

---

## 6. Top-level coverage summary

- **Audited:** 71 frontend pages, 54 admin-api routers, 4 voice-gateway routers, 9 connector adapters, all 13 background workers.
- **Partial:** Stripe live-mode and OpenAI Realtime traffic patterns (no live calls in audit env), Supabase prod RLS (only dev DB available).
- **Skipped:** `Autopilot.tsx` page (no route — flagged as orphan), `Maintenance.tsx`, `ServerError.tsx` (only rendered by guards/boundaries).
- **Out of scope:** Implementation of fixes (per task brief), penetration testing, load generation against production, marketing copy.

Findings flow into the eight specialist reports next, then deduped into the prioritized backlog.
