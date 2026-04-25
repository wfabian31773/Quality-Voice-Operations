# 06 — Security & Compliance

RBAC, RLS, JWT/secret handling, PHI redaction, SSRF, audit-log completeness, HIPAA-adjacent risks.

---

## S-01 — SSRF allow-list bypass (Zapier webhook) — P0
- Same as B-03 / I-01. Cross-listed because of severity.

## S-02 — Twilio webhook signature not verified — P0
- Same as I-03. Spoofed inbound calls can drain OpenAI quota and trigger arbitrary tool executions.

## S-03 — Open redirect on `/login?redirectTo=` — P1
- Same as B-20.

## S-04 — Auth middleware swallows DB errors as 403 — P1
- Same as B-04. The 403 message "No active role in this tenant" is misleading and may mask outages.

## S-05 — `requireTenantContext` does not inspect URL params — P1
- Same as B-06. Defense-in-depth gap.

## S-06 — Audit log coverage gaps
- `platform/audit/AuditService.ts` is wired into `auth/login`, `auth/signup`, agent CRUD, marketplace install. **Not wired** into:
  - `connectorOAuth` connect/disconnect (we don't audit who linked Salesforce).
  - `widget/tokens` create/delete (long-lived widget tokens are sensitive).
  - `phoneNumbers` route changes.
  - `users` invite + role change (we audit the login but not the invitation).
  - `compliance/encryption/rotate` — should always audit.
  - `legalCompliance/privacy/erase` — should audit.
- Recommend a single `auditMutation` middleware that logs every non-GET tenant-scoped mutation by default.

## S-07 — Secrets handling
- `ADMIN_JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CONNECTOR_ENCRYPTION_KEY`, `OPENAI_API_KEY`, `TWILIO_AUTH_TOKEN` — all required in production via `validateEnvironment`. Good.
- `TURNSTILE_SECRET_KEY` is **optional** — when missing, the verifier returns `true`. This is the correct dev behavior but should warn loudly in prod (currently a single `logger.warn` per request — should be a startup error).
- `ADMIN_INTERNAL_TOKEN` is documented as "Optional" in `deployment-checklist.md` but is required by `voice-gateway/routes/adminConnectors.ts`. Mark required.

## S-08 — JWT
- Algorithm not pinned (`jwt.verify(token, secret)` uses default which is `HS256` if signed with HS256). Should pin `algorithms: ['HS256']` to defeat algorithm-confusion attacks.
- Token expiry: 8 hours (acceptable). No refresh-token rotation; a single 8h token is the only proof.
- Cookie `auth_token` attributes — verify `HttpOnly`, `Secure`, `SameSite=Lax` (the file `auth.ts` sets the cookie at login but the audit window did not confirm Set-Cookie attributes).

## S-09 — RLS coverage
- 52/55 tables covered per readiness audit (March). Migrations 037–065 added several tables (`enterprise_dispatch_*`, `scheduling_*`, `support_*`, `docs_feedback_*`, `marketplace_purchases`, `marketplace_reviews`, `case_studies`, `tenant_notifications`).
- Spot-check via filenames: `054_sms_rls_fix.sql` and `047_observability_rls.sql` are catch-up migrations; the implication is that some tables were created without RLS and patched later.
- Recommend a recurring `verify-rls.ts` CI check that fails the build if any table on the tenant-scoped allow-list has `relrowsecurity = false`.

## S-10 — RBAC consistency
- Mini-system writes (dispatch, scheduling, sms-inbox) require `requireMiniSystemWrite` (owner / operations_manager). Reads only require `requireAuth` — any role including viewer can read. Acceptable.
- `legalCompliance/privacy/export` requires `owner`. Good.
- `compliance/encryption/initialize` and `rotate` require `owner`. Good.
- `marketplace/install` requires `manager`. Good.
- **Inconsistency:** `widget/tokens` POST/DELETE require `manager`; but `apiKeys` create/revoke (similarly sensitive) only require generic `requireAuth`. Confirm and align.

## S-11 — PHI redaction
- `platform/core/phi` exists. The redactor is invoked inside `createLogger`. But:
  - The bare `console.log('[REQ] …')` in `app.ts` (B-16) bypasses the redactor.
  - `voice-gateway/services/sessionLogger.ts` writes raw transcripts to a per-call log; need to confirm the redactor applies before write.
  - `recordIntegrationEvent` body field can carry phone numbers and PII inside connector payloads — confirm redactor passes through that path.

## S-12 — HIPAA-adjacent risks (Azul Vision and other healthcare verticals)
- Native Azul Vision agent ports run inside QVO and may handle PHI (patient names, DOBs, callback numbers).
- BAA posture is not visible in the codebase — recommend a `docs/security/hipaa-bAA.md` checklist that lists which sub-processors (OpenAI, Twilio, Supabase, SendGrid, Cloudflare) sign BAAs and which do not.
- Any agent template in `platform/agent-templates/medical-after-hours/` and `dental/` should default to PHI-redacted logging mode.

## S-13 — Maintenance mode lockout — P2
- B-25.

## S-14 — Rate limiting only on demo + websiteAgent
- A single authenticated user can hammer `/agents`, `/calls`, `/tickets` arbitrarily. Recommend a global per-tenant rate limit of e.g. 200 RPS with burst.

## S-15 — Subprocessor list management is admin-only via API only
- `routes/legalCompliance.ts` exposes admin CRUD. The public `Subprocessors.tsx` page reads the list. Good.
- Policy: changes to subprocessors should generate an email to all tenants per most DPAs. No mailer hook today.

## S-16 — Account deletion cool-off has no purge worker (#210, #216)
- After 30 days a tenant's data should be irretrievably deleted. Today the request row sits forever. Cross-listed for security/compliance because GDPR requires the deletion to actually happen.

## S-17 — Email templates load secrets via env
- `platform/email/EmailService.ts` reads SMTP creds from env. Verify all template renders are HTML-escaped to prevent template injection from user-supplied input (e.g. user names in welcome emails).

## S-18 — Cookie set without `Secure` flag in dev
- `auth_token` cookie likely set with `secure: process.env.NODE_ENV === 'production'`. In dev (HTTPS REPL_DEV_DOMAIN) this still works because Replit's preview is HTTPS. Verify the cookie attribute follows `process.env.APP_ENV` rather than `NODE_ENV`.

## S-19 — `cors({ origin: true, credentials: true })` reflects any origin
- `server/admin-api/app.ts` uses `cors({ origin: true, credentials: true })`. The `origin: true` reflects the request's `Origin` header, which combined with `credentials: true` means any origin can send authenticated requests.
- In dev with the preview iframe this is needed, but in production it should be locked to known origins (`ALLOWED_ORIGINS` env list).

## S-20 — `X-Frame-Options: DENY` is set globally
- That breaks the preview iframe. The header is set by the security middleware in `app.ts`. Replit preview must run in an iframe; this header conflicts with the preview pane and may be why some users see blank screens initially.
- Fix: in dev, omit `X-Frame-Options` (or set `SAMEORIGIN`); in prod keep `DENY`.

## S-21 — `XSS` exposure on rendered article HTML
- `KnowledgeBase` and `Docs` render markdown server-side; verify the renderer (likely `marked` or `markdown-it`) is configured with `sanitize: true` or wraps with DOMPurify.

## S-22 — Privacy / GDPR — DSAR exports
- `compliance/gdpr/export` exists; verify the export includes:
  - call transcripts (yes per route).
  - SMS conversations (verify).
  - knowledge-base contributions (verify).
  - audit log of the user's actions (verify).

## S-23 — Federated ingest API key rotation
- Keys are revocable but there is no automatic expiry / rotation policy. Long-lived keys are an enterprise audit finding. Recommend a 90/180-day mandatory rotation reminder.

## S-24 — Webhook secret reuse across providers
- A single `STRIPE_WEBHOOK_SECRET` per environment is fine for one Stripe account; if multi-account is added later, secret-per-account will be needed.

## S-25 — `process.on('uncaughtException')` continues to serve traffic during shutdown
- `start.ts` calls `gracefulShutdown('uncaughtException')` on uncaught — but `server.close` does not interrupt in-flight requests. A poisoned request (e.g. a downstream library throwing on a malformed payload) keeps the process alive longer than the SIGTERM grace window.
- Fix: increase log fidelity on uncaught and `process.exit(1)` after a short timeout.
