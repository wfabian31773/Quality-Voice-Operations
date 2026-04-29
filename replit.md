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
The `client-app` is built with React 19, Vite 6, Tailwind CSS 4, TypeScript, and Zustand, supporting multiple languages via `i18next`. It features a responsive design and a protected dashboard. Key UI elements include the **Agent Builder (Agent Studio)** for visual workflow creation using `@xyflow/react`, with version control and a voice picker. A **Platform Assistant** provides context-aware guidance through OpenAI function calling. The **Design System — Refined Harbor** defines the visual language using a unified approach for runtime CSS variables and typed design tokens, ensuring consistent branding.

### Technical Implementation
- **Admin API (`server/admin-api/`):** An Express 5 application offering JWT-authenticated, RBAC-enabled access to tenant configurations, agent workflows, billing, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.
- **Voice Gateway (`server/voice-gateway/`):** Acts as a Twilio webhook and OpenAI Realtime WebSocket bridge, managing call lifecycles, routing, and audio streaming for the embedded website widget.
- **Federal DNC Registry Sync:** Implements weekly synchronization with the FTC National Do-Not-Call Registry to block calls.
- **Trusted Caller Service:** Manages tenant-scoped verified outbound caller IDs (Twilio OutgoingCallerIds + Trust Hub) for STIR/SHAKEN attestation.
- **Database:** PostgreSQL with Row-Level Security (RLS) for multi-tenancy. Analytics tables are indexed for efficient querying.
- **Core Services (`platform/`):** A comprehensive suite covering Audit, Billing & Usage, Analytics, Campaigns, Integrations, RBAC, Tenant Management, Agent Templates & Marketplace, Telephony & Messaging, Runtime, Email, Tools, Knowledge Management, Reasoning Framework, Workflow engine, Mini Systems (SMS Inbox, Scheduling, Enterprise Ticketing, Dispatch), Advanced Observability, AI Workforce Operating System, AI Business Autopilot, Global Intelligence Network (GIN), Simulation Lab, and Website Agent & Widget.
- **Marketplace Usage Reporting:** Marketplace add-on subscriptions report consumption to Stripe via the Billing Meter Events API.
- **Enterprise Ticketing System:** Provides full-lifecycle ticket management.
- **Enterprise Scheduler:** A comprehensive system for managing appointments, schedules, and resources.
- **Connector Hub (`platform/integrations/connectors/`):** A plug-and-play integration system with adapters for various third-party services, featuring SSRF protection and alert preferences.
- **Security:** Incorporates PHI redaction, encryption of tenant secrets, and strict enforcement of JWT, Stripe, and connector encryption keys.
- **Linting:** Uses ESLint v9 with a custom rule (`local/no-cents-divided-by-100`).
- **Type-checking gate:** Every pull request runs `client-app tsc --noEmit` to prevent new TypeScript errors.
- **Sales Inbox e2e gate:** Every pull request runs an e2e test for Sales Inbox filters.
- **OpenAI Realtime voice drift detector:** A daily GitHub Action checks for drift in OpenAI Realtime voices and opens tracking issues if found.
- **i18n key sync gate:** A CI check asserts that every key in `en/<ns>.json` is present in every other locale file.
- **Localized URL routing:** Visitors can land on `/<locale>/...` (e.g. `/pt-BR/pricing`, `/fr/docs`) or use `/?lang=<locale>` as a shareable, search-engine-indexable language signal. The URL prefix wins over `localStorage`/`navigator.language`, every page emits per-locale `<link rel="alternate" hreflang>` tags via the `SEO` component, and the language picker rewrites the URL on switch. Un-prefixed URLs continue to work; `/en/...` is accepted as an alias of `/...`. See `docs/i18n.md` for details.
- **Frontend/Backend Communication:** Utilizes an API proxy and Server-Sent Events (SSE) for real-time data updates.
- **Federated Ingest API:** Allows external voice agent systems to push call completion and ticket creation events into QVO.
- **Native Agent Porting (Azul Vision):** Supports running Azul Vision's production agents directly within QVO's WebSocket-based voice gateway.
- **Technician Mobile App (`mobile/`):** An Expo (React Native) app for field technicians, enabling job management, dispatch state transitions, appointment viewing, customer communication, and photo/note uploads, with location tracking and secure device enrollment.

## External Dependencies
- **Database:** PostgreSQL (Supabase for production).
- **Payment Processing:** Stripe (checkout, webhooks, customer portal, metered billing).
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks, number provisioning).
- **AI/ML:** OpenAI (Realtime API, `text-embedding-3-small`, various GPT models).
- **Email:** Nodemailer (SMTP service), SendGrid Inbound Parse (for support ticket replies).
- **CAPTCHA:** Cloudflare Turnstile.
- **Frontend Libraries:** Zustand, `@tanstack/react-query`, `@xyflow/react`.
- **Scheduling:** Cal.com (or Calendly) via webhooks.