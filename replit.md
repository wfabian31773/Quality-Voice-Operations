# Quality Voice Operations (QVO) — Multi-Tenant SaaS

## Overview
QVO is a multi-tenant SaaS platform designed for managing AI-powered voice operations at an enterprise scale. Built per a 35-part enterprise blueprint and rebranded to QVO (Quality Voice Operations), it provides comprehensive solutions for deploying and managing AI agents, handling customer interactions, and delivering advanced analytics. The platform aims to revolutionize customer service and sales by enabling businesses to efficiently leverage AI for voice interactions. Key capabilities include a visual agent builder, a real-time voice gateway, robust analytics, AI workforce orchestration, cost optimization, advanced observability, and a marketplace for agent templates. The business vision is to revolutionize how enterprises manage their voice channels, driving efficiency, improving customer satisfaction, and unlocking new revenue opportunities through AI. All components are built to enterprise blueprint standards.

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
- **Migrations:** `migrations/001_*.sql` through `migrations/048_*.sql` — numbered SQL files
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
  audit/            Audit logging service (immutable append-only, before/after state diffs, severity levels)
  security/         Enterprise security (EncryptionService: envelope encryption AES-256-GCM, TenantIsolationService: RLS verification, GdprService: data export & erasure)
  billing/          Stripe billing, budget guards, usage metering, usage recording, trial guardrails (guardrails/)
  campaigns/        Outbound campaign management
  core/             Env config, logger, PHI redact, resilience, observability
  db/               Database connection pool (dev/prod auto-switch)
  integrations/     Connectors, outbox, ticketing/SMS adapters
  rbac/             API key service, 4-tier role-based access (Owner → Manager → Operator → Viewer)
  tenant/           Tenant provisioning service
  analytics/        Call analytics, quality scoring (QualityScorerService exports QUALITY_SCORING_RUBRIC), revenue attribution, sentiment analysis, topic clustering, booking funnel
  agent-templates/  Voice agent template configs + manifest.json per template
  marketplace/      Marketplace installation engine (entitlement + install + checklist + customization + reviews + purchases + developer submissions)
  mini-systems/     SMS Inbox, Scheduling, Ticketing, Dispatch (lightweight tenant business tools)
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
  digital-twin/     AI Business Digital Twin (operational simulation, forecasting, scenario testing, prompt A/B & workflow comparison via SimulationEngine, Autopilot validation with persistence)
  widget/           Website voice/chat widget service (token auth, config)
  website-agent/    Website AI sales assistant (OpenAI chat completions, lead capture, analytics)
  workforce/        AI Workforce Operating System (WorkforceRoutingService, HandoffEngine, WorkforceOptimizationEngine, WorkforceRevenueService, WorkforceOutboundService, multi-agent team orchestration, types)
  autopilot/        AI Business Autopilot — proactive intelligence layer (AutopilotEngine, ActionEngine, NotificationService, industry-packs/)
  gin/              Global Intelligence Network (AggregationPipeline, GlobalInsightEngine, BenchmarkingService, RecommendationDistributor, GovernanceService, GinScheduler)
  command-center/   Executive Command Center (Real-time aggregation, cross-tenant data scoping for admins, role-based modules, SSE stream)
  evolution/        Autonomous Platform Evolution Engine (SignalCollector, OpportunityDetectionEngine, RoadmapRecommendationEngine, ExperimentManager — AI product strategist)
  security/         Enterprise security (EncryptionService: envelope encryption AES-256-GCM, TenantIsolationService: RLS verification, GdprService: data export & erasure)
migrations/         SQL migration files (001-046)
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
- **Protected dashboard pages (Layout):** `/dashboard`, `/agents`, `/phone-numbers`, `/calls`, `/simulation-lab`, `/digital-twin`, `/workforce`, `/autopilot`, `/global-intelligence`, `/command-center`, `/improvements`, `/insights`, etc.
- **Note:** `/agents` is used by both the public showcase and the protected dashboard sidebar. The public route takes priority in React Router; authenticated agent management remains accessible via the dashboard layout.
- **Route structure:** Dashboard moved from `/` to `/dashboard`. Root `/` is the public landing page. Login redirects to `/dashboard`.
- **Agent Builder (Agent Studio):** Full-page visual workflow builder at `/agents/:id/builder` (outside Layout, full-screen). Uses `@xyflow/react` (React Flow) for drag-and-drop workflow canvas. Features: Node Library sidebar (Conversation/Logic/Action categories), Node Configuration panels, Voice & Agent Config panel, Test Console, Deployment Manager with version history/rollback, Industry Templates (Medical, Dental, HVAC, Legal, Customer Support).
- Pages: Login, Onboarding, Demo, Dashboard, Operations, Agents, Agent Builder, Phone Numbers, Call History, Connectors, Users, Campaigns, Billing, Knowledge Base, Analytics, Observability (Overview/Tool Activity/Tool Registry tabs), Quality, Widget, Simulation Lab, Digital Twin, Workforce, Autopilot (AI Business Autopilot dashboard — Overview/Recommendations/Insights/Actions/Policies/Notifications tabs), Global Intelligence (GIN dashboard — 4 tabs), Executive Command Center (ECC dashboard — 10 real-time modules for workforce, revenue, autopilot, health, risk, vertical performance, infrastructure, forecast, global intelligence, executive actions), Improvements (Continuous improvement dashboard), Insights (Operations Intelligence dashboard — Recommendations/Reports/Alerts/Impact tabs), Settings (General/Security/API Keys/Roles & Permissions tabs), Audit Log, Update Center (/marketplace/updates), Platform Admin (with Template Versions tab), Developer Portal (/developer), SMS Inbox, Scheduling, Ticketing, Dispatch
- **RBAC (4-tier):** Owner → Manager → Operator → Viewer. Backend: `requireRole()` middleware in `server/admin-api/middleware/rbac.ts` enforces on all write routes. Frontend: `useRole()` hook (`client-app/src/lib/useRole.ts`) provides `role`, `isOwner`, `isManager`, `hasMinRole()`, `PERMISSIONS_MATRIX`. `RoleGuard` component wraps routes requiring minimum role. Write actions (create/edit/delete buttons) hidden from Operator/Viewer roles via `isManager` checks. Owner-only: user invitations, role changes, tenant settings. Audit Log and Compliance routes gated at Manager+.
- **Platform Assistant:** Floating AI assistant button (bottom-right) on all authenticated pages. Expandable chat panel with context-aware guidance, quick actions, and OpenAI-powered function calling (create agents, list connectors, search knowledge, escalate to support). Falls back to rule-based responses when OPENAI_API_KEY is not set.
- Dark/light mode toggle, responsive sidebar layout
- API proxy: /api/* → http://localhost:3002/* (strips /api prefix)

### server/admin-api/ (port 3002)
- JWT auth (`ADMIN_JWT_SECRET`), RBAC via tenant_role enum (4-tier: Owner → Manager → Operator → Viewer; DB roles: tenant_owner, operations_manager, agent_developer, support_reviewer)
- Role hierarchy: Owner (level 4) = full access + user/settings mgmt; Manager (level 3) = write access to agents/campaigns/connectors; Operator (level 2) = limited operational access; Viewer (level 1) = read-only
- Frontend role hook: `client-app/src/lib/useRole.ts` — exports `useRole()`, `hasMinRole()`, `PERMISSIONS_MATRIX`, `ROLE_LABELS`
- Permissions matrix displayed on Settings → Roles & Permissions tab
- Routes: /auth/login, /auth/signup, /auth/me, /tenants/me, /tenants/me/activation, /tenants/me/tooltips, /tenants/me/tooltips/dismiss, /agents, /agents/:id/workflow (PATCH), /agents/:id/publish (POST), /agents/:id/versions (GET), /agents/:id/rollback (POST), /phone-numbers, /calls, /calls/live (SSE), /users, /connectors, /billing/*, /campaigns/*, /observability/*, /analytics/*, /knowledge-articles (CRUD + search), /knowledge-documents (upload/url/text ingestion + list/detail/delete/reindex), /settings/api-keys, /audit-log, /platform/tenants, /platform/stats, /platform/activation-metrics, /widget/* (config, tokens, public-config, embed.js), /marketplace/* (templates, categories, installations, install, updates, upgrades, reviews, purchases, developer submissions, admin moderation, revenue stats), /platform/templates/:id/versions (create draft, validate, publish, deprecate), /demo/live/:callId (SSE for real-time demo call visualization), /demo/active-call (poll for active demo calls), /tool-executions (list/detail/replay), /tools/registry (list available tools with schemas), /operations/realtime (live metrics), /operations/alerts (CRUD), /operations/calls/:callId/live (per-call SSE with transcript + tools), /website-agent/chat (POST, public, rate-limited), /website-agent/greeting (GET, public), /website-agent/leads (GET, admin), /website-agent/analytics (GET, admin), /assistant/chat (POST), /assistant/sessions (GET), /assistant/analytics (GET), /simulations/* (scenarios CRUD, runs, results, compare), /digital-twin/* (models CRUD, scenarios, simulate, runs, results, compare, forecasts, validate), /workforce/* (teams CRUD, members, routing rules, templates, metrics, history), /autopilot/* (summary, insights, recommendations, approve/reject/dismiss/execute, actions, rollback, policies, impact-reports, runs, scan, notifications, industry-packs), /gin/* (aggregation, benchmarks, recommendations, governance), /command-center/* (workforce, revenue, autopilot-feed, customer-engagement, system-health, risk-assessment, vertical-performance, infrastructure-efficiency, predictive-forecasts, executive-actions), /sms-inbox/*, /scheduling/*, /tickets/*, /dispatch/* (Mini Systems API)
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
The QVO platform comprises three main components: a React-based admin dashboard (`client-app`), an Admin REST API (`server/admin-api`), and a Voice Gateway (`server/voice-gateway`).

### UI/UX
The `client-app` is built with React 19, Vite 6, Tailwind CSS 4, TypeScript, and Zustand. It features a responsive design with public marketing pages and a protected dashboard. A core UI element is the **Agent Builder (Agent Studio)**, a visual drag-and-drop workflow builder utilizing `@xyflow/react`. It includes a node library, configuration panels, a test console, and deployment management with version control. A **Platform Assistant** provides in-app, context-aware guidance and quick actions via OpenAI function calling. The UI adheres to the QVO brand guidelines using Deep Harbor (#123047), Signal Teal (#2E8C83), Clinic Mist (#F3F7F7) colors and Sora, Manrope, Inter fonts.

### Technical Implementation
- **Admin API (`server/admin-api/`):** An Express 5 application providing JWT-authenticated, RBAC-enabled access to platform resources. It manages tenant configurations, agent workflows, Stripe billing, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.
- **Voice Gateway (`server/voice-gateway/`):** Functions as a Twilio webhook and OpenAI Realtime WebSocket bridge. It manages the call lifecycle, routes calls based on database configurations, and handles audio streaming for the embedded website widget. A critical SIP audio fix is implemented to ensure codec compatibility.
- **Database:** PostgreSQL is used, with separate configurations for development (local) and production (Supabase with a transaction pooler). Row-Level Security (RLS) is enforced for tenant-scoped operations. Database migrations are managed via numbered SQL files.
- **Core Services (`platform/`):** The `platform/` directory contains a suite of core services, including:
    - **Audit:** Comprehensive audit logging.
    - **Billing & Usage:** Stripe integration for metered billing, cost optimization, and usage tracking.
    - **Stability & Reliability Engine:** Manages tool execution retries, fallbacks, human escalation, and operator notifications.
    - **Analytics:** Provides revenue and performance analytics, sentiment analysis, topic clustering, and conversion funnel tracking.
    - **Campaigns:** Manages outbound campaign execution.
    - **Core:** Handles environmental configuration, logging, PHI redaction, resilience, and observability.
    - **Integrations:** Manages connectors and adapters.
    - **RBAC:** Controls API key management and role-based access.
    - **Tenant:** Facilitates tenant provisioning.
    - **Agent Templates & Marketplace:** Manages voice agent templates and a marketplace for installation and customization.
    - **Telephony & Messaging:** Manages phone numbers and SMS services.
    - **Runtime:** Provides the voice agent runtime environment.
    - **Email:** Handles email services.
    - **Tools:** Defines agent tools and a unified `ToolRegistry`.
    - **Knowledge Management:** Includes an embedding service, vector search, and document ingestion pipeline.
    - **Reasoning Framework:** Provides AI agent intelligence, confidence scoring, and workflow planning.
    - **Workflow:** Manages the workflow engine.
    - **Tenant Workflows:** A tenant-facing workflow builder (`/workflows`) allowing Owners/Managers to create reusable call routing, lead qualification, and escalation flows. Workflows are stored in the `workflows` table (JSONB steps) and can be assigned to agents via `agents.workflow_id`.
    - **Mini Systems:** SMS Inbox, Scheduling, Ticketing, and Dispatch — lightweight tenant business tools for message threading, calendar management, support ticketing, and job dispatching.
    - **Advanced Observability:** Provides call debugging, execution traces, and real-time operational insights.
    - **AI Workforce Operating System:** Manages multi-agent team orchestration and mid-call handoffs.
    - **AI Business Autopilot:** A proactive intelligence layer for operational signals and automated actions.
    - **Global Intelligence Network (GIN):** Aggregates anonymized cross-tenant data for collective intelligence and benchmarking.
    - **Simulation Lab:** An LLM-driven caller simulation engine for bulk-testing AI agents.
    - **Website Agent & Widget:** Provides an embeddable website voice/chat widget and a public-facing AI sales assistant.
- **Security:** Incorporates PHI redaction, encryption of tenant secrets, and strict enforcement of JWT, Stripe, and connector encryption keys.
- **Frontend/Backend Communication:** Utilizes an API proxy for routing and Server-Sent Events (SSE) for real-time data updates.

## External Dependencies
- **Database:** PostgreSQL (Replit for development, Supabase for production).
- **Payment Processing:** Stripe (checkout, webhooks, customer portal, metered billing).
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks).
- **AI/ML:** OpenAI (Realtime API, `text-embedding-3-small`, various GPT models).
- **Email:** Nodemailer (SMTP service).
- **CAPTCHA:** Cloudflare Turnstile (for signup verification).
- **Frontend Libraries:** Zustand, `@tanstack/react-query`, `@xyflow/react`.