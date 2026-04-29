# Quality Voice Operations (QVO) — Multi-Tenant SaaS

## Overview
QVO is a multi-tenant SaaS platform designed to manage AI-powered voice operations for enterprises. It enables the deployment and management of AI agents, handles customer interactions, and provides advanced analytics to revolutionize customer service and sales. Key capabilities include a visual agent builder, a real-time voice gateway, robust analytics, AI workforce orchestration, cost optimization, advanced observability, and an agent template marketplace. The platform features a **Tenant Portal**, **Platform Admin Console**, and **Operations Console**, secured by a 4-tier RBAC system. The vision is to enhance efficiency, improve customer satisfaction, and create new revenue opportunities through AI in voice channels.

## User Preferences
- Logging: Color-coded, session-scoped, PHI redacted
- Safety: Medical guardrails strictly enforced (never bypassed)
- Fail-closed: All auth/crypto/webhook secrets required in production

## System Architecture
The QVO platform consists of a React-based admin dashboard (`client-app`), an Admin REST API (`server/admin-api`), and a Voice Gateway (`server/voice-gateway`).

### UI/UX
The `client-app` is built with React 19, Vite 6, Tailwind CSS 4, TypeScript, and Zustand, supporting multiple languages (English default, Spanish PoC) via `i18next`. It features a responsive design for public marketing pages and a protected dashboard. Key UI elements include the **Agent Builder (Agent Studio)** for visual workflow creation using `@xyflow/react`, with version control and a voice picker featuring OpenAI TTS previews. A **Platform Assistant** provides context-aware guidance through OpenAI function calling. The **Design System — Refined Harbor** defines the visual language using a unified approach for runtime CSS variables and typed design tokens, ensuring consistent branding across the platform.

### Technical Implementation
- **Admin API (`server/admin-api/`):** An Express 5 application offering JWT-authenticated, RBAC-enabled access to tenant configurations, agent workflows, billing, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.
- **Voice Gateway (`server/voice-gateway/`):** Acts as a Twilio webhook and OpenAI Realtime WebSocket bridge, managing call lifecycles, routing, and audio streaming for the embedded website widget.
- **Federal DNC Registry Sync:** Implements weekly synchronization with the FTC National Do-Not-Call Registry to block calls to registered numbers, integrating with campaign pre-flight checks and audit logs. Platform admins can also force a sync from the Compliance console for support cases (`POST /platform/compliance/federal-dnc/sync`), with concurrent triggers serialized server-side.
- **Trusted Caller Service:** Manages tenant-scoped verified outbound caller IDs (Twilio OutgoingCallerIds + Trust Hub) for STIR/SHAKEN attestation, with health checks, alerts, and automatic synchronization.
- **Database:** PostgreSQL with Row-Level Security (RLS) for multi-tenancy. Analytics tables are indexed using `(tenant_id, <time-column> DESC, <kind>)` for efficient querying.
- **Core Services (`platform/`):** A comprehensive suite covering Audit, Billing & Usage, Analytics, Campaigns, Integrations, RBAC, Tenant Management, Agent Templates & Marketplace, Telephony & Messaging, Runtime, Email, Tools, Knowledge Management, Reasoning Framework, Workflow engine, Mini Systems (SMS Inbox, Scheduling, Enterprise Ticketing, Dispatch), Advanced Observability, AI Workforce Operating System, AI Business Autopilot, Global Intelligence Network (GIN), Simulation Lab, and Website Agent & Widget.
- **Enterprise Ticketing System:** Provides full-lifecycle ticket management with features like categories, timelines, notes, SLA policies, custom fields, and reporting.
- **Enterprise Scheduler:** A comprehensive system for managing appointments, schedules, providers, resource booking rules, waitlists, and reminders, with various calendar views and audit logs.
- **Connector Hub (`platform/integrations/connectors/`):** A plug-and-play integration system with adapters for various third-party services (HubSpot, Google Calendar, Outlook Calendar, Slack, Zapier, Twilio SMS, ticketing), featuring SSRF protection and alert preferences.
- **Security:** Incorporates PHI redaction, encryption of tenant secrets, and strict enforcement of JWT, Stripe, and connector encryption keys.
- **Linting:** Uses ESLint v9 with a custom rule (`local/no-cents-divided-by-100`) to prevent common currency calculation errors.
- **Frontend/Backend Communication:** Utilizes an API proxy and Server-Sent Events (SSE) for real-time data updates.
- **Federated Ingest API:** Allows external voice agent systems to push call completion and ticket creation events into QVO via authenticated, rate-limited, and idempotent REST endpoints.
- **Native Agent Porting (Azul Vision):** Supports running Azul Vision's production agents directly within QVO's WebSocket-based voice gateway.
- **Technician Mobile App (`mobile/`):** An Expo (React Native) app for field technicians, enabling job management, dispatch state transitions, appointment viewing, customer communication, and photo/note uploads. It features location tracking for active jobs and secure device enrollment.

## Operational Runbooks
- **Backfill missing dispatch job geocodes:** After deploying `migrations/087_dispatch_jobs_geocode.sql`, run `npx tsx scripts/backfill-dispatch-job-geocodes.ts` (set `APP_ENV` + `DATABASE_URL` for dev, or `APP_ENV=production` + `PLATFORM_DB_POOL_URL` for prod) to pre-populate `address_lat`/`address_lon` so both the dispatcher live map's first ETA and the route-replay tab on historical jobs render instantly. By default the script covers ALL job statuses (open + completed + cancelled); pass `--actionable-only` to scope to still-open jobs. The script is idempotent, rate-limits per the configured geocoder (`DISPATCH_GEOCODE_PROVIDER`), and logs successes/failures per tenant. Full options live in `scripts/README.md` under "Backfill missing dispatch job geocodes".

## External Dependencies
- **Database:** PostgreSQL (Supabase for production).
- **Payment Processing:** Stripe (checkout, webhooks, customer portal, metered billing).
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks, number provisioning).
- **AI/ML:** OpenAI (Realtime API, `text-embedding-3-small`, various GPT models).
- **Email:** Nodemailer (SMTP service).
- **CAPTCHA:** Cloudflare Turnstile (for signup verification).
- **Frontend Libraries:** Zustand, `@tanstack/react-query`, `@xyflow/react`.
- **Inbound Email:** SendGrid Inbound Parse (for support ticket replies).
- **Scheduling:** Cal.com (or Calendly) via webhooks for demo bookings.
