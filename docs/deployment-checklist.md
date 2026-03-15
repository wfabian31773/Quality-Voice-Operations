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
