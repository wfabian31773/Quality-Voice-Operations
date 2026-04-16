# Quality Voice Operations (QVO) — Multi-Tenant SaaS

## Overview
QVO is a multi-tenant SaaS platform designed for managing AI-powered voice operations at an enterprise scale. It provides comprehensive solutions for deploying and managing AI agents, handling customer interactions, and delivering advanced analytics. The platform aims to revolutionize customer service and sales by enabling businesses to efficiently leverage AI for voice interactions. Key capabilities include a visual agent builder, a real-time voice gateway, robust analytics, AI workforce orchestration, cost optimization, advanced observability, and a marketplace for agent templates. The platform features three distinct control planes: a **Tenant Portal** for business operations, a **Platform Admin Console** for global governance, and an **Operations Console** for real-time monitoring and diagnostics. Access is managed via a 4-tier RBAC system ensuring granular permission control. The business vision is to revolutionize how enterprises manage their voice channels, driving efficiency, improving customer satisfaction, and unlocking new revenue opportunities through AI.

## User Preferences
- Logging: Color-coded, session-scoped, PHI redacted
- Safety: Medical guardrails strictly enforced (never bypassed)
- Fail-closed: All auth/crypto/webhook secrets required in production

## System Architecture
The QVO platform comprises three main components: a React-based admin dashboard (`client-app`), an Admin REST API (`server/admin-api`), and a Voice Gateway (`server/voice-gateway`).

### UI/UX
The `client-app` is built with React 19, Vite 6, Tailwind CSS 4, TypeScript, and Zustand. It features a responsive design with public marketing pages and a protected dashboard. The **Tenant Portal** sidebar is condensed to exactly 10 business-focused tabs: Dashboard, Agents, Workflows, Conversations, Automation, Integrations, Knowledge, Analytics, Marketplace, and Settings. Technical/internal items (Command Center, Digital Twin, Autopilot, Simulation Lab, Intelligence, etc.) have been removed from the tenant sidebar and redirected. The **Platform Admin Console** (purple) and **Operations Console** (emerald) maintain their own independent navigation and are not reachable from the tenant sidebar. A core UI element is the **Agent Builder (Agent Studio)**, a visual drag-and-drop workflow builder utilizing `@xyflow/react`. It includes a node library, configuration panels, a test console, and deployment management with version control. A **Platform Assistant** provides in-app, context-aware guidance and quick actions via OpenAI function calling. The UI adheres to the QVO brand guidelines using Deep Harbor (#123047), Signal Teal (#2E8C83), Clinic Mist (#F3F7F7) colors and Sora, Manrope, Inter fonts.

### Technical Implementation
- **Admin API (`server/admin-api/`):** An Express 5 application providing JWT-authenticated, RBAC-enabled access to platform resources. It manages tenant configurations, agent workflows, Stripe billing, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.
- **Voice Gateway (`server/voice-gateway/`):** Functions as a Twilio webhook and OpenAI Realtime WebSocket bridge. It manages the call lifecycle, routes calls based on database configurations, and handles audio streaming for the embedded website widget. A critical SIP audio fix is implemented to ensure codec compatibility.
- **Database:** PostgreSQL is used, with separate configurations for development (local) and production (Supabase with a transaction pooler). Row-Level Security (RLS) is enforced for tenant-scoped operations. Database migrations are managed via numbered SQL files.
- **Core Services (`platform/`):** The `platform/` directory contains a suite of core services, including Audit, Billing & Usage, Analytics, Campaigns, Integrations, RBAC, Tenant Management, Agent Templates & Marketplace, Telephony & Messaging, Runtime, Email, Tools, Knowledge Management, Reasoning Framework, Workflow engine, Mini Systems (SMS Inbox, Scheduling, Enterprise Ticketing, Dispatch), Advanced Observability, AI Workforce Operating System, AI Business Autopilot, Global Intelligence Network (GIN), Simulation Lab, and Website Agent & Widget.
- **Enterprise Ticketing System:** Full-lifecycle ticket management with extended schema (migration 049). Features include: ticket categories, activity timeline, internal notes with @mentions, watchers, SLA policies with real-time breach tracking, macros/quick actions, template responses, saved views, custom fields, workflow rules, linked tickets, bulk actions, and reporting dashboard. Admin configuration at `/tickets/admin`, reports at `/tickets/reporting`, detail view at `/tickets/:id`. API routes in `server/admin-api/routes/tickets.ts` cover CRUD for tickets, categories, SLA policies, macros, templates, custom fields, workflow rules, and saved views.
- **Enterprise Scheduler (`migrations/052_enterprise_scheduler.sql`, `server/admin-api/routes/scheduling.ts`, `client-app/src/pages/Scheduling.tsx`):** A comprehensive scheduling system extending the basic bookings table. Includes: providers (name, specialty, location), provider schedules (weekly recurring availability), schedule overrides (blackout dates, special hours), appointment types (duration, buffer, capacity, color, intake fields, self-scheduling), resources (rooms, equipment), booking rules (lead time, same-day, double-book, cancellation window), waitlist (auto-fill on cancellation), reminder configurations (SMS/email per type), reminder delivery log, recurring appointment series, and a full scheduling audit log. The bookings table is extended with provider_id, appointment_type_id, resource_id, recurring_series_id, cancellation_reason, checked_in_at, completed_at, intake_data, timezone, location, and booking_source. Full appointment lifecycle: create, edit, reschedule, cancel, confirm, check-in, complete, no-show, reopen — all audited. Calendar views: day, week, month, agenda, and resource-aware (provider side-by-side). Filters by provider, type, status, and search. Reporting: fill rate, no-show rate, cancellation rate, by provider/type/source, daily trends. Utilization dashboards for providers and resources. RBAC enforced via requireMiniSystemWrite. All new tables have RLS policies.
- **Connector Hub (`platform/integrations/connectors/`):** Plug-and-play integration system with adapters for HubSpot (CRM), Google Calendar (scheduling), Slack (notifications), Zapier (webhooks), Twilio SMS, and ticketing. Adapters are registered in `ConnectorService.ts` with an `ADAPTER_REGISTRY` keyed by connector type. Standard events (`call.completed`, `appointment.booked`, `sms.sent`, `ticket.created`) are dispatched to all active connectors via `dispatchEvent()`. The Connectors page (`/connectors`) shows branded cards with connect/disconnect flows. SSRF protection is enforced on webhook URLs.
- **Security:** Incorporates PHI redaction, encryption of tenant secrets, and strict enforcement of JWT, Stripe, and connector encryption keys.
- **Frontend/Backend Communication:** Utilizes an API proxy for routing and Server-Sent Events (SSE) for real-time data updates.

### Federated Ingest API
The platform supports federated agent ingestion via REST API, enabling external voice agent systems (e.g., Remix/Azul Vision) to push call completion and ticket creation events into QVO. Key components:
- **Ingest endpoints:** `POST /api/v1/ingest/calls`, `POST /api/v1/ingest/tickets`, `GET /api/v1/ingest/status` — authenticated via API key (`Bearer vai_...`), rate-limited, with atomic idempotency via `INSERT ... ON CONFLICT DO NOTHING`.
- **Federated agents:** Agents with `execution_mode='federated'` are read-only in both UI and API — cannot be edited or deleted via the platform. They display an "External" badge and "Managed externally" banner in the tenant Agents page.
- **Migration 051:** Creates `ingest_events` table, adds `execution_mode`/`remote_system`/`remote_agent_id`/`sync_mode`/`last_sync_at` columns to `agents`, adds `external_id` (unique) to `call_sessions`.
- **Seed script:** `scripts/seedAzulVision.ts` creates the Azul Vision tenant with 6 federated agents (no-ivr, after-hours, answering-service, drs-scheduler, appointment-confirmation, fantasy-football), 2 native agents (azul-answering-service, azul-after-hours), phone number routing, an admin user, enterprise subscription, and an API key for ingest.
- **Zod schemas:** `shared/ingest/eventTypes.ts` defines `CallCompletionEventV1Schema` and `TicketCreationEventV1Schema`.

### Native Agent Porting (Azul Vision)
The platform supports running Azul Vision's production agents natively inside QVO's WebSocket-based voice gateway (bypassing the down OpenAI SIP gateway). Key components:
- **Native agents:** Two agents with `execution_mode='native'`: answering-service (+19094135645) and medical-after-hours (+16263821543). Phone number routing configured in `number_routing` table.
- **Azul Vision integrations (`platform/integrations/azul-vision/`):**
  - `ticketingClient.ts` — HTTP client for Azul Vision's ticketing API (env: `TICKETING_SYSTEM_URL`, `TICKETING_API_KEY`). Includes `submitTicket()` and `wakeUp()` for pre-warming sleeping Replit deployment.
  - `scheduleLookupService.ts` — Direct Postgres client for Azul Vision's Supabase schedule database (env: `SUPABASE_DATABASE_URL`). Queries `"Schedule"` table with three lookup strategies: name+DOB, normalized phone, name-only fallback.
- **lookupSchedule tool:** Registered in both answering-service and medical-after-hours templates. Tool definition in `agentLoader.ts`, handler in `openaiSession.ts`, permissions in `toolPermissions.ts`, registry in `registerTemplateTools.ts`.
- **Ticket dual-write:** `createServiceTicketTool.ts` and `createAfterHoursTicketTool.ts` write to both OutboxService AND the Azul Vision ticketing API when `TICKETING_SYSTEM_URL` is set.
- **Custom prompts:** Both system prompt builders detect `practiceName === 'Azul Vision'` and inject ophthalmology-specific content: departments (Optical, Surgery Coordination, Clinical Tech Support), locations (Covina, West Hills, Alhambra, Glendora), hours (Mon-Fri 8-5 PT), urgency criteria, B2B handling, language detection, anti-repetition, ghost call handling.
- **Triage escalation:** `AZUL_VISION_ONCALL_NUMBER` env var used as fallback on-call number in `agentLoader.ts`.
- **Required env vars for native agents:** `TICKETING_SYSTEM_URL`, `TICKETING_API_KEY`, `SUPABASE_DATABASE_URL`, `AZUL_VISION_ONCALL_NUMBER`.

### Twilio Webhook Configuration (Azul Vision Native Agents)
To route calls through QVO's voice gateway, update the Twilio Console for both phone numbers:
1. Log in to [Twilio Console](https://console.twilio.com/) → Phone Numbers → Manage → Active Numbers.
2. For **+1 (909) 413-5645** (Answering Service):
   - Under "A Call Comes In", set to **Webhook**, HTTP **POST**.
   - URL: `https://<QVO_DOMAIN>/twilio/voice` (replace `<QVO_DOMAIN>` with the production domain or dev domain).
3. For **+1 (626) 382-1543** (After-Hours):
   - Under "A Call Comes In", set to **Webhook**, HTTP **POST**.
   - URL: `https://<QVO_DOMAIN>/twilio/voice` (same URL — routing is resolved by called number).
4. Save each number's configuration.
5. Test by calling each number and verifying the agent responds with the Azul Vision greeting.

## Enterprise SMS Console (Mini System)
The SMS Inbox (`/sms-inbox`) is an enterprise-grade messaging workspace with:
- **Two-way conversations**: Threaded SMS conversations with local DB persistence (`sms_conversations`, `sms_messages`), internal notes, and activity logs.
- **Canned response templates**: Reusable reply templates with `{{variable}}` substitution and keyboard shortcuts.
- **Automations**: Auto-reply rules (keyword-based, business hours) and assignment rules (keyword/round-robin routing to users/teams).
- **Compliance**: Automatic STOP/HELP keyword processing, opt-in/opt-out consent tracking (`sms_consent_log`), DNC list integration.
- **Analytics**: Conversation volume, response times, message counts, and status breakdowns (manager-only).
- **Admin controls**: Consent history lookup, compliance settings.
- **Key files**: `platform/sms/SmsConversationService.ts` (service), `server/admin-api/routes/smsInbox.ts` (API), `client-app/src/pages/SmsInbox.tsx` (UI).
- **Migrations**: `052_sms_enterprise.sql` (tables + RLS), `053_sms_check_constraints.sql` (CHECK constraints + indexes), `054_sms_rls_fix.sql` (RLS policy fix to use `app.tenant_id`).
- **RBAC**: `requireMiniSystemWrite` for write ops, `requireRole('manager')` for templates/automations/analytics admin.

## External Dependencies
- **Database:** PostgreSQL (Replit for development, Supabase for production).
- **Payment Processing:** Stripe (checkout, webhooks, customer portal, metered billing).
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks, number provisioning via QVO master account — first number free, additional $2/mo, auto-release on deletion).
- **AI/ML:** OpenAI (Realtime API, `text-embedding-3-small`, various GPT models).
- **Email:** Nodemailer (SMTP service).
- **CAPTCHA:** Cloudflare Turnstile (for signup verification).
- **Frontend Libraries:** Zustand, `@tanstack/react-query`, `@xyflow/react`.