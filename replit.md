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
The `client-app` is built with React 19, Vite 6, Tailwind CSS 4, TypeScript, and Zustand. It features a responsive design with public marketing pages and a protected dashboard. A core UI element is the **Agent Builder (Agent Studio)**, a visual drag-and-drop workflow builder utilizing `@xyflow/react`. It includes a node library, configuration panels, a test console, and deployment management with version control. A **Platform Assistant** provides in-app, context-aware guidance and quick actions via OpenAI function calling. The UI adheres to the QVO brand guidelines using Deep Harbor (#123047), Signal Teal (#2E8C83), Clinic Mist (#F3F7F7) colors and Sora, Manrope, Inter fonts.

### Technical Implementation
- **Admin API (`server/admin-api/`):** An Express 5 application providing JWT-authenticated, RBAC-enabled access to platform resources. It manages tenant configurations, agent workflows, Stripe billing, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.
- **Voice Gateway (`server/voice-gateway/`):** Functions as a Twilio webhook and OpenAI Realtime WebSocket bridge. It manages the call lifecycle, routes calls based on database configurations, and handles audio streaming for the embedded website widget. A critical SIP audio fix is implemented to ensure codec compatibility.
- **Database:** PostgreSQL is used, with separate configurations for development (local) and production (Supabase with a transaction pooler). Row-Level Security (RLS) is enforced for tenant-scoped operations. Database migrations are managed via numbered SQL files.
- **Core Services (`platform/`):** The `platform/` directory contains a suite of core services, including Audit, Billing & Usage, Analytics, Campaigns, Integrations, RBAC, Tenant Management, Agent Templates & Marketplace, Telephony & Messaging, Runtime, Email, Tools, Knowledge Management, Reasoning Framework, Workflow engine, Mini Systems (SMS Inbox, Scheduling, Ticketing, Dispatch), Advanced Observability, AI Workforce Operating System, AI Business Autopilot, Global Intelligence Network (GIN), Simulation Lab, and Website Agent & Widget.
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