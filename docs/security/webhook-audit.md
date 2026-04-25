# Public Webhook Endpoint Audit

**Last reviewed:** 2026-04-25
**Scope:** Every externally-reachable HTTP route under `server/` that does **not** require an authenticated session (no `requireAuth` / `requireApiKeyOrJwt`). For each one, this document records whether it verifies a provider signature or shared secret, whether it fails closed in production, and where the test coverage lives.

The reference patterns are:

- **Twilio:** `server/voice-gateway/middleware/twilioSignature.ts` (HMAC-SHA1 on the proxied URL + form body, `X-Twilio-Signature`).
- **Stripe:** `platform/billing/stripe/webhook.ts` (`stripe.webhooks.constructEvent` against `STRIPE_WEBHOOK_SECRET`).
- **Generic shared-secret:** `server/admin-api/routes/support.ts` (`SUPPORT_INBOUND_SECRET`, header or query).

Any new public webhook **must** follow one of those three patterns and ship with a security test under `tests/security/`.

---

## 1. Provider webhooks (third-party callbacks)

| Route | File | Verification | Fail-closed in prod? | Test |
| --- | --- | --- | --- | --- |
| `POST /twilio/voice` | `server/voice-gateway/routes/twilio.ts` | `twilioSignatureMiddleware` (HMAC-SHA1, `X-Twilio-Signature`) | ✅ — returns 503 if `TWILIO_AUTH_TOKEN` unset, 403 on missing/invalid signature | `tests/security/twilioSignatureMiddleware.test.ts` |
| `POST /twilio/status` | `server/voice-gateway/routes/twilio.ts` | Same middleware (mounted via `router.use('/twilio/status', …)`) | ✅ | `tests/security/twilioSignatureMiddleware.test.ts` |
| `POST /twilio/outbound` | `server/voice-gateway/routes/twilio.ts` | Same middleware | ✅ | `tests/security/twilioSignatureMiddleware.test.ts` |
| `POST /twilio/sms` | `server/voice-gateway/routes/twilio.ts` | Same middleware | ✅ | `tests/security/twilioSignatureMiddleware.test.ts` |
| `POST /billing/stripe-webhook` | `server/admin-api/routes/billing.ts` | `constructStripeEvent` → `stripe.webhooks.constructEvent` against `STRIPE_WEBHOOK_SECRET`; raw body parser is mounted on this path only (`server/admin-api/app.ts`) | ✅ — `getWebhookSecret()` throws if `STRIPE_WEBHOOK_SECRET` is missing in production; missing/invalid signature returns 400 | `tests/security/stripeWebhook.test.ts` |
| `POST /support/inbound` | `server/admin-api/routes/support.ts` | Shared secret `SUPPORT_INBOUND_SECRET` (`X-Webhook-Secret` header **or** `?secret=` query) | ✅ — production rejects with 401 if env var unset; rejects 401 on missing/mismatched secret | `tests/security/supportInboundWebhook.test.ts` |

All true provider webhooks (Twilio, Stripe, inbound email) are covered by an explicit, fail-closed verification middleware **and** a security test in `tests/security/`. There are no unverified webhook routes as of this audit.

---

## 2. OAuth callbacks (third-party redirects, not webhooks)

These accept a redirect from the provider with `?code=…&state=…`. They are public on purpose, but `state` is signed with HMAC and bound to the original tenant/user before the `code` is exchanged for tokens. Implementations live in `server/admin-api/routes/connectorOAuth.ts`.

- `GET /connectors/oauth/hubspot/callback`
- `GET /connectors/oauth/google/callback`
- `GET /connectors/oauth/outlook/callback`
- `GET /connectors/oauth/slack/callback`
- `GET /connectors/oauth/pipedrive/callback`
- `GET /connectors/oauth/salesforce/callback`
- `GET /connectors/oauth/quickbooks/callback`

Each callback runs `verifyState(state, '<provider>')`. If the state does not parse, the HMAC fails, the provider does not match, or the timestamp is expired, the request is rejected with a 400 response that closes the popup. The corresponding `init` routes (which generate `state`) are protected by `requireAuth` + `requireRole('manager')`, so an attacker cannot mint a valid state on their own.

---

## 3. Other public endpoints (not webhooks, listed for completeness)

These are intentionally public but are **not** third-party webhooks and are out of scope for signature verification:

| Route | File | Notes |
| --- | --- | --- |
| `GET /health` (admin-api and voice-gateway) | `server/*/routes/health.ts` | Liveness probe, no secrets returned. |
| `GET /metrics` (voice-gateway) | `server/voice-gateway/routes/health.ts` | Prometheus scrape; should be reachable only inside the cluster (deployment concern, not webhook auth). |
| `POST /website-agent/chat`, `GET /website-agent/greeting` | `server/admin-api/routes/websiteAgent.ts` | Public sales-bot. Has its own in-memory rate limiter. |
| `POST /conversion/event` | `server/admin-api/routes/conversion.ts` | Public marketing analytics beacon. No sensitive write-side effects. |
| `GET /public/case-studies`, `GET /public/case-studies/:slug` | `server/admin-api/routes/caseStudies.ts` | Read-only marketing content. |
| `GET /public/subprocessors` | `server/admin-api/routes/legalCompliance.ts` | Read-only compliance content. |
| `GET /widget/public-config`, `GET /widget/embed.js` | `server/admin-api/routes/widget.ts` | Widget bootstrapping; sensitive operations live behind `validateWidgetToken`. |
| `POST /api/v1/*` | `server/admin-api/routes/publicApi.ts` | Authenticated via `requireApiKeyOrJwt` (API-key auth, not anonymous). |
| `POST /ingest/*` | `server/admin-api/routes/ingest.ts` | Authenticated via `requireApiKeyOrJwt` (API-key auth, not anonymous). |

---

## 4. Adjacent: `/twilio/stream` WebSocket

The voice gateway also exposes a WebSocket upgrade at `/twilio/stream` (`server/voice-gateway/routes/stream.ts`). It is **not** a Twilio webhook (Twilio cannot sign WS upgrades), but it is externally reachable and accepts streaming audio that is billed against tenant budgets. Authentication is via the `?token=` query parameter checked against `VOICE_GATEWAY_STREAM_TOKEN`. The same env var is used to mint the token in the TwiML `<Stream>` element returned by `/twilio/voice`, so Twilio echoes it back on the upgrade.

If `VOICE_GATEWAY_STREAM_TOKEN` is unset, both the TwiML generator and the WS validator silently no-op (development convenience). Production deployments **must** set this secret. See `docs/deployment-checklist.md` for the required env vars.

> Follow-up candidate: extend the stream validator to fail-closed in production the same way `twilioSignatureMiddleware` does, so a misconfigured deploy returns 403 instead of accepting anonymous connections. Tracked separately from this audit.

---

## 5. Checklist for adding a new public webhook

Before merging a new public webhook, confirm all of the following:

- [ ] Route mounted under a descriptive path (`/<provider>/<event>`) and uses `POST` for state-changing events.
- [ ] One of the three reference verification patterns is applied (Twilio signature, Stripe signature, shared secret).
- [ ] The verification step **throws or returns 4xx/5xx in production when its secret is missing**. Never default to "skip in prod".
- [ ] In dev (`NODE_ENV !== 'production'` and `APP_ENV !== 'production'`/`'staging'`), it is acceptable to log-and-allow when the secret is unset, but the fail-closed branch must still exist.
- [ ] A security test in `tests/security/` covers: (a) missing signature/secret, (b) tampered payload or wrong secret, (c) production-mode rejection when the env var is unset, and (d) successful path with a valid signature.
- [ ] No PHI/PII is logged on rejection — only path, remote address, and a coarse reason.
- [ ] Add the row to the table in §1 above.
