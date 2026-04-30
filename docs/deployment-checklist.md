# Quality Voice Operations — Production Deployment Checklist

## 1. Environment Variables

### Required (all environments)

| Variable | Purpose | Source | Example |
|---|---|---|---|
| `APP_ENV` | Environment selector | Set manually | `production` |
| `OPENAI_API_KEY` | OpenAI Realtime API key for voice AI | OpenAI Dashboard > API Keys | `sk-...` |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | Twilio Console > Account Info | `AC...` |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | Twilio Console > Account Info | `...` |
| `TWILIO_OUTBOUND_NUMBER` | Default outbound caller ID (E.164) | Twilio Console > Phone Numbers | `+1234567890` |
| `ADMIN_JWT_SECRET` | JWT signing secret for admin API auth | Generate: `openssl rand -base64 48` | Random 64+ char string |
| `CONNECTOR_ENCRYPTION_KEY` | 32-byte hex key for encrypting tenant secrets | Generate: `openssl rand -hex 32` | 64 hex characters |

### Required (production/staging only)

| Variable | Purpose | Source | Example |
|---|---|---|---|
| `PLATFORM_DB_POOL_URL` | Supabase transaction pooler URL (port 6543, SSL) | Supabase Dashboard > Project Settings > Database > Connection string (Transaction pooler) | `postgresql://user:pass@host:6543/db` |
| `STRIPE_SECRET_KEY` | Stripe API secret key (live key for production) | Stripe Dashboard > Developers > API keys | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | Stripe Dashboard > Developers > Webhooks > Signing secret | `whsec_...` |
| `STRIPE_PRICE_STARTER_MONTHLY` | Stripe Price ID for Starter monthly plan | Stripe Dashboard > Products > Price ID | `price_...` |
| `STRIPE_PRICE_STARTER_ANNUAL` | Stripe Price ID for Starter annual plan | Stripe Dashboard > Products > Price ID | `price_...` |
| `STRIPE_PRICE_PRO_MONTHLY` | Stripe Price ID for Pro monthly plan | Stripe Dashboard > Products > Price ID | `price_...` |
| `STRIPE_PRICE_PRO_ANNUAL` | Stripe Price ID for Pro annual plan | Stripe Dashboard > Products > Price ID | `price_...` |
| `STRIPE_PRICE_ENTERPRISE_MONTHLY` | Stripe Price ID for Enterprise monthly plan | Stripe Dashboard > Products > Price ID | `price_...` |
| `STRIPE_PRICE_ENTERPRISE_ANNUAL` | Stripe Price ID for Enterprise annual plan | Stripe Dashboard > Products > Price ID | `price_...` |
| `STRIPE_METER_EVENT_CALLS` | Stripe meter event name for call usage | Stripe Dashboard > Billing > Meters | `call_minutes` |
| `STRIPE_METER_EVENT_AI_MINUTES` | Stripe meter event name for AI minute usage | Stripe Dashboard > Billing > Meters | `ai_minutes` |
| `VOICE_GATEWAY_BASE_URL` | Public URL of the voice gateway | Your deployment domain | `https://your-domain.replit.app:3001` |
| `ADMIN_API_BASE_URL` | Public URL of the admin API | Your deployment domain | `https://your-domain.replit.app:3002` |
| `VITE_BOOK_DEMO_SCHEDULER_URL` | Embedded scheduler URL used by the public `/book-demo` page. Must be set at **build time** (Vite inlines `VITE_*` vars). Enforced by `scripts/validate-env.ts` and Admin API startup — missing in production = hard fail. | Cal.com event link or Calendly link | `https://cal.com/qvo/30min` |
| `CALCOM_WEBHOOK_SECRET` | HMAC-SHA256 secret used by both the Cal.com adapter route (`/book-demo/calcom-native-webhook`, where Cal.com itself posts) and the canonical envelope verifier (`/book-demo/calendar-webhook`, which the adapter forwards to with a synthesized `t=<unix>,v1=<hex>` envelope). **Production rejects all unsigned requests** (no `CALCOM_WEBHOOK_ALLOW_UNSIGNED` escape hatch outside dev). Enforced by `scripts/validate-env.ts` and Admin API startup. | Cal.com Webhook config (see §5) | Random 32+ char secret |
| `CALENDLY_WEBHOOK_SECRET` | HMAC-SHA256 signing key used to verify the `Calendly-Webhook-Signature` header on `/book-demo/calendly-webhook`. The endpoint **rejects all unsigned requests in production** (no `CALENDLY_WEBHOOK_ALLOW_UNSIGNED` escape hatch outside dev). **Required only when `BOOK_DEMO_SCHEDULER_PROVIDER` (or `VITE_BOOK_DEMO_SCHEDULER_PROVIDER`) is `calendly`.** `scripts/validate-env.ts` and Admin API startup add this to the missing-vars list when the provider is Calendly so production builds fail closed without it. | Calendly Webhook signing key (returned by `POST /webhook_subscriptions`, see §5) | Random 32+ char secret |
| `SALES_NOTIFICATION_EMAIL` | Default inbox that receives "new demo lead" and "booking created/rescheduled/cancelled" notifications from `marketing-leads.ts`. Platform admins can override this list and the channels (email/Slack) at runtime via **Admin → Sales Inbox → Alert settings** (persisted in `platform_settings.sales_alert_settings`). The in-app `marketing_leads.notified` flag ensures each lead is alerted at most once. Enforced by `scripts/validate-env.ts` and Admin API startup so demo leads are never silently dropped. | Your sales / SDR distribution list | `sales@yourdomain.com` |

### Required (development only)

| Variable | Purpose | Source | Example |
|---|---|---|---|
| `DATABASE_URL` | Local PostgreSQL connection string | Auto-set by Replit | `postgresql://...` |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_API_PORT` | `3002` | Admin API listen port |
| `VOICE_GATEWAY_PORT` | `3001` | Voice gateway listen port |
| `PORT` | `5000` (prod) | Generic port fallback |
| `LOG_LEVEL` | `info` | Logging level: debug, info, warn, error |
| `BUILD_VERSION` | `local` | Build identifier for observability |
| `TWILIO_COST_PER_MINUTE_CENTS` | `2` | Twilio cost per minute (cents) for usage metering |
| `AI_COST_PER_MINUTE_CENTS` | `6` | AI cost per minute (cents) for usage metering |
| `SMS_COST_PER_MESSAGE_CENTS` | `1` | SMS cost per message (cents) for usage metering |
| `VOICE_GATEWAY_STREAM_TOKEN` | none | Optional bearer token for WebSocket stream auth |
| `CAMPAIGN_TENANT_MAX_CONCURRENT` | `5` | Max concurrent outbound calls per tenant |
| `DISABLE_PHI_LOGGING` | `false` | Set to `true` to redact phone numbers from logs |
| `ADMIN_INTERNAL_TOKEN` | none | Internal bearer token for inter-service calls |
| `VITE_BOOK_DEMO_SCHEDULER_PROVIDER` | `cal.com` | Set to `calendly` to switch the `/book-demo` embed and prefill semantics. Must be set at build time. |
| `BOOK_DEMO_SCHEDULER_PROVIDER` | falls back to `VITE_BOOK_DEMO_SCHEDULER_PROVIDER` | Server-readable mirror used by `scripts/validate-env.ts` to decide whether `CALENDLY_WEBHOOK_SECRET` is required. Set this **alongside** the `VITE_*` variant in production deployments where the build happens in a separate environment from the runtime, so the validator running on the API host can still see the choice. |
| `CALCOM_WEBHOOK_ALLOW_UNSIGNED` | unset | **Dev/staging only.** Set to `1` to accept unsigned `/book-demo/calendar-webhook` requests when `CALCOM_WEBHOOK_SECRET` is not configured. Has no effect when `NODE_ENV=production` or `APP_ENV=production` — production always fails closed. |
| `CALENDLY_WEBHOOK_SECRET` | unset | **Required when `VITE_BOOK_DEMO_SCHEDULER_PROVIDER=calendly`.** HMAC-SHA256 signing key used to verify the `Calendly-Webhook-Signature` header on either `/book-demo/calendar-webhook` (the unified endpoint) or `/book-demo/calendly-webhook` (the dedicated endpoint). Same fail-closed behaviour as `CALCOM_WEBHOOK_SECRET`. See §5. |
| `CALENDLY_WEBHOOK_TOLERANCE_SECONDS` | `300` | Replay-protection window for Calendly signatures. Signatures with a `t=` timestamp outside this many seconds (past or future) are rejected. Bump only if you have unavoidable clock skew. |
| `CALENDLY_WEBHOOK_ALLOW_UNSIGNED` | unset | **Dev/staging only.** Set to `1` to accept unsigned Calendly webhook requests when `CALENDLY_WEBHOOK_SECRET` is not configured. Has no effect when `NODE_ENV=production` or `APP_ENV=production` — production always fails closed. |
| `SALES_EMAIL` | none | Legacy fallback for `SALES_NOTIFICATION_EMAIL`. Prefer the latter. |
| `OPS_SLACK_WEBHOOK_URL` | none | Default Slack incoming-webhook URL used for sales-alert messages when the in-app Slack channel is enabled and no per-instance webhook override has been configured in **Admin → Sales Inbox → Alert settings**. |
| `STRIPE_PRICE_STARTER_AI_MINUTES` / `STRIPE_PRICE_PRO_AI_MINUTES` / `STRIPE_PRICE_ENTERPRISE_AI_MINUTES` | unset | Stripe metered Price ID for the per-minute AI overage on each tier. When set, `GET /billing/upgrade-preview` quotes the overage rate from the Stripe price (sub-cent precision via `unit_amount_decimal`) so the upgrade card matches what Stripe will actually invoice. When unset, the endpoint falls back to the catalog rate in `shared/billing/planCatalog.ts`. Configure these alongside `STRIPE_METER_EVENT_AI_MINUTES` once per-tier metered prices exist in Stripe. |
| `PLATFORM_ADMIN_BASE_URL` | falls back to `ADMIN_PUBLIC_URL` → `APP_PUBLIC_URL` → `ADMIN_API_BASE_URL` | Public origin used to build deep links inside sales-alert emails / Slack messages (e.g. `https://app.example.com/admin/sales-inbox#lead-42`). Set this to the URL admins use to reach the SPA, not the raw API origin, when those differ. |

## 2. Pre-deployment Validation

Run the environment validation script before deploying:

```bash
APP_ENV=production npx tsx scripts/validate-env.ts
```

This checks all required variables are set and validates the database connection.

The validation also runs automatically on server startup. In production, it will **exit the process** if any required variable is missing.

## 3. Database Setup (Supabase)

### Connection String

Use the **transaction pooler** connection string (port 6543), not the direct connection (port 5432) or session pooler (port 5432).

```
postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

Set this as `PLATFORM_DB_POOL_URL`.

### SSL Configuration

The platform automatically enables SSL with `rejectUnauthorized: false` for non-development environments. No additional SSL configuration is needed.

### Running Migrations

```bash
APP_ENV=production PLATFORM_DB_POOL_URL="your-url" npx tsx scripts/run-migrations.ts
```

All 28 migrations have been validated to apply cleanly from a fresh database.

### Supabase-Specific Notes

- **Transaction pooler (port 6543)**: Required for connection pooling. The platform uses short-lived connections that work well with PgBouncer in transaction mode.
- **Session pooler (port 5432)**: Not needed. The platform does not use `SET` commands that persist across transactions (tenant context is set per-transaction via `set_config(..., true)`).
- **RLS compatibility**: The platform sets `app.tenant_id` via `set_config('app.tenant_id', $1, true)` (transaction-scoped). This works correctly with the transaction pooler.
- **Direct connection**: Only needed for running migrations if the pooler has issues. Migrations use `CREATE TABLE`, `ALTER TABLE`, etc. which work fine through the transaction pooler.

### Seeding Admin User

After migrations, seed the initial platform admin:

```bash
APP_ENV=production PLATFORM_DB_POOL_URL="your-url" \
  ADMIN_EMAIL="admin@yourdomain.com" \
  ADMIN_PASSWORD="YourSecurePassword" \
  npx tsx scripts/seed-admin.ts
```

### One-off Backfill: `retry_skipped_reason`

After `migrations/072_retry_skipped_reason.sql` is applied, run the one-off
backfill script once per environment to stamp historical hard-bounce rows in
`support_ticket_replies`, `support_tickets`, and `docs_feedback_replies`. The
script uses the same server-side `isPermanentSmtpError` classifier the live
write paths use, so older rows get the same authoritative `retry_skipped_reason`
value the admin "Hard bounce — won't auto-retry" badge now reads from.

```bash
# Optional dry-run first to see how many rows would be touched.
APP_ENV=production PLATFORM_DB_POOL_URL="your-url" \
  npx tsx scripts/backfill-retry-skipped-reason.ts --dry-run

# Real run.
APP_ENV=production PLATFORM_DB_POOL_URL="your-url" \
  npx tsx scripts/backfill-retry-skipped-reason.ts
```

The script is idempotent — it only touches rows where `retry_skipped_reason IS
NULL AND email_error IS NOT NULL`, so re-runs are no-ops once the historical
set has been stamped.

## 4. Deployment Configuration

### Build Step

The build step should compile TypeScript and build the Vite frontend:

```bash
npx tsc --noEmit && npx vite build --config client-app/vite.config.ts
```

This produces the client bundle in `client-app/dist/`.

### Run Step

The production run command starts both servers:

```bash
APP_ENV=production npx tsx server/admin-api/start.ts & APP_ENV=production npx tsx server/voice-gateway/start.ts & wait
```

In production, the Admin API serves the pre-built Vite frontend from `client-app/dist/` as static files (with SPA fallback to `index.html`).

Both servers run `validateEnvironment({ exitOnFailure: true })` at startup in production — if any required env var is missing, the process exits immediately.

### Port Mappings

| Service | Internal Port | Purpose |
|---|---|---|
| Admin API | 3002 | REST API + static frontend |
| Voice Gateway | 3001 | Twilio webhooks + WebSocket streams |
| Vite dev server | 5000 | Development only (not used in production) |

In production, the Vite dev server is NOT started. The Admin API serves the frontend directly.

### Current `.replit` Deployment Configuration

The `.replit` file currently configures:
- `[deployment].build`: `npx tsc --noEmit` (type-check only)
- `[deployment].run`: Vite build + start both servers (combined in run step)
- `[deployment].deploymentTarget`: `vm`
- Port 80 (external) maps to port 5000 (internal) for the main web preview
- Ports 3001 and 3002 are exposed directly
- `[userenv.production]` sets `APP_ENV=production` and `PORT=5000`

To optimize the deployment, move the Vite build from the run step to the build step so the frontend is pre-built during deployment compilation rather than at runtime start.

## 5. Webhook Configuration

### Twilio Webhooks

Configure these webhook URLs in the Twilio console for each phone number:

| Webhook | URL | Method |
|---|---|---|
| Voice (incoming call) | `https://{VOICE_GATEWAY_BASE_URL}/twilio/voice` | POST |
| Status callback | `https://{VOICE_GATEWAY_BASE_URL}/twilio/status` | POST |
| SMS (incoming) | `https://{VOICE_GATEWAY_BASE_URL}/twilio/sms` | POST |

For outbound campaigns, the system uses:
- `{VOICE_GATEWAY_BASE_URL}/twilio/outbound` as the TwiML endpoint
- `{VOICE_GATEWAY_BASE_URL}/twilio/status` as the status callback

### Stripe Webhooks

Register a webhook endpoint in the Stripe dashboard:

| Setting | Value |
|---|---|
| Endpoint URL | `https://{ADMIN_API_BASE_URL}/billing/stripe-webhook` |
| API version | `2026-02-25.clover` |

Subscribe to these events:

- `checkout.session.completed`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `customer.subscription.deleted`
- `customer.subscription.updated`

Copy the webhook signing secret to `STRIPE_WEBHOOK_SECRET`.

### Stripe Metered Billing Setup

1. Create a **Meter** in Stripe for call usage (name it to match `STRIPE_METER_EVENT_CALLS`)
2. Create a **Meter** in Stripe for AI minutes (name it to match `STRIPE_METER_EVENT_AI_MINUTES`)
3. Create **Price** objects for each plan tier (starter/pro/enterprise) and interval (monthly/annual)
4. Set the Price IDs as `STRIPE_PRICE_{TIER}_{INTERVAL}` environment variables

### Cal.com Webhook (Book a Demo)

The public `/book-demo` page embeds an external scheduler (Cal.com by default, optionally Calendly) and the Admin API exposes `POST /book-demo/calendar-webhook` so the booking lifecycle is mirrored back into the marketing-leads tables and forwarded to the sales inbox.

**Required env vars** (see §1):

- `VITE_BOOK_DEMO_SCHEDULER_URL` — the embed URL (e.g. `https://cal.com/qvo/30min`). Must be present at **`vite build` time** because `VITE_*` vars are inlined into the client bundle. Rebuild and redeploy after changing it.
- `VITE_BOOK_DEMO_SCHEDULER_PROVIDER` *(optional)* — set to `calendly` to switch the embed semantics; defaults to `cal.com`.
- `CALCOM_WEBHOOK_SECRET` — HMAC-SHA256 secret. Used by both the Cal.com adapter route (which authenticates Cal.com's native body-only `X-Cal-Signature-256` header) and the canonical envelope verifier the adapter forwards into. **Production rejects every request that lacks a valid signature**; missing secret returns HTTP 500.
- `CALENDLY_WEBHOOK_SECRET` *(required only when running on Calendly)* — HMAC-SHA256 signing key. **Production rejects every request that lacks a valid `Calendly-Webhook-Signature` header**; missing secret returns HTTP 500.
- `SALES_NOTIFICATION_EMAIL` — sales inbox that receives lead-capture and booking lifecycle emails. When unset, lead capture still succeeds but no email is sent (a debug log is emitted).

> **Don't rely on a manual checklist for these.** The Cal.com / sales-email vars are listed in `scripts/validate-env.ts` as production-required, and `CALENDLY_WEBHOOK_SECRET` is added to the missing-vars list when `BOOK_DEMO_SCHEDULER_PROVIDER` (or `VITE_BOOK_DEMO_SCHEDULER_PROVIDER`) is `calendly`. So `APP_ENV=production npx tsx scripts/validate-env.ts` (see §2) and Admin API startup will both exit non-zero if any required value is missing. Run the validator before promoting a build instead of eyeballing this section.
>
> **Runtime override via the admin panel.** The `provider`, `embedUrl`, and both webhook secrets can also be configured at runtime from **Sales Inbox → Demo scheduler** (powered by `platform_settings.demo_scheduler` and exposed at `GET /api/platform/demo-scheduler-settings` / `PUT /api/platform/demo-scheduler-settings`). Switching provider in the UI takes effect on the next `/book-demo` page load — the public client now fetches `GET /api/book-demo/config` at runtime instead of reading `import.meta.env`. Webhook secrets stored via the panel are AES-256-GCM-encrypted at rest (KEK derived from `ENCRYPTION_MASTER_KEY` / `CONNECTOR_ENCRYPTION_KEY` via scrypt). The verifier resolves each secret as **`process.env.<NAME>` first, falling back to the DB-stored value only when the env var is empty** (so existing deployments keep their current behaviour). A deployment can therefore omit `CALCOM_WEBHOOK_SECRET` / `CALENDLY_WEBHOOK_SECRET` from the env entirely *and* save the secret through the admin panel — but `validate-env.ts` only sees env vars, so when running on Calendly with a DB-only secret you will need to set `CALENDLY_WEBHOOK_SECRET=db-managed` (or any non-empty placeholder) just to silence the validator. To rotate a secret managed in the panel, **clear the env var first** and then save the new value through the admin panel; otherwise the env value continues to win.

#### Step 1 — Create the webhook in Cal.com

1. In Cal.com, go to **Settings → Developer → Webhooks → New Webhook**.
2. **Subscriber URL**: `https://{ADMIN_API_BASE_URL}/book-demo/calcom-native-webhook`
   - This is the **Admin API** host (port 3002 / your public Admin domain), **not** the voice gateway.
   - Use the **`/calcom-native-webhook` adapter URL — not** `/calendar-webhook`. Cal.com's webhook signer covers only the raw body and does not include a timestamp header, so a delivery sent straight to `/calendar-webhook` is rejected with `401 "Missing timestamp"` by the canonical replay-protected verifier. The `/calcom-native-webhook` adapter authenticates the native body-only signature, re-stamps with the current Unix time, re-signs as `t=<unix>,v1=HMAC(secret,"<t>.<body>")`, and then hands the request to the canonical verifier — so the strict 5-minute replay window is preserved end-to-end while still accepting Cal.com's native delivery format.
3. **Event Triggers** — subscribe to all three:
   - `BOOKING_CREATED`
   - `BOOKING_RESCHEDULED`
   - `BOOKING_CANCELLED`
4. **Secret**: paste the value of `CALCOM_WEBHOOK_SECRET`. Generate one with `openssl rand -hex 32` if you do not already have one stored.
5. Set **Payload Template** to *Default* (the route parses the standard Cal.com envelope `{ triggerEvent, payload: { uid, attendees, organizer, metadata, ... } }`).
6. Save and use Cal.com's **Send Test** button to fire a sample `BOOKING_CREATED`. A `200 OK` confirms signature verification works.

> **Smoke test (record this in the rollout notes).** After saving the webhook,
> click **Send Test** in Cal.com and tail the Admin API logs:
> `200 OK` plus a `Cal.com webhook processed` log line means the adapter
> verified the native signature, re-signed with the envelope, and the
> canonical verifier accepted the forwarded request. If you instead see
> `401 "Missing timestamp"` the webhook is still pointed at the legacy
> `/calendar-webhook` URL — switch it to `/calcom-native-webhook`. The
> deployment is only considered green once a real Cal.com test booking
> shows up against a marketing lead in the sales inbox.

#### Step 2 — Calendly alternative (optional)

The same `/book-demo/calendar-webhook` endpoint accepts Calendly's signed payloads — it picks the right verifier by inspecting the request headers, so the public webhook URL is identical regardless of provider. A dedicated `/book-demo/calendly-webhook` route is also exposed for deployments that want a Calendly-only endpoint (same verifier, same lifecycle mapping); both URLs are fully supported and either can be pasted into Calendly's `webhook_subscriptions` API.

**Required env vars** for Calendly (in addition to the embed URL above):

- `VITE_BOOK_DEMO_SCHEDULER_PROVIDER=calendly` — switches the embed semantics. Must be set at **`vite build` time** (the value is inlined into the client bundle); rebuild and redeploy after changing it.
- `BOOK_DEMO_SCHEDULER_PROVIDER=calendly` — server-readable mirror so `scripts/validate-env.ts` and `assertProductionSecrets()` can require `CALENDLY_WEBHOOK_SECRET` even when the build environment differs from the runtime. Set this **alongside** the `VITE_*` variant on the Admin API host.
- `VITE_BOOK_DEMO_SCHEDULER_URL` — the public Calendly event link (e.g. `https://calendly.com/qvo/30min`).
- `CALENDLY_WEBHOOK_SECRET` — HMAC-SHA256 signing key. **Production rejects every request that lacks a valid `Calendly-Webhook-Signature` header**; missing secret returns HTTP 500.
- `CALENDLY_WEBHOOK_TOLERANCE_SECONDS` *(optional, default 300)* — replay-protection window in seconds. Signatures older than this are rejected.

> Calendly's signature header is `Calendly-Webhook-Signature: t=<unix_seconds>,v1=<hex_hmac>`. Our verifier computes `HMAC_SHA256(secret, "<t>.<raw_body>")` and rejects timestamps outside the tolerance window. There is a `CALENDLY_WEBHOOK_ALLOW_UNSIGNED=1` dev escape hatch that mirrors the Cal.com one — it is ignored in production.

##### Create the Calendly webhook subscription

Calendly does not have a "click to add a webhook" page in the dashboard — you create the subscription with their API. With your Calendly **personal access token** (Settings → Integrations → API & webhooks → Generate new token) and your **organization URI** (`GET https://api.calendly.com/users/me`):

```bash
CALENDLY_TOKEN=...                # personal access token
CALENDLY_ORG_URI=https://api.calendly.com/organizations/AAAAAA  # from /users/me
SECRET=$(openssl rand -hex 32)    # set this as CALENDLY_WEBHOOK_SECRET
ADMIN_API_BASE_URL=https://admin.example.com

curl -X POST https://api.calendly.com/webhook_subscriptions \
  -H "Authorization: Bearer $CALENDLY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"$ADMIN_API_BASE_URL/book-demo/calendar-webhook\",
    \"events\": [\"invitee.created\", \"invitee.canceled\"],
    \"organization\": \"$CALENDLY_ORG_URI\",
    \"scope\": \"organization\",
    \"signing_key\": \"$SECRET\"
  }"
```

> If you prefer the dedicated path, swap `/book-demo/calendar-webhook` for `/book-demo/calendly-webhook` in the `url` field — both endpoints share the same verifier and lifecycle mapping.

Set `CALENDLY_WEBHOOK_SECRET=$SECRET` in the Admin API environment and restart so the verifier picks it up. `events` only needs `invitee.created` and `invitee.canceled`; reschedules ride on `invitee.created` with `payload.rescheduled === true` so the verifier maps them to the `rescheduled` lifecycle. For a user-scoped subscription, swap `"scope": "organization"` for `"scope": "user"` and add `"user": "<user uri>"`. To confirm the subscription is active, run `curl -H "Authorization: Bearer $CALENDLY_TOKEN" "https://api.calendly.com/webhook_subscriptions?organization=$CALENDLY_ORG_URI"` and look for `state: "active"`. To rotate the signing key later, delete the subscription (`DELETE /webhook_subscriptions/<uuid>`), generate a new secret, redeploy with the new `CALENDLY_WEBHOOK_SECRET`, and re-create the subscription.

##### Calendly event mapping

| Calendly event | Our `eventType` | Notes |
|---|---|---|
| `invitee.created` | `created` | Standard new booking. |
| `invitee.created` with `payload.rescheduled === true` | `rescheduled` | The dedicated `/book-demo/calendly-webhook` route promotes these to `rescheduled` so the sales inbox lifecycle matches Cal.com's `BOOKING_RESCHEDULED`. The unified `/book-demo/calendar-webhook` route also stores them as part of the same lead row (Calendly normally fires `invitee.canceled` for the old slot first). |
| `invitee.canceled` | `cancelled` | Triggers the "Demo cancelled" sales-inbox alert. |

The lead is resolved by the `utm_content=lead-<id>` query string that `client-app/src/pages/public/BookDemo.tsx` already appends to the Calendly embed URL. We fall back to invitee email lookup if the tracking parameter is missing.

#### Step 3 — Verify end to end

1. Visit `https://{ADMIN_API_BASE_URL}/book-demo`, fill the form, and submit. The page should land on the embedded scheduler. Confirm the sales inbox receives the "new demo lead" email.
2. Pick a slot in the embed.
   - **Cal.com:** fires `BOOKING_CREATED`; check the Admin API logs for `Cal.com webhook processed` (rejections show up as `Cal.com webhook rejected`) and confirm a "booking created" email arrives.
   - **Calendly:** fires `invitee.created`; check the Admin API logs for `Calendly webhook processed` (rejections show up as `Calendly webhook rejected`) and confirm a "booking created" email arrives. The `tracking.utm_content=lead-<id>` round-tripped from `BookDemo.tsx` should appear in the log line so you know the booking attached to the right lead row.
3. From the scheduler dashboard, reschedule and cancel the test booking — the corresponding lifecycle emails should follow. (Calendly sends `invitee.canceled` for the old slot and another `invitee.created` with `payload.rescheduled === true` for the new slot.)
4. If you see `401 Invalid signature`, double-check that the secret pasted into the scheduler webhook config matches `CALCOM_WEBHOOK_SECRET` / `CALENDLY_WEBHOOK_SECRET` exactly (no trailing whitespace).
5. If you see `500 Webhook secret not configured`, the env var is missing or empty — set it and restart the Admin API.
6. If a Calendly delivery returns `401 Signature timestamp out of tolerance`, your server clock is skewed by more than 5 minutes — fix NTP or bump `CALENDLY_WEBHOOK_TOLERANCE_SECONDS`.

#### Local / staging testing

For local development without a real Cal.com or Calendly webhook, you can either:

- Use the scheduler's built-in webhook tester pointed at an `ngrok` tunnel of the Admin API, **or**
- Set `CALCOM_WEBHOOK_ALLOW_UNSIGNED=1` / `CALENDLY_WEBHOOK_ALLOW_UNSIGNED=1` (each only honoured when both `NODE_ENV` and `APP_ENV` are non-production) and POST a hand-crafted JSON envelope. **Never set these in production** — the verifiers deliberately ignore them there.

> **Calendly local-testing gotcha (unified endpoint only).** Provider routing on `/book-demo/calendar-webhook` keys off the request headers: a request only enters the Calendly handler when a `Calendly-Webhook-Signature` header is present (otherwise the request falls through to the Cal.com handler, which will reject it). So even with `CALENDLY_WEBHOOK_ALLOW_UNSIGNED=1`, your hand-crafted curl against the unified endpoint must still include a placeholder header, e.g. `-H 'Calendly-Webhook-Signature: t=1,v1=ignored'`. The dedicated `/book-demo/calendly-webhook` route does not require this since it always parses Calendly's envelope.

## 6. Post-Deployment Verification

1. Check server health: `curl https://{ADMIN_API_BASE_URL}/health`
2. Verify environment validation passed in logs (no `FAIL` lines)
3. Confirm migration count matches (28 migrations)
4. Log in with the seeded admin account
5. Make a test inbound call to verify the voice gateway
6. Check the analytics dashboard loads correctly
7. Verify Stripe webhook delivery in the Stripe dashboard

## 7. Security Checklist

- [ ] `ADMIN_JWT_SECRET` is a unique, randomly generated string (64+ characters)
- [ ] `CONNECTOR_ENCRYPTION_KEY` is 32 random bytes (64 hex chars): `openssl rand -hex 32`
- [ ] `STRIPE_SECRET_KEY` is a live key (not `sk_test_...`) for production
- [ ] `ADMIN_PASSWORD` for the seed admin is strong and stored securely
- [ ] `DISABLE_PHI_LOGGING` is set to `true` in production
- [ ] All Twilio webhook URLs use HTTPS
- [ ] Stripe webhook signing secret is configured and verified
- [ ] `CALCOM_WEBHOOK_SECRET` is set (and matches the secret pasted into the Cal.com webhook config) — verifier fails closed in production. Confirmed by `scripts/validate-env.ts` / Admin API startup (no manual review needed).
- [ ] *(Calendly only)* `CALENDLY_WEBHOOK_SECRET` is set (and matches the `signing_key` registered with Calendly's `POST /webhook_subscriptions` API) — verifier fails closed in production. Confirmed by `scripts/validate-env.ts` and `assertProductionSecrets()` (both add this var to the missing-vars list when `BOOK_DEMO_SCHEDULER_PROVIDER`/`VITE_BOOK_DEMO_SCHEDULER_PROVIDER` is `calendly`).
- [ ] `SALES_NOTIFICATION_EMAIL` points at a monitored sales inbox so demo leads and bookings are not silently dropped. Confirmed by `scripts/validate-env.ts` / Admin API startup.
- [ ] `VITE_BOOK_DEMO_SCHEDULER_URL` was set **before** running the production `vite build` (re-run the build if you change it later). Confirmed by `scripts/validate-env.ts` — run it as part of the pre-build step.

## 8. Migration Validation Record

All 28 migrations have been validated to apply cleanly from a completely empty database (fresh `public` schema with no tables).

To reproduce:

```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
npx tsx scripts/run-migrations.ts
```

Expected output: all 28 files (001_tenants.sql through 028_add_welcome_greeting.sql) apply with `DONE` status and "All migrations complete." at the end.

Last validated: 2026-03-15 (Task #27 deployment readiness audit).

## 9. Demo System Setup

The demo system allows prospective customers to try the platform by calling live AI agents without signing up.

### Prerequisites

- Demo tenant and agents are seeded via `scripts/seed-demo.ts`
- Two Twilio phone numbers provisioned for demo use

### Step 1: Seed Demo Data

```bash
npx tsx scripts/seed-demo.ts
```

This creates:
- A `demo` tenant with enterprise plan and unlimited limits
- Two demo agents: Answering Service (voice: sage) and Medical After-Hours (voice: shimmer)
- Placeholder phone numbers `+15550000001` and `+15550000002` with routing to the agents
- Entries in the `demo_agents` table for the demo page display

### Step 2: Provision Real Twilio Numbers

1. Purchase two phone numbers in the Twilio Console
2. Update the demo phone numbers in the database:

```sql
UPDATE phone_numbers SET phone_number = '+1XXXXXXXXXX'
WHERE tenant_id = 'demo' AND friendly_name LIKE '%Answering%';

UPDATE phone_numbers SET phone_number = '+1XXXXXXXXXX'
WHERE tenant_id = 'demo' AND friendly_name LIKE '%Medical%';
```

3. Configure Twilio webhooks for each number:
   - Voice URL: `https://{VOICE_GATEWAY_BASE_URL}/twilio/voice` (POST)
   - Status callback: `https://{VOICE_GATEWAY_BASE_URL}/twilio/status` (POST)

### Step 3: Verify

1. Visit the `/demo` page — it should show the real phone numbers (not placeholder text)
2. Call either number — the AI agent should answer with the demo greeting
3. Check `/api/demo/stats` — the `totalCalls` counter should increment
4. Check `/api/demo/activity` — call events should appear in the feed

### Demo Call Flow

1. Caller dials the demo phone number
2. Twilio sends a webhook to `/twilio/voice`
3. The voice gateway looks up the phone number routing and finds the demo tenant + agent
4. Rate limiter checks: max 5 calls per hour per IP address
5. If allowed, `demo_call_count` on the tenant is incremented
6. A WebSocket stream is established between Twilio and OpenAI Realtime API
7. The AI agent (Aria) greets the caller and handles the conversation
8. On call completion, call session and events are written to the database
9. The demo activity feed shows the call events in real time (polls every 5s)

### Rate Limiting

- Demo calls are rate limited to **5 calls per hour** per caller IP address
- When exceeded, callers hear: "Thank you for your interest in Voice AI. You have reached the maximum number of demo calls per hour. Please try again later."
- The demo API endpoints (`/demo/activity`, `/demo/stats`, `/demo/phones`) are also rate limited to 30 requests per minute per IP

### Error Handling

- If the demo tenant is missing, `/demo/phones` returns `{ configured: false, phones: [] }` and the demo page shows a yellow banner
- If phone numbers are still placeholder (555) numbers, the page shows "awaiting real number" with instructions to contact the administrator
- If the voice gateway has no routing for a number, callers hear: "This number is not currently configured. Goodbye."
