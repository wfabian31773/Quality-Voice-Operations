import os

new_content = """### Technical Implementation
- **Admin API (`server/admin-api/`):** An Express 5 application providing JWT-authenticated, RBAC-enabled access to platform resources, including tenant management, agent configuration, billing via Stripe, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.
- **Voice Gateway (`server/voice-gateway/`):** Acts as a Twilio webhook and OpenAI Realtime WebSocket bridge, managing call lifecycle, routing based on `phone_numbers` and `number_routing` tables, and handling audio streaming for the embedded website widget. Includes a critical SIP audio fix for codec compatibility.
- **Database:** PostgreSQL with separate configurations for development (Replit local) and production (Supabase with transaction pooler). Implemented with Row-Level Security (RLS) using `current_setting('app.tenant_id')`. Migrations are handled by numbered SQL files.
- **Core Services (`platform/`):**
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
    - **Knowledge:** Incorporates an embedding service (OpenAI `text-embedding-3-small`), vector search, and a document ingestion pipeline.
    - **Reasoning:** Includes an AI Platform Assistant and an Agent Intelligence & Reasoning Framework for confidence scoring, decision-making, workflow planning, and safety gates.
    - **Workflow:** Manages the workflow engine.
    - **Activation:** Tracks activation events and manages tooltip dismissals.
    - **Widget:** Provides an embeddable website voice/chat widget.
    - **Website Agent:** A public-facing AI sales assistant for websites, including lead capture and analytics.
    - **AI Workforce System (platform/workforce/):** Multi-agent team orchestration enabling tenants to deploy collaborative AI workforces. Features tenant-defined agent teams with roles, AI-to-AI mid-call handoffs via HandoffEngine (integrated into voice gateway stream.ts), configurable intent-based routing rules via WorkforceRoutingService, workforce management dashboard (client-app/src/pages/Workforce.tsx), reusable templates for medical/home-services/legal verticals, and routing history with performance metrics. Database: workforce_teams, workforce_members, workforce_routing_rules, workforce_templates, workforce_routing_history (migration 042). API routes at /workforce/*.
    - **Operations Intelligence:** AI-powered insights engine that analyzes call data, transcripts, quality scores, and tool executions to generate categorized recommendations (missed opportunities, performance, cost optimization, agent improvement, workflow, scheduling). Includes weekly report generation, anomaly detection against rolling baselines (every 30 min via background scheduler), recommendation acceptance/dismissal tracking, alert history with acknowledge flow, and deep-linked action paths to platform features (agent prompt editing, tool config, call review). Background scheduler runs anomaly detection every 30min, insights analysis daily, and weekly reports on Sundays. All DB operations use `withTenantContext` for RLS compliance. Dashboard at `/insights` with 4 tabs: Recommendations, Weekly Reports, Alert History, Impact Tracking. Services: `InsightsEngine`, `InsightsScheduler`. Tables: `ai_insights`, `weekly_reports`. API routes: `/insights/*`.
    - **Agent Self-Improvement Engine:** Automated pipeline that analyzes low-scoring call transcripts using LLM to detect weaknesses (prompt structure, question ordering, objection handling, workflow efficiency, tone, accuracy, resolution), generates targeted prompt improvements with before/after diffs and rationale, validates via simulation scoring, and presents actionable suggestion cards in the Agent Builder. Tenants can approve or dismiss suggestions with one click — approved changes are applied with full version history and rollback support. Continuous improvement dashboard at `/improvements` tracks velocity metrics (generated/accepted/dismissed), weekly trends, category breakdown, acceptance rate, and quality score impact. Services: `SelfImprovementService`. Tables: `prompt_improvement_suggestions`, `improvement_metrics`. API routes: `/improvements/*`. UI: Agent Builder "Improve" panel, `/improvements` dashboard page.
    - **Global Intelligence Network (GIN):** A cross-tenant anonymized learning system that enables collective intelligence across the platform while strictly maintaining data privacy. It aggregates anonymized prompt patterns, common question patterns from transcripts (PHI-redacted), and tool usage sequences. Features a centralized `GlobalInsightEngine` for multi-tenant data aggregation, `AggregationPipeline` for signal collection with tool allowlisting, and `RecommendationDistributor` for delivering insights back to tenants. Includes a `GovernanceService` for policy acceptance tracking (migration 044) and `BenchmarkingService` for cross-vertical performance comparisons. All data undergoes a final centralized redaction pass before analysis. API routes at `/gin/*`. UI: `/global-intelligence` page.
- **Security:** Emphasizes PHI redaction before logging (centralized via `redactPHI`), encryption of tenant secrets, and strict requirement of JWT, Stripe, and connector encryption keys in production.
- **Frontend/Backend Communication:** Utilizes an API proxy for simplified routing and Server-Sent Events (SSE) for real-time data updates (e.g., live calls, demo visualization).
- **Website Widget:** Provides an embeddable voice/chat widget for websites, integrating with the voice gateway and AI sales assistant.
"""

with open('replit.md', 'r') as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1
for i, line in enumerate(lines):
    if "### Technical Implementation" in line:
        start_idx = i
    if "## External Dependencies" in line:
        end_idx = i
        break

if start_idx != -1 and end_idx != -1:
    final_content = lines[:start_idx] + [new_content + "\n\n"] + lines[end_idx:]
    with open('replit.md', 'w') as f:
        f.writelines(final_content)
    print("SUCCESS")
else:
    print(f"FAILURE: start_idx={start_idx}, end_idx={end_idx}")
