# Quality Voice Operations (QVO) — Multi-Tenant SaaS

## Overview
QVO is a multi-tenant SaaS platform designed to manage AI-powered voice operations for enterprises, enhancing customer service and sales. It facilitates the deployment and management of AI agents, handles customer interactions, and provides advanced analytics. Key capabilities include a visual agent builder, a real-time voice gateway, robust analytics, AI workforce orchestration, and an agent template marketplace. The platform offers a Tenant Portal, Platform Admin Console, and Operations Console, secured by a 4-tier RBAC system, aiming to boost efficiency, improve customer satisfaction, and create new revenue streams through AI in voice channels.

## User Preferences
- Logging: Color-coded, session-scoped, PHI redacted
- Safety: Medical guardrails strictly enforced (never bypassed)
- Fail-closed: All auth/crypto/webhook secrets required in production

## System Architecture
The QVO platform consists of a React-based admin dashboard (`client-app`), an Admin REST API (`server/admin-api`), and a Voice Gateway (`server/voice-gateway`).

### UI/UX
The `client-app` is built with React 19, Vite 6, Tailwind CSS 4, TypeScript, and Zustand, supporting multiple languages via `i18next`. It features a responsive design and a protected dashboard. The **Agent Builder (Agent Studio)** uses `@xyflow/react` for visual workflow creation with version control and an OpenAI TTS-powered voice picker. UI elements within the Agent Builder are localized based on the user's interface language, while agent-produced strings remain in the agent's spoken language. A **Platform Assistant** provides context-aware guidance using OpenAI function calling. The **Design System — Refined Harbor** ensures visual consistency using runtime CSS variables and typed design tokens.

### Technical Implementation
- **Admin API (`server/admin-api/`):** An Express 5 application offering JWT-authenticated, RBAC-enabled access to tenant configurations, agent workflows, billing, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.
- **Voice Gateway (`server/voice-gateway/`):** Acts as a Twilio webhook and OpenAI Realtime WebSocket bridge, managing call lifecycles, routing, and audio streaming for the embedded website widget. It includes replay protection for inbound webhooks.
- **Database:** PostgreSQL with Row-Level Security (RLS) for multi-tenancy.
- **Core Services (`platform/`):** A comprehensive suite covering Audit, Billing & Usage, Analytics, Campaigns, Integrations, RBAC, Tenant Management, Agent Templates & Marketplace, Telephony & Messaging, Runtime, Email, Tools, Knowledge Management, Reasoning Framework, Workflow engine, and various Mini Systems (SMS Inbox, Scheduling, Enterprise Ticketing, Dispatch), AI Workforce Operating System, AI Business Autopilot, Global Intelligence Network (GIN), and Simulation Lab.
- **Security:** Incorporates PHI redaction, encryption of tenant secrets, and strict enforcement of JWT, Stripe, and connector encryption keys. Inbound webhooks are protected against replay attacks using a combination of in-memory LRU+TTL cache and a durable Postgres backend.
- **Internationalization (i18n):** Supports multiple languages for the UI, documentation, and URL routing. Localization is handled via JSON files and a custom script for translating documentation using OpenAI.
- **Linting & Type-checking:** Enforced using ESLint v9 with custom rules for financial calculations and TypeScript type-checking via GitHub Actions.
- **End-to-End Testing:** Playwright tests are run for critical features like Sales Inbox filters and accessibility audits for tenant status badges.
- **Drift Detection:** Automated GitHub Actions detect drift in OpenAI Realtime voices and live CRM sandbox validators (HubSpot, Salesforce, Pipedrive, Zoho).
- **Federated Ingest API:** Allows external voice agent systems to push call completion and ticket creation events.
- **Native Agent Porting (Azul Vision):** Supports running Azul Vision's production agents within QVO's voice gateway.
- **Technician Mobile App (`mobile/`):** An Expo (React Native) app for field technicians, enabling job management, dispatch, appointment viewing, and customer communication.

## External Dependencies
- **Database:** PostgreSQL (Supabase for production).
- **Payment Processing:** Stripe (checkout, webhooks, customer portal, metered billing).
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks, number provisioning).
- **AI/ML:** OpenAI (Realtime API, `text-embedding-3-small`, various GPT models).
- **Email:** Nodemailer (SMTP service), SendGrid Inbound Parse.
- **CAPTCHA:** Cloudflare Turnstile.
- **Frontend Libraries:** Zustand, `@tanstack/react-query`, `@xyflow/react`.
- **Scheduling:** Cal.com or Calendly (via webhooks).