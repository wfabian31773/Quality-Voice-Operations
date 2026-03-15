# Quality Voice Operations — Production Deployment Checklist

## 1. Environment Variables

### Required (all environments)

| Variable | Purpose | Example |
|---|---|---|
| `APP_ENV` | Environment selector | `production` |
| `OPENAI_API_KEY` | OpenAI Realtime API key for voice AI | `sk-...` |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | `AC...` |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | `...` |
| `TWILIO_OUTBOUND_NUMBER` | Default outbound caller ID (E.164) | `+1234567890` |
| `ADMIN_JWT_SECRET` | JWT signing secret for admin API auth | Random 64+ char string |
| `CONNECTOR_ENCRYPTION_KEY` | 32-byte hex key for encrypting tenant secrets | 64 hex characters |

### Required (production/staging only)

| Variable | Purpose | Example |
|---|---|---|
| `PLATFORM_DB_POOL_URL` | Supabase transaction pooler URL (port 6543, SSL) | `postgresql://user:pass@host:6543/db` |
| `STRIPE_SECRET_KEY` | Stripe API secret key (live key for production) | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | `whsec_...` |
| `STRIPE_PRICE_STARTER_MONTHLY` | Stripe Price ID for Starter monthly plan | `price_...` |
| `STRIPE_PRICE_STARTER_ANNUAL` | Stripe Price ID for Starter annual plan | `price_...` |
| `STRIPE_PRICE_PRO_MONTHLY` | Stripe Price ID for Pro monthly plan | `price_...` |
| `STRIPE_PRICE_PRO_ANNUAL` | Stripe Price ID for Pro annual plan | `price_...` |
| `STRIPE_PRICE_ENTERPRISE_MONTHLY` | Stripe Price ID for Enterprise monthly plan | `price_...` |
| `STRIPE_PRICE_ENTERPRISE_ANNUAL` | Stripe Price ID for Enterprise annual plan | `price_...` |
| `STRIPE_METER_EVENT_CALLS` | Stripe meter event name for call usage | `call_minutes` |
| `STRIPE_METER_EVENT_AI_MINUTES` | Stripe meter event name for AI minute usage | `ai_minutes` |
| `VOICE_GATEWAY_BASE_URL` | Public URL of the voice gateway | `https://your-domain.replit.app:3001` |
| `ADMIN_API_BASE_URL` | Public URL of the admin API | `https://your-domain.replit.app:3002` |

### Required (development only)

| Variable | Purpose | Example |
|---|---|---|
| `DATABASE_URL` | Local PostgreSQL connection string | `postgresql://...` (auto-set by Replit) |

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

## 4. Deployment Configuration

### Build Step

The build step compiles TypeScript (type-check only) and builds the Vite frontend:

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

### Port Mappings

| Service | Internal Port | Purpose |
|---|---|---|
| Admin API | 3002 | REST API + static frontend |
| Voice Gateway | 3001 | Twilio webhooks + WebSocket streams |
| Vite dev server | 5000 | Development only (not used in production) |

In production, the Vite dev server is NOT started. The Admin API serves the frontend directly.

### Replit Deployment

The `.replit` file configures:
- `[deployment].build`: Type-check + Vite build
- `[deployment].run`: Start both servers with `APP_ENV=production`
- Port 80 (external) maps to port 5000 (internal) for the main web preview
- Ports 3001 and 3002 are exposed directly

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
