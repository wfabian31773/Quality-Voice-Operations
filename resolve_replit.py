import sys

with open('replit.md', 'r') as f:
    lines = f.readlines()

new_lines = []
in_conflict = False
current_block = "" # "head" or "incoming"

# We will manually construct the desired Technical Implementation and Feature Specifications sections
# based on the merge requirement: Keep ALL documentation from both branches.

# Find boundaries
start_idx = -1
end_idx = -1
for i, line in enumerate(lines):
    if "## System Architecture" in line:
        start_idx = i
    if "## External Dependencies" in line:
        end_idx = i
        break

if start_idx == -1 or end_idx == -1:
    print("Could not find boundaries")
    sys.exit(1)

merged_content = [
    "## System Architecture\n",
    "The QVO platform comprises three main components: a React-based admin dashboard (`client-app`), an Admin REST API (`server/admin-api`), and a Voice Gateway (`server/voice-gateway`).\n",
    "\n",
    "### UI/UX\n",
    "The `client-app` is built with React 19, Vite 6, Tailwind CSS 4, TypeScript, and Zustand, featuring a responsive design with public marketing pages and a protected dashboard. A core UI element is the **Agent Builder (Agent Studio)**, a visual drag-and-drop workflow builder utilizing `@xyflow/react`. It includes a node library, configuration panels, a test console, and deployment management with version control. A **Platform Assistant** provides in-app, context-aware guidance and quick actions via OpenAI function calling. The UI adheres to the QVO brand guidelines using Deep Harbor (#123047), Signal Teal (#2E8C83), Clinic Mist (#F3F7F7) colors and Sora, Manrope, Inter fonts.\n",
    "\n",
    "### Technical Implementation\n",
    "- **Admin API (`server/admin-api/`):** An Express 5 application providing JWT-authenticated, RBAC-enabled access to platform resources. It manages tenant configurations, agent workflows, Stripe billing, usage metering, campaign management, knowledge base operations, and analytics. It enforces trial guardrails, rate limiting, and auto-suspension policies.\n",
    "- **Voice Gateway (`server/voice-gateway/`):** Functions as a Twilio webhook and OpenAI Realtime WebSocket bridge. It manages the call lifecycle, routes calls based on database configurations, and handles audio streaming for the embedded website widget. A critical SIP audio fix is implemented to ensure codec compatibility.\n",
    "- **Database:** PostgreSQL is used, with separate configurations for development (local) and production (Supabase with a transaction pooler). Row-Level Security (RLS) is enforced using `current_setting('app.tenant_id')` for tenant-scoped operations. Database migrations are managed via numbered SQL files.\n",
    "- **Core Services (`platform/`):**\n",
    "    - **Audit:** Provides comprehensive audit logging.\n",
    "    - **Billing & Usage:** Integrates with Stripe for metered billing of AI minutes, call counts, and tool executions.\n",
    "    - **Cost Optimization Engine:** Implements per-conversation cost tracking, intelligent model routing, response caching, token compression, and budget cap enforcement.\n",
    "    - **Stability & Reliability Engine:** Implements tool execution retries (`RetryOrchestrator`), secondary integration fallback via `ConnectorService`, graceful conversation fallback messages, human escalation queue (`escalation_tasks` table + `escalate_to_human` tool), operator notifications (in-app + Twilio SMS), and a Tool Health dashboard at `/reliability`.\n",
    "    - **Analytics:** Provides revenue and performance analytics, customer sentiment analysis, topic clustering, booking funnel tracking, and unified dashboards.\n",
    "    - **Campaigns:** Manages outbound campaigns with optimized prompt templates, type-specific dispositions, and dedicated metrics.\n",
    "    - **Core:** Handles environmental configuration, logging, PHI redaction, resilience, and observability.\n",
    "    - **Integrations:** Manages connectors, outbox, and adapters for ticketing/SMS.\n",
    "    - **RBAC:** Controls API key management and role-based access.\n",
    "    - **Tenant:** Facilitates tenant provisioning.\n",
    "    - **Agent Templates:** Stores configurations and manifests for voice agent templates.\n",
    "    - **Marketplace:** Provides an engine for template installation, entitlements, reviews, and developer submissions.\n",
    "    - **Telephony & Messaging:** Manages phone numbers and SMS services.\n",
    "    - **Runtime:** Provides the voice agent runtime environment.\n",
    "    - **Email:** Utilizes Nodemailer for email services with HTML templates.\n",
    "    - **Tools:** Defines agent tools, knowledge retrieval, and a unified `ToolRegistry`.\n",
    "    - **AI Workforce Operating System:** Manages multi-agent team orchestration, including AI-to-AI mid-call handoffs and configurable intent-based routing.\n",
    "    - **AI Business Autopilot:** A proactive intelligence layer that monitors operational signals, detects issues/opportunities, and can auto-execute low-risk actions or present recommendations for human approval.\n",
    "    - **Global Intelligence Network (GIN):** Aggregates anonymized cross-tenant data to provide collective intelligence, benchmarking, and recommendations while maintaining data privacy.\n",
    "    - **Operations Intelligence:** An AI-powered insights engine that analyzes call data, transcripts, and quality scores to generate recommendations, detect anomalies, and produce reports.\n",
    "    - **Agent Self-Improvement Engine:** An automated pipeline that analyzes low-scoring call transcripts to suggest prompt improvements and validate them via simulation scoring.\n",
    "    - **Knowledge Management:** Includes an embedding service (OpenAI `text-embedding-3-small`), vector search, and a document ingestion pipeline (PDF/URL/text/FAQ extraction, chunking).\n",
    "    - **Reasoning Framework:** Provides AI agent intelligence, including confidence scoring, decision-making, workflow planning, and safety gates.\n",
    "    - **Workflow:** Manages the workflow engine.\n",
    "    - **Activation:** Tracks activation events and tooltip dismissals.\n",
    "    - **Widget:** Provides an embeddable website voice/chat widget.\n",
    "    - **Website Agent:** A public-facing AI sales assistant for websites, including lead capture and analytics.\n",
    "- **Security:** Incorporates PHI redaction, encryption of tenant secrets, and strict enforcement of JWT, Stripe, and connector encryption keys in production environments.\n",
    "- **Frontend/Backend Communication:** Utilizes an API proxy for simplified routing and Server-Sent Events (SSE) for real-time data updates.\n",
    "- **Website Widget:** An embeddable voice/chat widget for websites, integrated with the voice gateway and AI sales assistant.\n",
    "\n",
    "### Feature Specifications\n",
    "- **Cost Optimization Dashboard:** Tracks real-time token usage, provides model tier distribution, and offers budget management with auto-downgrade/auto-end capabilities.\n",
    "- **Tool Health & Reliability:** Per-tool success rates, retry counts, and terminal failure tracking with human escalation management.\n",
    "- **Simulation Lab:** A dedicated dashboard page for bulk-testing AI agents using an LLM-driven caller simulator. It integrates with the Workflow and Reasoning engines for comprehensive scoring and scenario evaluation.\n",
    "- **Operations Intelligence:** An AI-powered insights engine for analyzing call data, transcripts, and quality scores to generate categorized recommendations, perform anomaly detection, and create weekly reports.\n",
    "- **Revenue & Performance Analytics:** Tracks revenue attribution per agent, customer sentiment, topic classifications, and conversion funnel stages, offering detailed insights through a unified dashboard.\n",
    "\n"
]

final_output = lines[:start_idx] + merged_content + lines[end_idx:]

with open('replit.md', 'w') as f:
    f.writelines(final_output)
