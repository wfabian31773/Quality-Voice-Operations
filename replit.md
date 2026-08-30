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
- **Voice Gateway (`server/voice-gateway/`):** Acts as a Twilio webhook and xAI Grok Voice Agent WebSocket bridge, managing call lifecycles, routing, and audio streaming for the embedded website widget. It includes replay protection for inbound webhooks. One Master Voice Agent runtime (`2.0.0`) plus a shared tool library (SMS, email, tickets, scheduling, dispatch) is the GTM core.
- **Database:** PostgreSQL with Row-Level Security (RLS) for multi-tenancy.
- **Core Services (`platform/`):** A comprehensive suite covering Audit, Billing & Usage, Analytics, Campaigns, Integrations, RBAC, Tenant Management, Agent Templates & Marketplace, Telephony & Messaging, Runtime, Email, Tools, Knowledge Management, Reasoning Framework, Workflow engine, and various Mini Systems (SMS Inbox, Scheduling, Enterprise Ticketing, Dispatch), AI Workforce Operating System, AI Business Autopilot, Global Intelligence Network (GIN), and Simulation Lab.
- **Security:** Incorporates PHI redaction, encryption of tenant secrets, and strict enforcement of JWT, Stripe, and connector encryption keys. Inbound webhooks are protected against replay attacks using a combination of in-memory LRU+TTL cache and a durable Postgres backend.
- **Internationalization (i18n):** Supports multiple languages for the UI, documentation, and URL routing. Localization is handled via JSON files and a custom script for translating documentation using OpenAI.
- **Linting & Type-checking:** Enforced using ESLint v9 with custom rules for financial calculations, marketing analytics labels/CTAs, and raw white/gray Tailwind colors in marketing UI; TypeScript type-checking runs via GitHub Actions.
- **End-to-End Testing:** Playwright tests are run for critical features like Sales Inbox filters and accessibility audits for tenant status badges.
- **Drift Detection:** Automated GitHub Actions detect drift in OpenAI Realtime voices and live CRM sandbox validators (HubSpot, Salesforce, Pipedrive, Zoho).
- **Federated Ingest API:** Allows external voice agent systems to push call completion and ticket creation events.
- **Native Agent Porting (Azul Vision):** Supports running Azul Vision's production agents within QVO's voice gateway.
- **Technician Mobile App (`mobile/`):** An Expo (React Native) app for field technicians, enabling job management, dispatch, appointment viewing, and customer communication.

## External Dependencies
- **Database:** PostgreSQL (Supabase for production).
- **Payment Processing:** Stripe (checkout, webhooks, customer portal, metered billing).
- **Telephony:** Twilio (voice calls, SMS messaging, webhooks, number provisioning).
- **AI/ML:** xAI Grok Voice Agent API for live calls (`grok-voice-think-fast-2.0`). OpenAI remains only for non-voice utilities such as embeddings until those are replaced.
- **Email:** Nodemailer (SMTP service), SendGrid Inbound Parse.
- **CAPTCHA:** Cloudflare Turnstile.
- **Frontend Libraries:** Zustand, `@tanstack/react-query`, `@xyflow/react`.
- **Scheduling:** Cal.com or Calendly (via webhooks).
- **Stripe price drift detector:** `platform/billing/StripePriceVerificationScheduler.ts` re-runs `verifyStripePrices()` hourly on the Admin API host and posts an ops-Slack alert (`OPS_SLACK_WEBHOOK_URL`) when the verifier transitions from `ok` to `failed` (and a one-shot recovery message on `failed → ok`). The regression alert now appends a `Latest failure screenshot artifact:` deep link via `getLatestFailureScreenshotLinks()` (best-effort GitHub API lookup, cached) so on-call can confirm the visual regression directly from the Slack thread without bouncing through the Admin console. Latest snapshot is exposed via the `/platform/billing-config-health` admin route as `lastScheduledRun` (now including `failureScreenshotLinks`) and rendered in the Platform Admin "Billing config health" tile. The same panel also embeds the most recent screenshot from the nightly `billing-health-live-stripe.yml` workflow via `platform/billing/githubLiveBillingHealthArtifact.ts` (sibling endpoints `/platform/billing-config-health/last-live-run` + `/last-live-screenshot.png`) — operators get a thumbnail / modal preview of the last green run plus a red dot + link to the open `billing-health-live-drift` tracking issue when the latest run failed, with the integration silently hiding itself when `GITHUB_REPOSITORY` / `GITHUB_TOKEN` aren't configured. The CI workflow's Slack post mirrors the same `Failure screenshot artifact:` line using the `actions/upload-artifact@v4` `artifact-url` output.
- **Discount portal-config cleanup:** `platform/billing/PortalConfigCleanupScheduler.ts` runs daily on the Admin API host. It walks every Stripe billing-portal configuration tagged with `metadata.purpose === 'discount_headline'` (minted by `resolveDiscountedPortalConfigId` in `platform/billing/stripe/checkout.ts`) and deactivates those whose coupon / promotion-code / headline no longer matches any currently-active customer discount. Configurations cannot be deleted via the Stripe API; deactivation hides them from the dashboard's default portal-configurations list. Latest snapshot and a manual trigger are exposed via `GET` / `POST /platform/portal-config-cleanup` admin routes.
