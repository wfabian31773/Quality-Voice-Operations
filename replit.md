# Quality Voice Operations (QVO) — Multi-Tenant SaaS

## Overview
QVO is a multi-tenant SaaS platform designed for managing AI-powered voice operations at an enterprise scale. It provides comprehensive solutions for deploying and managing AI agents, handling customer interactions, and delivering advanced analytics. The platform aims to revolutionize customer service and sales by enabling businesses to efficiently leverage AI for voice interactions. Key capabilities include a visual agent builder, a real-time voice gateway, robust analytics, AI workforce orchestration, cost optimization, advanced observability, and a marketplace for agent templates. The business vision is to revolutionize how enterprises manage their voice channels, driving efficiency, improving customer satisfaction, and unlocking new revenue opportunities through AI.

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