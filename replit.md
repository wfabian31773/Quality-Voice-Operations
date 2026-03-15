# Voice AI Operations Hub (Multi-Tenant SaaS)

## Overview
Multi-tenant SaaS platform for managing AI-powered voice operations at enterprise scale. Built per a 35-part enterprise blueprint.

## Active Workflows
- **Platform Dev** — starts all services together via `scripts/start-platform-dev.sh`:
  - Vite dev server on port 5000 (external 80) — React admin dashboard
  - Admin API on port 3002 — multi-tenant REST API + Stripe billing
  - Voice Gateway on port 3001 — Twilio webhooks + OpenAI Realtime bridge

## Deployment
- **Build:** `npx tsc --noEmit && npx vite build --config client-app/vite.config.ts`
- **Run:** `APP_ENV=production npx tsx server/admin-api/start.ts & APP_ENV=production npx tsx server/voice-gateway/start.ts & wait`
- Admin API serves pre-built Vite frontend in production from `client-app/dist/`
- **Pre-deploy validation:** `APP_ENV=production npx tsx scripts/validate-env.ts`
- **Full checklist:** `docs/deployment-checklist.md`

## Database
- **Dev:** Replit local PostgreSQL via `DATABASE_URL` (no SSL)
- **Production:** Supabase via `PLATFORM_DB_POOL_URL` (SSL, transaction pooler port 6543)
- **Module:** `platform/db/index.ts` — auto-switches based on `APP_ENV`
- **Migrations:** `migrations/001_*.sql` through `migrations/028_*.sql` — 28 numbered SQL files
- **Runner:** `scripts/run-migrations.ts` — idempotent, applies only files matching `\d{3}_*.sql`
- **Seed:** `scripts/seed-demo.ts` (demo tenant + agents), `scripts/seed-admin.ts` (platform admin user)
- **RLS:** Row-Level Security on all tenant-scoped tables; policy uses `current_setting('app.tenant_id')`
- **Admin seed:** `ADMIN_PASSWORD=YourPassword npx tsx scripts/seed-admin.ts` (dev only, requires ADMIN_PASSWORD env var)
- **Current dev admin:** `admin@voiceaihub.dev` (password set via ADMIN_PASSWORD at seed time)

## Project Structure

```
client-app/         React 19 + Vite 6 + Tailwind CSS 4 + Zustand
server/
  admin-api/        Express 5 admin REST API (port 3002)
  voice-gateway/    Twilio + OpenAI Realtime voice gateway (port 3001)
platform/
  audit/            Audit logging service
  billing/          Stripe billing, budget guards, usage metering, usage recording
  campaigns/        Outbound campaign management
  core/             Env config, logger, PHI redact, resilience, observability
  db/               Database connection pool (dev/prod auto-switch)
  integrations/     Connectors, outbox, ticketing/SMS adapters
  rbac/             API key service, role-based access
  tenant/           Tenant provisioning service
  analytics/        Call analytics, quality scoring
  agent-templates/  Voice agent template configs
  telephony/        Phone number management
  messaging/        SMS messaging
  runtime/          Voice agent runtime
  tools/            Agent tool definitions
  workflow/         Workflow engine
migrations/         SQL migration files (001-028)
scripts/            Migration runner, seed scripts, startup script
```

### client-app/ (port 5000)
- React 19 + Vite 6 + TypeScript + Tailwind CSS v4
- Auth: JWT stored in localStorage, Zustand auth store with `initialized` flag
- Data fetching: React Query (@tanstack/react-query) with auto-refresh
- Pages: Login, Onboarding, Demo, Dashboard, Agents, Phone Numbers, Call History, Connectors, Users, Analytics, Observability, Quality, API Keys, Audit Log, Platform Admin
- Dark/light mode toggle, responsive sidebar layout
- API proxy: /api/* → http://localhost:3002/* (strips /api prefix)

### server/admin-api/ (port 3002)
- JWT auth (`ADMIN_JWT_SECRET`), RBAC via tenant_role enum
- Routes: /auth/login, /auth/signup, /auth/me, /tenants/me, /agents, /phone-numbers, /calls, /users, /connectors, /billing/*, /campaigns/*, /observability/*, /analytics/*, /settings/api-keys, /audit-log, /platform/tenants, /platform/stats
- Self-service signup: creates pending tenant + user, returns Stripe checkout URL
- Stripe billing: checkout sessions, webhook handler, portal links
- Usage metering: hourly job reports AI minutes + call counts to Stripe meter events
- Usage recording: call finalization writes `usage_metrics` (calls_inbound/outbound, ai_minutes); SMS connector writes sms_sent
- Billing config validation: startup warns about missing Stripe price IDs and secrets

### server/voice-gateway/ (port 3001)
- Twilio webhook + OpenAI Realtime WebSocket bridge
- Phone routing: DB-based lookup via `phone_numbers` + `number_routing` tables
- Agent templates: answering-service, medical-after-hours, dental, property-management, home-services, legal
- Call lifecycle: writes `call_sessions` and `call_events` records; populates `total_cost_cents` on finalization
- Graceful shutdown: SIGTERM/SIGINT drain active WebSocket sessions

## Key Rules
- ALL tenant-scoped DB ops use `withTenantContext(client, tenantId, ...)` for RLS
- Cross-tenant/system ops use `withPrivilegedClient` (sets `row_security=off`)
- PHI (phone numbers, names) redacted with `redactPHI()` before any logging
- CONNECTOR_ENCRYPTION_KEY required in production
- ADMIN_JWT_SECRET required in production
- STRIPE_SECRET_KEY required in production

## Environment Variables
See `docs/deployment-checklist.md` for the complete reference. Key variables:
- `APP_ENV` — `development` or `production` (controls DB routing, SSL, error verbosity)
- `DATABASE_URL` — Replit local PostgreSQL (dev only)
- `PLATFORM_DB_POOL_URL` — Supabase transaction pooler (production, port 6543)
- `OPENAI_API_KEY` — OpenAI API key for voice agents
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — Twilio credentials
- `TWILIO_OUTBOUND_NUMBER` — Default outbound caller ID (E.164)
- `ADMIN_JWT_SECRET` — JWT signing secret (required in production)
- `CONNECTOR_ENCRYPTION_KEY` — 32-byte hex key for tenant secret encryption (required in production)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — Stripe keys (required in production)
- `STRIPE_PRICE_{TIER}_{INTERVAL}` — Stripe price IDs per plan (required in production)
- `VOICE_GATEWAY_BASE_URL` — Public voice gateway URL for Twilio webhooks (production)
- `ADMIN_API_BASE_URL` — Public admin API URL (production)
- `TWILIO_COST_PER_MINUTE_CENTS` — Twilio cost per minute in cents (default: 2)
- `AI_COST_PER_MINUTE_CENTS` — AI cost per minute in cents (default: 6)
- `SMS_COST_PER_MESSAGE_CENTS` — SMS cost per message in cents (default: 1)
- `DISABLE_PHI_LOGGING` — set to "true" to suppress PHI in logs

Startup validation: `scripts/validate-env.ts` runs automatically on server start. Fails fast in production if any required variable is missing.

## SIP Audio Format Rules (DO NOT CHANGE)
**Problem solved (Feb 22, 2026):** Dead air / screeching audio caused by codec mismatch between Twilio SIP and OpenAI Realtime API.

**The fix:** Transport monkey-patch strips `audio.input.format` and `audio.output.format` from `session.update` events before they're sent to OpenAI, allowing SIP/SDP negotiation to handle codec selection.

**Rules:**
- NEVER remove the transport monkey-patch — it prevents codec mismatch
- NEVER set audio format directly via the REST API for SIP calls
- Look for `[SIP-FIX]` log lines to confirm stripping is active

## User Preferences
- Logging: Color-coded, session-scoped, PHI redacted
- Safety: Medical guardrails strictly enforced (never bypassed)
- Fail-closed: All auth/crypto/webhook secrets required in production
