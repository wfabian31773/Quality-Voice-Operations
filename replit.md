# Quality Voice Operations (QVO) — Multi-Tenant SaaS

## Overview
QVO is a multi-tenant SaaS platform designed for managing AI-powered voice operations at an enterprise scale. It provides robust tools for building, deploying, and monitoring AI voice agents, handling call routing, and integrating with telephony systems. The platform focuses on scalability, robust analytics, and comprehensive billing capabilities, aiming to deliver high-quality, efficient, and secure voice automation solutions for businesses. Key capabilities include agent building, call management, campaign management, knowledge base integration, and a customer-facing AI assistant.

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
- **Security:** PHI redaction before logging, encryption of tenant secrets, and strict requirement of JWT, Stripe, and connector encryption keys in production.

## External Dependencies
- **Database:** PostgreSQL (Replit for dev, Supabase for production).
- **Payment Processing:** Stripe (checkout sessions, webhooks, customer portal, metered billing).
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks).
- **AI/ML:** OpenAI (Realtime API for voice agents, text-embedding-3-small for knowledge base, function calling for Platform Assistant, chat completions for website agents).
- **Email:** Nodemailer (SMTP service, with console-log fallback).
- **CAPTCHA:** Cloudflare Turnstile (for signup verification).
- **Frontend Libraries:** Zustand (state management), `@tanstack/react-query` (data fetching), `@xyflow/react` (Agent Builder canvas).
