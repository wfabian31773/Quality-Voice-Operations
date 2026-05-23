# Voice AI Operations Hub (QVO)

Multi-tenant SaaS for managing AI-powered voice operations at enterprise scale. Three consoles (Tenant Portal, Platform Admin, Operations) on a 4-tier RBAC system.

## Stack

- **Frontend:** React 19 + Vite 6 + Tailwind 4 + Zustand + `@tanstack/react-query` + `@xyflow/react` (Agent Studio) + `i18next`
- **Backend:** Express 5 + TypeScript — Admin API (`:3002`), Voice Gateway (`:3001`), Vite (`:5000`)
- **Database:** PostgreSQL with Row-Level Security (Supabase in prod, Replit local in dev)
- **Auth:** JWT + bcrypt
- **Voice:** OpenAI Realtime API + Twilio SIP trunking
- **Billing:** Stripe (checkout, portal, metered billing, webhooks)
- **Mobile:** Expo / React Native (`mobile/`)
- **Package manager:** npm

## Layout

```
client-app/                 React frontend (Vite)
server/
  admin-api/                Admin REST API (port 3002)
  voice-gateway/            Twilio webhook + OpenAI Realtime bridge (port 3001)
platform/
  audit/                    Audit logging
  billing/                  Stripe billing, schedulers, drift detectors
  core/                     Env config, RBAC, shared helpers
  db/                       Postgres pool
  tenant/                   Tenant management
mobile/                     Expo app for field technicians
migrations/                 SQL migrations (001-027+)
scripts/                    Migration runner, seed scripts, CI helpers
tools/eslint-rules/         Custom ESLint rules
docs/                       Runbooks, audits, security notes, i18n, design system
tests/e2e/                  Playwright suites
```

## Common commands

```bash
npm run dev              # Start Vite + Admin API + Voice Gateway
npm run db:migrate       # Apply pending migrations
npm run db:seed          # Seed demo data
npm run lint             # Lint client-app/src and platform/
npm run lint:rules       # Self-test for custom ESLint rules
npm test                 # Vitest run
```

E2E tests are individual scripts: `npm run test:e2e:<feature>` (see `package.json` for the full list — billing, onboarding, marketplace, agent builder, ops smoke, etc.).

## Conventions

**Currency is stored as integer cents — never floats.** Conversion is allowed only inside `client-app/src/lib/formatCurrency.ts` and `platform/core/formatCurrency.ts`. Custom ESLint rules `local/no-cents-divided-by-100` and `local/no-dollars-times-100` fail CI on inline `* 100` / `/ 100` math. Use `formatCurrency(cents)` for display and `dollarsToCents(input)` for persistence. Legitimate exceptions (e.g. binding into `<input type="number">`) require an inline `eslint-disable-next-line` with a one-line reason.

**PHI / safety:** Logging is color-coded, session-scoped, and PHI-redacted. Medical guardrails are strictly enforced and must never be bypassed. Auth/crypto/webhook secrets are fail-closed in production (missing → service refuses to start).

**Webhook replay protection:** Inbound webhooks use an in-memory LRU+TTL cache backed by a durable Postgres store.

**i18n:** UI strings live in JSON locale files; agent-produced strings stay in the agent's spoken language. Pre-merge i18n key drift gate enforces this.

## Schedulers worth knowing about

- `platform/billing/StripePriceVerificationScheduler.ts` — hourly Stripe price drift check; posts to `OPS_SLACK_WEBHOOK_URL` on `ok→failed` transitions.
- `platform/billing/PortalConfigCleanupScheduler.ts` — daily; deactivates orphaned `discount_headline` portal configs after coupons drop off.

## Drift detectors

GitHub Actions monitor OpenAI Realtime voice list and CRM sandbox validators (HubSpot, Salesforce, Pipedrive, Zoho).

## Where to look

- `README.md` — public-facing setup
- `replit.md` — full architecture brief
- `PLATFORM_READINESS_AUDIT.md` — production readiness checklist
- `docs/runbooks/` — operational procedures (billing backfills, CRM sandbox creds)
- `docs/security/webhook-audit.md` — webhook security review
- `docs/tenant-admin-isolation-audit.md` — RBAC isolation review
- `docs/deployment-checklist.md`, `docs/design-system.md`, `docs/i18n.md`
