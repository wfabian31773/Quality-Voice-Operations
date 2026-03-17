# Quality Voice Operations (QVO) — Multi-Tenant SaaS

## Overview
QVO is a multi-tenant SaaS platform designed for managing AI-powered voice operations at an enterprise scale. It provides tools for building, deploying, and monitoring AI voice agents, handling call routing, and integrating with telephony systems. The platform focuses on scalability, robust analytics, and comprehensive billing capabilities, aiming to deliver high-quality, efficient, and secure voice automation solutions for businesses. Key capabilities include agent building, call management, campaign management, knowledge base integration, and a customer-facing AI assistant.

## User Preferences
- Logging: Color-coded, session-scoped, PHI redacted
- Safety: Medical guardrails strictly enforced (never bypassed)
- Fail-closed: All auth/crypto/webhook secrets required in production

## System Architecture
The QVO platform comprises a React-based admin dashboard (`client-app`), an Admin REST API (`server/admin-api`), and a Voice Gateway (`server/voice-gateway`). The `client-app` utilizes React 19, Vite 6, Tailwind CSS 4, and Zustand for state management, offering a responsive UI with distinct public marketing pages and a protected dashboard. Key UI elements include a visual Agent Builder (Agent Studio) powered by `@xyflow/react` for drag-and-drop workflow creation, and a floating AI Platform Assistant for in-app guidance.

The `server/admin-api` is an Express 5 application providing JWT-authenticated, RBAC-enabled access to platform resources, including tenant management, agent configuration, billing via Stripe, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies. The `server/voice-gateway` acts as a Twilio webhook and OpenAI Realtime WebSocket bridge, managing call lifecycle, routing based on `phone_numbers` and `number_routing` tables, and handling audio streaming for the embedded website widget.

Core architectural decisions include:
- **Multi-tenancy:** Implemented with PostgreSQL Row-Level Security (RLS) using `current_setting('app.tenant_id')`.
- **Database:** PostgreSQL with separate configurations for development (Replit local) and production (Supabase with transaction pooler). Migrations are handled by numbered SQL files.
- **Security:** PHI redaction before logging, encryption of tenant secrets, and strict requirement of JWT, Stripe, and connector encryption keys in production.
- **AI Agent Framework:** Supports various agent templates, a knowledge retrieval tool, and an Agent Intelligence & Reasoning Framework for confidence scoring, decision making, and safety gates.
- **Billing & Usage:** Integrated with Stripe for checkout, webhooks, and metered billing for AI minutes, call counts, and tool executions.
- **Observability:** Audit logging, usage recording, and tools for real-time operations monitoring and alerts.
- **Revenue & Performance Analytics:** Revenue attribution per agent (appointments booked × configurable ticket value), customer sentiment analysis via LLM, automated topic clustering/classification, booking conversion funnel tracking (call → qualified → offered → booked → confirmed), and unified dashboard with date range filtering and JSON export. Services: `RevenueAttributionService`, `SentimentAnalysisService`, `TopicClusteringService`, `ConversionFunnelService`. Tables: `call_sentiment_scores`, `call_topic_classifications`, `call_conversion_stages`. API routes: `/analytics/revenue`, `/analytics/sentiment`, `/analytics/topics`, `/analytics/funnel`, `/analytics/performance`. UI: `/revenue-analytics` page.
- **Frontend/Backend Communication:** API proxy for simplified routing and SSE for real-time data updates (e.g., live calls, demo visualization).
- **Website Widget:** Provides an embeddable voice/chat widget for websites, integrating with the voice gateway and AI sales assistant.

## External Dependencies
- **Database:** PostgreSQL (Replit for dev, Supabase for production)
- **Payment Processing:** Stripe (checkout sessions, webhooks, customer portal, metered billing)
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks)
- **AI/ML:** OpenAI (Realtime API for voice agents, text-embedding-3-small for knowledge base, GPT for Platform Assistant and Website Agent)
- **Email:** Nodemailer (SMTP service, with console-log fallback)
- **CAPTCHA:** Cloudflare Turnstile (for signup verification)
- **UI Libraries:** `@tanstack/react-query` (data fetching), `@xyflow/react` (Agent Builder canvas)