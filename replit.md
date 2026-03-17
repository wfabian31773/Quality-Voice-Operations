# Quality Voice Operations (QVO) — Multi-Tenant SaaS

## Overview
Multi-tenant SaaS platform for managing AI-powered voice operations at enterprise scale. Built per a 35-part enterprise blueprint. Rebranded to QVO (Quality Voice Operations).

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
- **Migrations:** `migrations/001_*.sql` through `migrations/043_*.sql` — numbered SQL files
- **Runner:** `scripts/run-migrations.ts` — idempotent, applies only files matching `\d{3}_*.sql`
- **Seed:** `scripts/seed-demo.ts` (demo tenant + agents), `scripts/seed-admin.ts` (platform admin user), `scripts/seed-template-registry.ts` (marketplace template registry), `scripts/seed-vertical-prompt-library.ts` (vertical prompt libraries, starter knowledge packs, demo flows)
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
  billing/          Stripe billing, budget guards, usage metering, usage recording, trial guardrails (guardrails/)
  campaigns/        Outbound campaign management
  core/             Env config, logger, PHI redact, resilience, observability
  db/               Database connection pool (dev/prod auto-switch)
  integrations/     Connectors, outbox, ticketing/SMS adapters
  rbac/             API key service, role-based access
  tenant/           Tenant provisioning service
  analytics/        Call analytics, quality scoring (QualityScorerService exports QUALITY_SCORING_RUBRIC), revenue attribution, sentiment analysis, topic clustering, booking funnel
  agent-templates/  Voice agent template configs + manifest.json per template
  marketplace/      Marketplace installation engine (entitlement + install + checklist + customization + reviews + purchases + developer submissions)
  telephony/        Phone number management
  messaging/        SMS messaging
  runtime/          Voice agent runtime
  email/            Email service (nodemailer SMTP + console-log fallback) + HTML templates
  tools/            Agent tool definitions + knowledge retrieval tool + unified ToolRegistry + ToolExecutionService
  knowledge/        Embedding service (OpenAI text-embedding-3-small) + vector search + document ingestion pipeline (PDF/URL/text/FAQ extraction, chunking, embedding)
  reasoning/        Agent Intelligence & Reasoning Framework (confidence scoring, decision engine, slot tracking, workflow planning, fallback/recovery, escalation, safety gate, industry packs, memory-aware reasoning, reasoning trace)
  workflow/         Workflow engine
  activation/       Activation event tracking + tooltip dismissal service
  assistant/        AI Platform Assistant service (conversational guide with OpenAI function calling)
  simulation/       Conversation Simulation Lab engine (bulk-test AI agents via LLM-driven caller simulation)
  widget/           Website voice/chat widget service (token auth, config)
  website-agent/    Website AI sales assistant (OpenAI chat completions, lead capture, analytics)
  workforce/        AI Workforce multi-agent team orchestration (WorkforceRoutingService, HandoffEngine, types)
migrations/         SQL migration files (001-043)
widget/             Embeddable website widget (embed.js)
scripts/            Migration runner, seed scripts, startup script
```

### client-app/ (port 5000)
- React 19 + Vite 6 + TypeScript + Tailwind CSS v4
- Auth: JWT stored in localStorage, Zustand auth store with `initialized` flag
- Data fetching: React Query (@tanstack/react-query) with auto-refresh
- **QVO Brand:** Deep Harbor (#123047), Signal Teal (#2E8C83), Clinic Mist (#F3F7F7). Fonts: Sora (display), Manrope (body), Inter (UI).
- **Visual assets:** `client-app/public/assets/` — screenshots (6), avatars (10), tools (4), workflows (1), features (4), blog headers (5), plus `og-default.png` for social previews. All images lazy-loaded with proper alt text.
- **Public marketing pages (PublicLayout):** `/` (Landing), `/product`, `/agents` (showcase), `/pricing`, `/use-cases`, `/integrations`, `/demo` (with real-time visualization panels: transcript, tools, calendar, activity feed via SSE), `/resources` (guides hub), `/resources/:slug` (guide detail), `/contact`, `/docs`, `/signup`
- **Protected dashboard pages (Layout):** `/dashboard`, `/agents`, `/phone-numbers`, `/calls`, `/simulation-lab`, `/workforce`, etc.
- **Note:** `/agents` is used by both the public showcase and the protected dashboard sidebar. The public route takes priority in React Router; authenticated agent management remains accessible via the dashboard layout.
- **Route structure:** Dashboard moved from `/` to `/dashboard`. Root `/` is the public landing page. Login redirects to `/dashboard`.
- **Agent Builder (Agent Studio):** Full-page visual workflow builder at `/agents/:id/builder` (outside Layout, full-screen). Uses `@xyflow/react` (React Flow) for drag-and-drop workflow canvas. Features: Node Library sidebar (Conversation/Logic/Action categories), Node Configuration panels, Voice & Agent Config panel, Test Console, Deployment Manager with version history/rollback, Industry Templates (Medical, Dental, HVAC, Legal, Customer Support).
- Pages: Login, Onboarding, Demo, Dashboard, Operations, Agents, Agent Builder, Phone Numbers, Call History, Connectors, Users, Campaigns, Billing, Knowledge Base, Analytics, Observability (Overview/Tool Activity/Tool Registry tabs), Quality, Widget, Simulation Lab, Workforce, Settings (General/Security/API Keys tabs), Audit Log, Update Center (/marketplace/updates), Platform Admin (with Template Versions tab), Developer Portal (/developer)
- **Platform Assistant:** Floating AI assistant button (bottom-right) on all authenticated pages. Expandable chat panel with context-aware guidance, quick actions, and OpenAI-powered function calling (create agents, list connectors, search knowledge, escalate to support). Falls back to rule-based responses when OPENAI_API_KEY is not set.
- Dark/light mode toggle, responsive sidebar layout
- API proxy: /api/* → http://localhost:3002/* (strips /api prefix)

### server/admin-api/ (port 3002)
- JWT auth (`ADMIN_JWT_SECRET`), RBAC via tenant_role enum
- Routes: /auth/login, /auth/signup, /auth/me, /tenants/me, /tenants/me/activation, /tenants/me/tooltips, /tenants/me/tooltips/dismiss, /agents, /agents/:id/workflow (PATCH), /agents/:id/publish (POST), /agents/:id/versions (GET), /agents/:id/rollback (POST), /phone-numbers, /calls, /calls/live (SSE), /users, /connectors, /billing/*, /campaigns/*, /observability/*, /analytics/*, /knowledge-articles (CRUD + search), /knowledge-documents (upload/url/text ingestion + list/detail/delete/reindex), /settings/api-keys, /audit-log, /platform/tenants, /platform/stats, /platform/activation-metrics, /widget/* (config, tokens, public-config, embed.js), /marketplace/* (templates, categories, installations, install, updates, upgrades, reviews, purchases, developer submissions, admin moderation, revenue stats), /platform/templates/:id/versions (create draft, validate, publish, deprecate), /demo/live/:callId (SSE for real-time demo call visualization), /demo/active-call (poll for active demo calls), /tool-executions (list/detail/replay), /tools/registry (list available tools with schemas), /operations/realtime (live metrics), /operations/alerts (CRUD), /operations/calls/:callId/live (per-call SSE with transcript + tools), /website-agent/chat (POST, public, rate-limited), /website-agent/greeting (GET, public), /website-agent/leads (GET, admin), /website-agent/analytics (GET, admin), /assistant/chat (POST), /assistant/sessions (GET), /assistant/analytics (GET), /simulations/* (scenarios CRUD, runs, results, compare), /workforce/* (teams CRUD, members, routing rules, templates, metrics, history)
- Self-service signup: creates pending tenant + user, returns Stripe checkout URL
- Stripe billing: checkout sessions, webhook handler, portal links
- Usage metering: hourly job reports AI minutes + call counts to Stripe meter events
- Usage recording: call finalization writes `usage_metrics` (calls_inbound/outbound, ai_minutes, tool_executions, api_requests); SMS connector writes sms_sent
- Trial guardrails: 7-day trial, 20 calls, 3-min/call cap, 2 agents, 10 tool executions; email verification required; phone verification for outbound; CAPTCHA (Turnstile) on signup
- Rate limiting: per-tenant hourly call limits (Starter 10/hr, Pro 50/hr, Enterprise unlimited); daily call minute caps
- Auto-suspension: 2x overage on non-enterprise accounts triggers automatic suspension; 80% threshold grace notifications
- Billing config validation: startup warns about missing Stripe price IDs and secrets

### server/voice-gateway/ (port 3001)
- Twilio webhook + OpenAI Realtime WebSocket bridge
- Phone routing: DB-based lookup via `phone_numbers` + `number_routing` tables
- Agent templates: answering-service, medical-after-hours, dental, property-management, home-services, legal
- Call lifecycle: writes `call_sessions` and `call_events` records; populates `total_cost_cents` on finalization
- AI-to-AI handoff: workforce team lookup per call, `transfer_to_agent` tool injection, `rebuildForHandoff()` session swap with `isHandoffSwap` flag, `attachSessionListeners()` reattachment
- Graceful shutdown: SIGTERM/SIGINT drain active WebSocket sessions
- Widget WebSocket: `/widget/stream?token=xxx` — browser-to-gateway audio streaming for embedded website widget
- API proxy: /twilio/* → http://localhost:3001/* (with forwarded headers for Twilio signature validation)

### Simulation Lab
- **Route:** `/simulation-lab` — protected dashboard page for bulk-testing AI agents
- **Engine:** `platform/simulation/SimulationEngine.ts` — LLM-driven caller simulation (GPT-4o-mini)
- **Integrations:** WorkflowEngine (directive-constrained agent responses, slot extraction), ReasoningEngine (intent classification, decision evaluation, safety gating)
- **Scoring:** Imports `QUALITY_SCORING_RUBRIC` from `platform/analytics/QualityScorerService` for consistent quality dimensions (helpfulness/accuracy/tone/resolution), plus simulation-specific metrics (bookingSuccess/intentResolution/conversationCompletion)
- **DB:** `simulation_scenarios`, `simulation_runs`, `simulation_results` (migration 042, VARCHAR PKs, RLS)
- **API:** `/simulations/scenarios` (CRUD), `/simulations/runs` (create+execute), `/simulations/runs/:id`, `/simulations/runs/:id/results`, `/simulations/runs/compare`
- **Defaults:** 5 seeded scenarios per tenant (angry customer billing dispute, emergency medical call, scheduling conflict, lead qualification, simple appointment booking)
- **Dashboard:** Pass rate donut, score distribution, category breakdown (pass/fail by scenario type), failure reasons, conversation replay

### Test Phone Number
- **+16266056373** — Twilio number registered for admin-org tenant
- Routed to "Quality Voice Operations Agent" (answering-service, voice: sage)
- Twilio webhook pointed to `https://<REPLIT_DEV_DOMAIN>/twilio/voice`
- Status callback: `https://<REPLIT_DEV_DOMAIN>/twilio/status`
- **Setup/refresh:** `npx tsx scripts/setup-test-number.ts` (idempotent — creates agent, number, routing, updates Twilio webhooks)

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
- `SMTP_HOST` — SMTP server (smtp.office365.com, set automatically)
- `SMTP_PORT` — SMTP port (587, set automatically)
- `SMTP_USER`, `SMTP_PASS` — SMTP credentials (required in production)
- `EMAIL_FROM` — sender address for emails (required in production)
- `APP_URL` — base URL for email links (required in production)
- `ADMIN_INTERNAL_TOKEN` — bearer token for inter-service calls (auto-generated)
- `DISABLE_PHI_LOGGING` — set to "true" to suppress PHI in logs
- `TURNSTILE_SECRET_KEY` — Cloudflare Turnstile secret for CAPTCHA verification (optional; skipped if not set)
- `VITE_TURNSTILE_SITE_KEY` — Cloudflare Turnstile site key for frontend CAPTCHA widget (optional)

Startup validation: `scripts/validate-env.ts` runs automatically on server start. Fails fast in production if any required variable is missing.
Production DB verification: `scripts/verify-prod-db.ts` — connects to Supabase, reports migration count, table count, RLS status.

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

## System Architecture
The QVO platform comprises a React-based admin dashboard (`client-app`), an Admin REST API (`server/admin-api`), and a Voice Gateway (`server/voice-gateway`). 

### UI/UX
The `client-app` utilizes React 19, Vite 6, Tailwind CSS 4, TypeScript, and Zustand for state management, offering a responsive UI with distinct public marketing pages and a protected dashboard. Key UI elements include:
- **Agent Builder (Agent Studio):** A visual workflow builder powered by `@xyflow/react` for drag-and-drop workflow creation. It includes a node library, configuration panels, a test console, and a deployment manager with version control.
- **Platform Assistant:** An AI-powered conversational guide integrated across authenticated pages for in-app guidance, offering context-aware assistance and quick actions via OpenAI function calling.

### Technical Implementation
- **Admin API (`server/admin-api/`):** An Express 5 application providing JWT-authenticated, RBAC-enabled access to platform resources, including tenant management, agent configuration, billing via Stripe, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.
- **Voice Gateway (`server/voice-gateway/`):** Acts as a Twilio webhook and OpenAI Realtime WebSocket bridge, managing call lifecycle, routing based on `phone_numbers` and `number_routing` tables, and handling audio streaming for the embedded website widget. Includes a critical SIP audio fix for codec compatibility.
- **Database:** PostgreSQL with separate configurations for development (Replit local) and production (Supabase with transaction pooler). Implemented with Row-Level Security (RLS) using `current_setting('app.tenant_id')`. Migrations are handled by numbered SQL files.
- **Core Services (`platform/`):** A comprehensive set of services including:
    - **Audit:** Audit logging.
    - **Billing & Usage:** Integrated with Stripe for checkout, webhooks, and metered billing for AI minutes, call counts, and tool executions.
    - **Campaigns:** Outbound campaign management with typed campaigns (Appointment Reminder, Lead Follow-Up, Review Request, Customer Reactivation, Upsell) — each with optimized prompt templates, type-specific dispositions, and dedicated metrics.
    - **Core:** Environmental configuration, logging, PHI redaction, resilience, and observability.
    - **Integrations:** Connectors, outbox, and adapters for ticketing/SMS.
    - **RBAC:** API key management and role-based access control.
    - **Tenant:** Tenant provisioning.
    - **Analytics:** Revenue & Performance Analytics, revenue attribution per agent, customer sentiment analysis via LLM, automated topic clustering, booking conversion funnel tracking, and unified dashboards.
    - **Agent Templates:** Configuration and manifests for voice agent templates.
    - **Marketplace:** Engine for template installation, entitlements, reviews, and developer submissions.
    - **Telephony & Messaging:** Phone number management and SMS services.
    - **Runtime:** Voice agent runtime environment.
    - **Email:** Nodemailer-based email service with HTML templates.
    - **Tools:** Agent tool definitions, knowledge retrieval, and a unified `ToolRegistry`.
    - **Knowledge:** Embedding service (OpenAI `text-embedding-3-small`), vector search, and document ingestion pipeline (PDF/URL/text/FAQ extraction, chunking).
    - **Reasoning:** AI Platform Assistant and an Agent Intelligence & Reasoning Framework for confidence scoring, decision-making, workflow planning, and safety gates.
    - **Workflow:** Workflow engine.
    - **Activation:** Event tracking and tooltip dismissal.
    - **Widget:** Embeddable website voice/chat widget for websites.
    - **Website Agent:** Public-facing website AI sales assistant with lead capture and analytics.
    - **AI Workforce System (platform/workforce/):** Multi-agent team orchestration enabling tenants to deploy collaborative AI workforces. Features tenant-defined agent teams with roles, AI-to-AI mid-call handoffs via HandoffEngine (integrated into voice gateway stream.ts), configurable intent-based routing rules via WorkforceRoutingService, workforce management dashboard (client-app/src/pages/Workforce.tsx), reusable templates for medical/home-services/legal verticals, and routing history with performance metrics. Database: workforce_teams, workforce_members, workforce_routing_rules, workforce_templates, workforce_routing_history (migration 042). API routes at /workforce/*.
- **Security:** PHI redaction before logging, encryption of tenant secrets, and strict requirement of JWT, Stripe, and connector encryption keys in production.
- **AI Agent Framework:** Supports various agent templates, a knowledge retrieval tool, and an Agent Intelligence & Reasoning Framework for confidence scoring, decision making, and safety gates.
- **Billing & Usage:** Integrated with Stripe for checkout, webhooks, and metered billing for AI minutes, call counts, and tool executions.
- **Observability:** Audit logging, usage recording, and tools for real-time operations monitoring and alerts.
- **Revenue & Performance Analytics:** Revenue attribution per agent (appointments booked × configurable ticket value), customer sentiment analysis via LLM, automated topic clustering/classification, booking conversion funnel tracking (call → qualified → offered → booked → confirmed), and unified dashboard with date range filtering and JSON export. Services: `RevenueAttributionService`, `SentimentAnalysisService`, `TopicClusteringService`, `ConversionFunnelService`. Tables: `call_sentiment_scores`, `call_topic_classifications`, `call_conversion_stages`. API routes: `/analytics/revenue`, `/analytics/sentiment`, `/analytics/topics`, `/analytics/funnel`, `/analytics/performance`. UI: `/revenue-analytics` page.
- **Operations Intelligence:** AI-powered insights engine that analyzes call data, transcripts, quality scores, and tool executions to generate categorized recommendations (missed opportunities, performance, cost optimization, agent improvement, workflow, scheduling). Includes weekly report generation, anomaly detection against rolling baselines (every 30 min via background scheduler), recommendation acceptance/dismissal tracking, alert history with acknowledge flow, and deep-linked action paths to platform features (agent prompt editing, tool config, call review). Background scheduler runs anomaly detection every 30min, insights analysis daily, and weekly reports on Sundays. All DB operations use `withTenantContext` for RLS compliance. Dashboard at `/insights` with 4 tabs: Recommendations, Weekly Reports, Alert History, Impact Tracking. Services: `InsightsEngine`, `InsightsScheduler`. Tables: `ai_insights`, `weekly_reports`. API routes: `/insights/*`.
- **Agent Self-Improvement Engine:** Automated pipeline that analyzes low-scoring call transcripts using LLM to detect weaknesses (prompt structure, question ordering, objection handling, workflow efficiency, tone, accuracy, resolution), generates targeted prompt improvements with before/after diffs and rationale, validates via simulation scoring, and presents actionable suggestion cards in the Agent Builder. Tenants can approve or dismiss suggestions with one click — approved changes are applied with full version history and rollback support. Continuous improvement dashboard at `/improvements` tracks velocity metrics (generated/accepted/dismissed), weekly trends, category breakdown, acceptance rate, and quality score impact. Services: `SelfImprovementService`. Tables: `prompt_improvement_suggestions`, `improvement_metrics`. API routes: `/improvements/*`. UI: Agent Builder "Improve" panel, `/improvements` dashboard page.
- **Frontend/Backend Communication:** API proxy for simplified routing and SSE for real-time data updates (e.g., live calls, demo visualization).
- **Website Widget:** Provides an embeddable voice/chat widget for websites, integrating with the voice gateway and AI sales assistant.

## External Dependencies
- **Database:** PostgreSQL (Replit for dev, Supabase for production).
- **Payment Processing:** Stripe (checkout sessions, webhooks, customer portal, metered billing).
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks).
- **AI/ML:** OpenAI (Realtime API for voice agents, text-embedding-3-small for knowledge base, GPT for Platform Assistant and Website Agent).
- **Email:** Nodemailer (SMTP service, with console-log fallback).
- **CAPTCHA:** Cloudflare Turnstile (for signup verification).
- **Frontend Libraries:** Zustand (state management), `@tanstack/react-query` (data fetching), `@xyflow/react` (Agent Builder canvas).
