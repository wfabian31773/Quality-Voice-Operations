# Quality Voice Operations (QVO) — Multi-Tenant SaaS

## Overview
QVO is a multi-tenant SaaS platform designed for managing AI-powered voice operations at an enterprise scale. It provides comprehensive solutions for deploying and managing AI agents, handling customer interactions, and delivering advanced analytics. The platform aims to enhance customer service and sales by enabling businesses to efficiently leverage AI for voice interactions. Key capabilities include a visual agent builder, a real-time voice gateway, robust analytics, AI workforce orchestration, and a marketplace for agent templates. The business vision is to revolutionize how enterprises manage their voice channels, driving efficiency, improving customer satisfaction, and unlocking new revenue opportunities through AI.

## User Preferences
- Logging: Color-coded, session-scoped, PHI redacted
- Safety: Medical guardrails strictly enforced (never bypassed)
- Fail-closed: All auth/crypto/webhook secrets required in production

## System Architecture
The QVO platform comprises three main components: a React-based admin dashboard (`client-app`), an Admin REST API (`server/admin-api`), and a Voice Gateway (`server/voice-gateway`).

### UI/UX
The `client-app` is built with React 19, Vite 6, Tailwind CSS 4, TypeScript, and Zustand, featuring a responsive design with public marketing pages and a protected dashboard. A core UI element is the **Agent Builder (Agent Studio)**, a visual drag-and-drop workflow builder utilizing `@xyflow/react`. It includes a node library, configuration panels, a test console, and deployment management with version control. A **Platform Assistant** provides in-app, context-aware guidance and quick actions via OpenAI function calling. The UI adheres to the QVO brand guidelines using Deep Harbor (#123047), Signal Teal (#2E8C83), Clinic Mist (#F3F7F7) colors and Sora, Manrope, Inter fonts.

### Technical Implementation
- **Admin API (`server/admin-api/`):** An Express 5 application providing JWT-authenticated, RBAC-enabled access to platform resources. It manages tenant configurations, agent workflows, Stripe billing, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.
- **Voice Gateway (`server/voice-gateway/`):** Functions as a Twilio webhook and OpenAI Realtime WebSocket bridge. It manages the call lifecycle, routes calls based on database configurations, and handles audio streaming for the embedded website widget. A critical SIP audio fix is implemented to ensure codec compatibility.
- **Database:** PostgreSQL is used, with separate configurations for development (Replit local) and production (Supabase with a transaction pooler). Row-Level Security (RLS) is enforced using `current_setting('app.tenant_id')` for tenant-scoped operations. Database migrations are managed via numbered SQL files.
- **Core Services (`platform/`):**
    - **Billing & Usage:** Integrates with Stripe for metered billing of AI minutes, call counts, and tool executions.
    - **Analytics:** Provides revenue and performance analytics, customer sentiment analysis, topic clustering, booking funnel tracking, and unified dashboards.
    - **Stability & Reliability Engine:** Implements tool execution retries, fallback connectors, and human escalation pipelines to ensure production-grade fault tolerance.
    - **AI Workforce Operating System:** Manages multi-agent team orchestration, including AI-to-AI mid-call handoffs and configurable intent-based routing.
    - **AI Business Autopilot:** A proactive intelligence layer that monitors operational signals, detects issues/opportunities, and can auto-execute low-risk actions or present recommendations for human approval.
    - **Global Intelligence Network (GIN):** Aggregates anonymized cross-tenant data to provide collective intelligence, benchmarking, and recommendations while maintaining data privacy.
    - **Operations Intelligence:** An AI-powered insights engine that analyzes call data, transcripts, and quality scores to generate recommendations, detect anomalies, and produce reports.
    - **Agent Self-Improvement Engine:** An automated pipeline that analyzes low-scoring call transcripts to suggest prompt improvements and validate them via simulation scoring.
    - **Knowledge Management:** Includes an embedding service (OpenAI `text-embedding-3-small`), vector search, and a document ingestion pipeline for various content types.
    - **Reasoning Framework:** Provides AI agent intelligence, including confidence scoring, decision-making, workflow planning, and safety gates.
    - **Stability & Reliability Engine:** Automatic tool retry with exponential backoff (`RetryOrchestrator`), secondary integration fallback via `ConnectorService`, graceful conversation fallback messages, human escalation queue (`escalation_tasks` table + `escalate_to_human` agent tool), operator notifications (in-app + Twilio SMS), and a Tool Health admin dashboard at `/reliability`.
- **Security:** Incorporates PHI redaction, encryption of tenant secrets, and strict enforcement of JWT, Stripe, and connector encryption keys in production environments.
- **Frontend/Backend Communication:** Utilizes an API proxy for simplified routing and Server-Sent Events (SSE) for real-time data updates.
- **Website Widget:** An embeddable voice/chat widget for websites, integrated with the voice gateway and AI sales assistant.

### Feature Specifications
- **Simulation Lab:** A dedicated dashboard page for bulk-testing AI agents using an LLM-driven caller simulator. It integrates with the Workflow and Reasoning engines for comprehensive scoring and scenario evaluation.
- **Revenue & Performance Analytics:** Tracks revenue attribution per agent, customer sentiment, topic classifications, and conversion funnel stages, offering detailed insights through a unified dashboard.

## External Dependencies
- **Database:** PostgreSQL (Replit for development, Supabase for production).
- **Payment Processing:** Stripe (checkout, webhooks, customer portal, metered billing).
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks).
- **AI/ML:** OpenAI (Realtime API, `text-embedding-3-small`, GPT models).
- **Email:** Nodemailer (SMTP service).
- **CAPTCHA:** Cloudflare Turnstile (for signup verification).
- **Frontend Libraries:** Zustand, `@tanstack/react-query`, `@xyflow/react`.