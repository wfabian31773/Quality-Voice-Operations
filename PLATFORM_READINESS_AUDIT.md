# Quality Voice Operations -- Platform Readiness Audit

**Date:** March 15, 2026
**Auditor:** Automated System Audit
**Codebase:** Voice AI Operations Hub (multi-tenant SaaS)
**Tech Stack:** TypeScript, React 19/Vite, Express 5, PostgreSQL + RLS, OpenAI Realtime API, Twilio, Stripe

---

## 1. Platform Architecture Status

### Subsystem Status Table

| # | Subsystem | Status | Key Files |
|---|-----------|--------|-----------|
| 1 | **Multi-Tenant Architecture** | COMPLETE | `platform/db/index.ts`, `migrations/011_rls.sql`, `migrations/013_rls_extended.sql`, `migrations/017_rls_with_check.sql` |
| 2 | **Authentication & Identity** | COMPLETE | `server/admin-api/middleware/auth.ts`, `server/admin-api/routes/auth.ts`, `server/admin-api/middleware/apiKeyAuth.ts` |
| 3 | **RBAC** | COMPLETE | `server/admin-api/middleware/rbac.ts`, `platform/rbac/types.ts`, `platform/rbac/ApiKeyService.ts` |
| 4 | **Voice Gateway** | COMPLETE | `server/voice-gateway/routes/twilio.ts`, `server/voice-gateway/routes/stream.ts`, `server/voice-gateway/services/openaiSession.ts` |
| 5 | **Call Lifecycle Coordination** | COMPLETE | `platform/runtime/lifecycle/CallLifecycleCoordinator.ts`, `server/voice-gateway/services/sessionManager.ts`, `server/voice-gateway/services/callPersistence.ts` |
| 6 | **Agent Templates** | COMPLETE | `platform/agent-templates/answering-service/`, `platform/agent-templates/dental/`, `platform/agent-templates/medical-after-hours/`, `platform/agent-templates/legal/`, `platform/agent-templates/property-management/`, `platform/agent-templates/home-services/` |
| 7 | **Campaign Management & Dialer** | COMPLETE | `platform/campaigns/CampaignService.ts`, `platform/campaigns/CampaignScheduler.ts`, `platform/campaigns/OutboundDialer.ts`, `platform/campaigns/DncService.ts`, `platform/campaigns/OutcomeClassifier.ts` |
| 8 | **Phone Number Provisioning** | PARTIALLY IMPLEMENTED | `server/admin-api/routes/phoneNumbers.ts`, `platform/telephony/twilio/`. Manual number registration implemented; automated Twilio number purchasing is NOT implemented. |
| 9 | **Connector Framework** | COMPLETE | `platform/integrations/connectors/ConnectorService.ts`, `platform/integrations/connectors/adapters/`, `platform/integrations/outbox/OutboxService.ts` |
| 10 | **Messaging (SMS/Email)** | COMPLETE | `platform/email/EmailService.ts`, `platform/email/templates.ts`, `platform/integrations/connectors/adapters/sms.ts` (Twilio SMS via connector) |
| 11 | **Workflow Engine** | COMPLETE | `platform/workflow/engine/WorkflowEngine.ts`, `platform/workflow/definitions/slotDefinitions.ts`, `platform/workflow/definitions/intentKeywords.ts` |
| 12 | **Billing & Stripe Integration** | COMPLETE | `platform/billing/stripe/client.ts`, `platform/billing/stripe/webhook.ts`, `platform/billing/stripe/checkout.ts`, `platform/billing/stripe/plans.ts`, `platform/billing/stripe/usage.ts` |
| 13 | **Usage Metering Pipeline** | COMPLETE | `platform/billing/usage/UsageRecorder.ts`, `platform/billing/stripe/usage.ts` (background worker), `platform/billing/budget/checkBudget.ts` |
| 14 | **Analytics & Metrics** | COMPLETE | `platform/analytics/AnalyticsService.ts`, `platform/core/observability/metricsRollup.ts`, `platform/core/observability/systemMetrics.ts`, `server/admin-api/routes/analytics.ts` |
| 15 | **Audit Logging** | COMPLETE | `platform/audit/AuditService.ts`, `server/admin-api/routes/auditLog.ts` |
| 16 | **Admin Console** | COMPLETE | `client-app/src/` (14 pages: Dashboard, Agents, Calls, Analytics, Users, Connectors, PhoneNumbers, Quality, Observability, AuditLog, ApiKeys, PlatformAdmin) |
| 17 | **Tenant Dashboard** | COMPLETE | `client-app/src/pages/Dashboard.tsx` (SSE live calls, stat cards, recent call list) |
| 18 | **Demo System** | COMPLETE | `client-app/src/pages/Demo.tsx`, `server/admin-api/routes/demo.ts`, `platform/demo/` |
| 19 | **Onboarding Wizard** | COMPLETE | `client-app/src/pages/Onboarding.tsx` (multi-step: provisioning poll, template selection, phone setup) |

### Architecture Diagram

```
                        +---------------------------+
                        |      Client App (React)   |
                        |    :5000 (Vite Dev Server) |
                        +---------------------------+
                               |           |
                    /api proxy |           | /twilio proxy
                               v           v
              +----------------+   +------------------+
              |   Admin API    |   |  Voice Gateway   |
              | :3002 (Express)|   | :3001 (Express)  |
              +----------------+   +------------------+
              | Auth/RBAC      |   | Twilio Webhooks  |
              | Tenant Mgmt   |   | WebSocket Stream |
              | Agent CRUD     |   | OpenAI Realtime  |
              | Billing/Stripe |   | Call Lifecycle   |
              | Campaigns      |   | Session Manager  |
              | Analytics      |   | Workflow Engine  |
              | SSE Live Calls |   | Outbox Worker    |
              +-------+--------+   +--------+---------+
                      |                      |
                      v                      v
              +--------------------------------------+
              |       PostgreSQL + RLS               |
              | Shared Schema, Tenant Isolation      |
              | 55 tables, 28 migrations applied     |
              +--------------------------------------+
                      |                      |
              +-------+--------+   +---------+---------+
              |  Stripe API    |   |  Twilio API       |
              | Billing/Subs   |   | Voice/SMS/Numbers |
              +----------------+   +-------------------+
                                           |
                                   +-------+---------+
                                   | OpenAI Realtime |
                                   | GPT-4o Audio    |
                                   +-----------------+
```

---

## 2. Runtime Infrastructure

| Component | Status | Config Source | Required Env Vars | Currently Active |
|-----------|--------|-------------|-------------------|-----------------|
| **PostgreSQL (Dev)** | OPERATIONAL | `DATABASE_URL` | `DATABASE_URL` | YES - 28 migrations applied |
| **PostgreSQL (Prod)** | CONFIGURED | `PLATFORM_DB_POOL_URL` | `PLATFORM_DB_POOL_URL` | NO (dev mode) |
| **RLS Policies** | ENFORCED | `migrations/011,013,017` | n/a | YES - 52/55 tables covered |
| **Background Workers** | | | | |
| - Metrics Rollup | RUNNING | `platform/core/observability/metricsRollup.ts` | none | YES (1hr interval) |
| - System Metrics | RUNNING | `platform/core/observability/systemMetrics.ts` | none | YES (60s interval) |
| - Usage Metering | RUNNING | `platform/billing/stripe/usage.ts` | `STRIPE_SECRET_KEY`, `STRIPE_METER_EVENT_*` | YES (but reports fail: no Stripe key) |
| - Campaign Scheduler | RUNNING | `platform/campaigns/CampaignScheduler.ts` | none | YES (15s poll) |
| **Webhook Endpoints** | | | | |
| - Twilio Voice | REGISTERED | `server/voice-gateway/routes/twilio.ts` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | YES |
| - Twilio Status | REGISTERED | `/twilio/status` | same | YES |
| - Stripe Billing | REGISTERED | `server/admin-api/routes/billing.ts` | `STRIPE_WEBHOOK_SECRET` | YES (verification fails: no secret) |
| **Twilio Voice** | CONFIGURED | `server/voice-gateway/services/twilioAdapter.ts` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_OUTBOUND_NUMBER` | YES |
| **OpenAI Realtime** | CONFIGURED | `server/voice-gateway/services/openaiSession.ts` | `OPENAI_API_KEY` | YES |
| **Connector Adapters** | AVAILABLE | `platform/integrations/connectors/adapters/` | Per-connector credentials | PARTIAL (ticketing + SMS adapters) |
| **Outbox Worker** | AVAILABLE | `platform/integrations/outbox/OutboxService.ts` | none | YES (triggered on demand) |

---

## 3. Billing & Usage Instrumentation

### Usage Event Sources

| Event Type | Source | Records To | Status |
|-----------|--------|-----------|--------|
| **Inbound Call Minutes** | `server/voice-gateway/routes/stream.ts` (on WS close) | `usage_metrics` | COMPLETE |
| **Outbound Call Minutes** | Same path via campaign dialer | `usage_metrics` | COMPLETE |
| **AI Runtime Minutes** | `server/voice-gateway/routes/stream.ts` (duration calc) | `usage_metrics` | COMPLETE |
| **SMS Usage** | `platform/integrations/connectors/adapters/sms.ts` | `usage_metrics` | COMPLETE |
| **Stripe Metering Sync** | `platform/billing/stripe/usage.ts` (1hr worker) | Stripe Billing Meter API | COMPLETE (code present; requires STRIPE_SECRET_KEY) |

### Current State of `usage_metrics` Table

**EMPTY** (0 rows). No live calls have been processed in this dev environment, so no usage data has been recorded. The table schema and write paths are fully implemented; it awaits actual call traffic.

### Stripe Metering Report Flow

```
Call completes -> UsageRecorder.record() -> usage_metrics table
                                                  |
                              [1hr background worker]
                                                  v
                              stripe.billing.meterEvents.create()
                                                  |
                              Reports: calls, ai_minutes, sms
```

### Sample System Metrics Record (available)

```
Metric: uptime_seconds = 181
Metric: memory_heap_used_mb = 20 (heapTotal: 21)
Metric: memory_rss_mb = 90
Recorded: 2026-03-15T20:19:22Z
```

---

## 4. Voice System Validation

### Call Flow Analysis

#### Inbound Call Flow
1. Twilio sends POST to `/twilio/voice`
2. Gateway looks up agent via phone number routing (`number_routing` table)
3. Budget check via `checkBudget()` -- rejects if limits exceeded
4. Returns TwiML `<Connect><Stream url="/twilio/stream">` 
5. Twilio opens WebSocket to `/twilio/stream`
6. Gateway creates `CallSession` record in DB (state: `CALL_RECEIVED`)
7. Opens OpenAI Realtime WebSocket (model: `gpt-4o-realtime-preview`)
8. Configures audio format: `g711_ulaw` (native Twilio, no transcoding)
9. Bidirectional audio streaming: Twilio <-> Gateway <-> OpenAI
10. Call lifecycle transitions: `CALL_RECEIVED` -> `AGENT_CONNECTED` -> `ACTIVE_CONVERSATION` -> `CALL_COMPLETED`

#### Outbound Call Flow (Campaigns)
1. `CampaignScheduler.tick()` finds pending contacts
2. `OutboundDialer.placeCall()` initiates Twilio call
3. AMD (Answering Machine Detection) enabled
4. Human detected -> POST to `/twilio/outbound` -> TwiML `<Stream>`
5. Same WebSocket/OpenAI session flow as inbound
6. Outcome classified via `OutcomeClassifier`

#### Transcript Capture: IMPLEMENTED
- OpenAI `history_added` events -> `lifecycleCoordinator.appendTranscript()`
- Lines prefixed with `CALLER:` / `AGENT:`
- Persisted to `call_transcripts` table

#### Call Event Logging: IMPLEMENTED
- Events recorded to `call_events` table (call_received, agent_connected, tool_start, call_completed)

#### Call Termination: IMPLEMENTED
- `CallLifecycleCoordinator` waits for both Twilio "completed" status callback AND WebSocket "stop" event
- Stale call detection: force-closes calls idle > 120 seconds

#### Retry / Fault Tolerance: IMPLEMENTED
- Circuit breaker pattern available (`platform/core/resilience/circuitBreaker.ts`)
- Campaign retry logic: failed/no_answer contacts retried after configurable delay
- Outbox pattern provides at-least-once delivery for integration calls

### Call Lifecycle Sequence Diagram

```
    Twilio             Voice Gateway           OpenAI Realtime        Database
      |                     |                       |                    |
      |--POST /voice------->|                       |                    |
      |                     |--lookup agent-------->|                    |
      |                     |                       |     INSERT call_sessions
      |<---TwiML <Stream>---|                       |     (CALL_RECEIVED)
      |                     |                       |                    |
      |==WebSocket open====>|                       |                    |
      |                     |--WS connect---------->|                    |
      |                     |                       |     UPDATE state
      |                     |                       |     (AGENT_CONNECTED)
      |                     |                       |                    |
      |--audio (g711 ulaw)->|--audio (g711 ulaw)--->|                    |
      |<-audio (g711 ulaw)--|<-audio (g711 ulaw)----|                    |
      |                     |                       |                    |
      |                     |<--transcript----------|     append transcript
      |                     |<--tool_call-----------|     INSERT call_events
      |                     |---tool_result-------->|                    |
      |                     |                       |                    |
      |--disconnect-------->|                       |                    |
      |                     |--close WS------------>|                    |
      |--status callback--->|                       |     UPDATE state
      |                     |                       |     (CALL_COMPLETED)
      |                     |--record usage-------->|     INSERT usage_metrics
```

---

## 5. Campaign Engine Validation

| Feature | Status | Implementation |
|---------|--------|---------------|
| **Campaign Creation** | COMPLETE | `CampaignService.ts`, REST API `POST /campaigns` |
| **CSV Contact Import** | COMPLETE | `campaigns.ts` route handler with custom CSV parser, E.164 validation |
| **Dialing Queue** | COMPLETE | Polling scheduler (15s), `FOR UPDATE SKIP LOCKED` for safe concurrency |
| **Concurrent Call Limits** | COMPLETE | Tenant-level (default 10) + campaign-level (default 2) limits |
| **Retry Scheduling** | COMPLETE | Failed/no_answer contacts retried after `retryDelayMinutes` (default 30) |
| **Outcome Classification** | COMPLETE | `OutcomeClassifier.ts` -- uses AMD results + call duration heuristics |
| **DNC Enforcement** | COMPLETE | Pre-dial check, transcript opt-out detection, SMS STOP/UNSUBSCRIBE auto-add |

---

## 6. Database Health

### Schema Summary

| Metric | Value |
|--------|-------|
| **Total Tables** | 55 |
| **Tables with RLS Policies** | 52 |
| **Tables without RLS Policies** | 3 (`distributed_locks`, `schema_migrations`, `system_metrics`) |
| **Migrations Applied** | 28 |
| **Foreign Key Relationships** | 86 |

### Tables Without RLS (Intentional)

These tables correctly have no tenant-scoped RLS:
- `schema_migrations` -- system-level migration tracking
- `distributed_locks` -- cross-tenant locking mechanism
- `system_metrics` -- global infrastructure telemetry (no tenant_id column)

### Tables with Data

| Table | Row Count | Notes |
|-------|-----------|-------|
| `system_metrics` | 725 | Active -- written every 60 seconds |
| `schema_migrations` | 28 | All migrations applied |
| `audit_logs` | 16 | Admin actions logged |
| `tenants` | 2 | Admin org + demo tenant |
| `agents` | 2 | Configured AI agents |
| `demo_agents` | 2 | Demo system agents |
| `number_routing` | 2 | Phone-to-agent mappings |
| `phone_numbers` | 2 | Registered Twilio numbers |
| `subscriptions` | 2 | Tenant billing subscriptions |
| `user_roles` | 1 | Admin user role |
| `users` | 1 | Admin user |

### Empty Tables Expected to Receive Data During Operation

| Table | Expected Data Source |
|-------|---------------------|
| `call_sessions` | Inbound/outbound voice calls |
| `call_events` | Call lifecycle events |
| `call_transcripts` | AI conversation transcripts |
| `call_logs` | Aggregated call records |
| `usage_metrics` | Call minutes, AI minutes, SMS usage |
| `billing_events` | Stripe webhook events |
| `analytics_metrics` | Metrics rollup worker |
| `campaign_contacts` | CSV import via campaigns |
| `campaign_contact_attempts` | Outbound dial attempts |
| `connector_configs` | Tenant connector credentials |
| `outbox_messages` | Integration delivery queue |

---

## 7. Production Readiness

| Area | Status | Details |
|------|--------|---------|
| **Environment Validation** | COMPLETE | `platform/core/env/validateEnv.ts` runs at startup; reports PASS/FAIL/SKIP for all required vars |
| **Secrets Management** | COMPLETE | All credentials via env vars; no hardcoded secrets; dev fallbacks clearly marked |
| **Database Migrations** | COMPLETE | 28 migrations applied via `scripts/run-migrations.sh`; idempotent schema_migrations tracking |
| **Health Endpoints** | COMPLETE | Admin API: `GET /health` (DB check). Voice Gateway: `GET /health` + `GET /metrics` (sessions, draining status) |
| **Graceful Shutdown** | COMPLETE | `platform/core/env/processHandlers.ts` -- SIGINT/SIGTERM handlers; voice gateway drains active sessions (30s timeout) |
| **Error Handling** | COMPLETE | `platform/core/observability/errorLogger.ts` -- structured errors to `error_logs` table; try/catch on all routes |
| **Rate Limiting** | PARTIALLY IMPLEMENTED | Rate limiter implemented (`platform/infra/rate-limit/`); applied to Twilio webhooks, public API, and demo routes. NOT applied to all admin API routes. |
| **Circuit Breakers** | IMPLEMENTED (available) | `platform/core/resilience/circuitBreaker.ts` with registry; available for use but not wired to all external calls |

### Environment Variables Required for Production

| Variable | Purpose | Status |
|----------|---------|--------|
| `APP_ENV` | Environment selector | SET |
| `DATABASE_URL` | Local dev DB | SET |
| `PLATFORM_DB_POOL_URL` | Supabase prod DB | SET |
| `OPENAI_API_KEY` | AI voice sessions | SET |
| `TWILIO_ACCOUNT_SID` | Telephony | SET |
| `TWILIO_AUTH_TOKEN` | Telephony | SET |
| `TWILIO_OUTBOUND_NUMBER` | Outbound caller ID | SET |
| `ADMIN_JWT_SECRET` | Auth token signing | REQUIRED for prod |
| `CONNECTOR_ENCRYPTION_KEY` | Credential encryption | REQUIRED for prod |
| `STRIPE_SECRET_KEY` | Billing operations | NOT SET (billing non-functional) |
| `STRIPE_WEBHOOK_SECRET` | Webhook verification | NOT SET |
| `STRIPE_PRICE_*` (6 vars) | Plan price IDs | NOT SET |
| `STRIPE_METER_EVENT_*` (2 vars) | Usage meter IDs | NOT SET |
| `SMTP_HOST/PORT/USER/PASS` | Email delivery | NOT SET (using console fallback) |
| `EMAIL_FROM` | Sender address | NOT SET (using default) |

---

## 8. Security Review

| Security Area | Status | Details |
|--------------|--------|---------|
| **Tenant Data Isolation** | STRONG | PostgreSQL RLS on 52/55 tables; `withTenantContext` sets `app.tenant_id` per transaction; `WITH CHECK` prevents cross-tenant writes |
| **PHI Redaction** | COMPLETE | `platform/core/phi/redact.ts` -- regex-based redaction of SSNs, phone numbers, DOBs, names; applied before all logging |
| **API Key Security** | COMPLETE | `vai_` prefix; SHA-256 hashed storage; expiration + revocation support; middleware validation |
| **Webhook Signature Validation** | COMPLETE | Twilio: `validateRequest` on `X-Twilio-Signature`. Stripe: `constructEvent` with `STRIPE_WEBHOOK_SECRET`. Both fail-closed in production. |
| **Auth Token Expiration** | COMPLETE | JWT expiration: 8 hours. HttpOnly cookies with `secure` flag in production. `sameSite: lax` prevents CSRF. |
| **Password Security** | COMPLETE | bcryptjs with salt factor 12. Minimum 8 character enforcement. |
| **Security Headers** | COMPLETE | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` on all responses |
| **CORS** | CONFIGURED | `origin: true`, `credentials: true` -- appropriate for SPA with cookie auth |

---

## 9. System Observability

| Capability | Status | Implementation |
|-----------|--------|---------------|
| **Structured Logging** | ACTIVE | `platform/core/logger/StructuredLogger.ts` -- JSON format with timestamp, level, component, tenant context |
| **Error Capture** | ACTIVE | `platform/core/observability/errorLogger.ts` -- writes to `error_logs` table with stack traces |
| **Call Metrics** | ACTIVE | `platform/core/observability/analyticsWriter.ts` -- records call events to `analytics_metrics` |
| **System Metrics** | ACTIVE | Written every 60s: `active_sessions`, `db_pool_active`, `memory_rss_mb`, `uptime_seconds` (725 records in DB) |
| **Metrics Rollup** | ACTIVE | Hourly aggregation of `call_sessions` into `analytics_metrics` |
| **Session Logging** | ACTIVE | `server/voice-gateway/services/sessionLogger.ts` -- per-call structured logs with tenantId/callId injection |
| **Observability Dashboard** | ACTIVE | `GET /observability/metrics`, `/errors`, `/system` endpoints + frontend page |

---

## 10. Missing Components & Gaps

### Referenced but Not Fully Implemented

| Component | Status | Notes |
|-----------|--------|-------|
| **Automated Phone Number Purchasing** | NOT IMPLEMENTED | Phone numbers are manually registered; no Twilio `IncomingPhoneNumbers.create()` integration |
| **CRM Connector Adapter** | STUBBED | `ConnectorType` includes `crm` but no adapter implementation exists |
| **EHR Connector Adapter** | STUBBED | `ConnectorType` includes `ehr` but no adapter implementation exists |
| **Scheduling Connector Adapter** | STUBBED | `ConnectorType` includes `scheduling` but no adapter implementation exists |
| **Email Connector Adapter** | STUBBED | `ConnectorType` includes `email` but uses dedicated `EmailService` instead |
| **Webhook Connector Adapter** | STUBBED | `ConnectorType` includes `webhook` but no generic webhook adapter exists |
| **Billing Alert Email Delivery** | PARTIALLY IMPLEMENTED | Email template exists (`billingAlertEmail`); NOT wired to billing event triggers |
| **Password Reset Flow** | PARTIALLY IMPLEMENTED | `password_reset_tokens` table exists; email template exists; no API endpoints to initiate/complete reset |

### Implemented but Unused/Untested in Production

| Component | Status | Notes |
|-----------|--------|-------|
| **Stripe Billing Pipeline** | IMPLEMENTED, NOT ACTIVE | Full implementation present but all Stripe env vars are unset; billing operations log warnings at startup |
| **Campaign Dialer** | IMPLEMENTED, NO CAMPAIGNS | Scheduler runs but no campaigns exist; untested with live traffic |
| **Outbox Worker** | IMPLEMENTED, NO MESSAGES | Zero outbox messages; no connector configs provisioned |
| **Call Quality Scoring** | IMPLEMENTED, NO DATA | Frontend page + API routes exist; no call data to score |
| **Analytics Rollup** | RUNNING, NO DATA | Worker executes hourly but `call_sessions` is empty |
| **Usage Metrics** | IMPLEMENTED, EMPTY | Write paths exist; no usage data recorded (no calls processed) |

### Rate Limiting Gaps

Rate limiting is implemented but not uniformly applied:
- Applied: Twilio webhooks, public API, demo routes
- NOT applied: Most admin API CRUD endpoints, SSE endpoint, billing webhooks

### Configuration Gaps for Production

1. **SMTP not configured** -- Email service falls back to console logging; invitation emails are not actually delivered
2. **Stripe not configured** -- Signup flow will fail at checkout session creation; subscription management non-functional
3. **`ADMIN_JWT_SECRET` not set** -- Uses insecure dev fallback; MUST be set for production
4. **`CONNECTOR_ENCRYPTION_KEY` not set** -- Connector credential encryption will fail

---

## Summary & Recommended Next Actions

### Overall Assessment: PLATFORM SUBSTANTIALLY COMPLETE

The platform architecture is mature with 19/19 subsystems implemented (17 complete, 2 partially implemented). The codebase demonstrates production-grade patterns including tenant isolation via RLS, graceful shutdown, circuit breakers, PHI redaction, and structured observability.

### Priority Actions for Production Launch

| Priority | Action | Effort |
|----------|--------|--------|
| **P0** | Configure all Stripe environment variables and validate billing flow end-to-end | Low |
| **P0** | Set `ADMIN_JWT_SECRET` and `CONNECTOR_ENCRYPTION_KEY` for production | Low |
| **P0** | Configure SMTP for email delivery (invitations, password resets) | Low |
| **P1** | Implement password reset API endpoints (`POST /auth/forgot-password`, `POST /auth/reset-password`) | Medium |
| **P1** | Wire billing alert email to failed payment / budget exceeded events | Low |
| **P1** | Process a live inbound call end-to-end to validate the full voice pipeline with real data | Medium |
| **P2** | Add rate limiting to remaining admin API routes | Medium |
| **P2** | Implement automated Twilio phone number purchasing | Medium |
| **P2** | Build CRM/EHR connector adapters (or document as roadmap) | High |
| **P3** | Run a campaign end-to-end with CSV import to validate outbound dialer | Medium |
| **P3** | Add integration tests for invitation flow and caller memory persistence | Medium |
