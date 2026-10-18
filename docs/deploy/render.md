# QVO on Render

**Status:** Render is the target host; **Replit stays the fallback until cutover** (and for 7 clean days after). Nothing in this repo deploys by itself: every Render service has `autoDeployTrigger: off`, and releases go through `scripts/render/deploy.ts` (dry-run by default).

Source of truth for infrastructure: [`render.yaml`](../../render.yaml) (Blueprint). Background and decisions: the Render migration plan (PR-00).

---

## 1. Service map

All services are in Blueprint project `qvo`, environment `production`, region **`virginia`** (immutable after creation).

| Render service | Type | Role (`QVO_PROCESS_ROLE`) | Start command | Health check | Instances | Shutdown delay | Custom domain |
|---|---|---|---|---|---|---|---|
| `qvo-voice` | web | `voice` | `node --import tsx server/voice-gateway/start.ts` | `/healthz` | 1, no autoscaling | **300 s** | `voice.qualityvoiceoperations.com` |
| `qvo-api` | web | `api` | `node --import tsx server/admin-api/start.ts` (pre-deploy: `npm run db:migrate`) | `/healthz` | 1, no autoscaling | 60 s | `api.qualityvoiceoperations.com` |
| `qvo-worker` | worker | `worker` | `node --import tsx server/worker/start.ts` | n/a | 1 | 120 s | — |
| `qvo-nightly` | cron `30 7 * * *` (UTC) | `cron` | `node --import tsx server/jobs/run.ts nightly` | n/a | single run | n/a | — |
| `qvo-secrets` | env group | — | Created in the Dashboard **before** the Blueprint is applied (`sync: false` is not allowed in groups) | | | | |

Build commands: `bash scripts/render/build.sh <api|voice|worker>`. Every build runs `npm ci --include=dev` (Render sets `NODE_ENV=production`, but `tsx` is a devDependency) through `scripts/ci-npm-ci.sh` (Replit lockfile-URL rewrite + retries). Only the **api** build also installs `client-app`, runs `validate:env:prod`, `verify:stripe-prices` and `vite build`. Node version: `.node-version` = `20`.

**Why `node --import tsx` and not `npx tsx`:** Render sends SIGTERM to the start command's process. `npm exec` does not forward it to the node grandchild, so with `npx tsx` the app never sees SIGTERM: the drain is skipped and the process is killed at the shutdown deadline. `node --import tsx` is one process and receives the signal directly (verified locally in PR-00).

**How the services talk:**
- Twilio and the web widget connect **directly** to `voice.qualityvoiceoperations.com` (`/twilio/*`, `/twilio/stream`, `/widget/stream`). Nothing call-related goes through `qvo-api`, so an API/UI deploy can never cut a call.
- `qvo-api`'s `/vg/*` **HTTP** proxy targets `http://${VOICE_GATEWAY_INTERNAL_HOSTPORT}` (qvo-voice's private-network `hostport`, wired with `fromService`). The `/vg` **WebSocket** proxy only exists for role `all` (Replit).

---

## 2. Process roles

`QVO_PROCESS_ROLE` = `all` (default) | `api` | `voice` | `worker` | `cron`. An unknown value fails the boot.

| Role | Where | Ports | Schedulers | Notes |
|---|---|---|---|---|
| `all` | **Replit** (`.replit` sets nothing) | admin `ADMIN_API_PORT ?? PORT ?? 3002`, voice `VOICE_GATEWAY_PORT ?? 3001` | Admin API starts the full registry, same order as before PR-00 (`SCHEDULERS_ENABLED` defaults to `all`) | `/vg` HTTP + WebSocket proxy to 127.0.0.1. **Unchanged behavior.** |
| `api` | qvo-api | `PORT` | none | |
| `voice` | qvo-voice | `PORT` | none | `VOICE_PUBLIC_BASE_URL` drives the stream URL and Twilio signature URL |
| `worker` | qvo-worker | — | registry minus nightly entries, **only while holding the leader lock**; `SCHEDULERS_ENABLED` defaults to **`none`** | |
| `cron` | qvo-nightly | — | runs `nightly` once and exits (non-zero on any failed step) | |

On Render (`RENDER=true`), `REPLIT_DEV_DOMAIN` / `REPL_ID` are removed from the environment at boot, so none of the ~20 Replit fallbacks in the code can fire, and `APP_URL` + `VOICE_GATEWAY_BASE_URL` are required for every role.

### Schedulers

Registry: [`platform/runtime/schedulers.ts`](../../platform/runtime/schedulers.ts). `SCHEDULERS_ENABLED` = `all` | `none` | comma list of the names below. The enabled list is logged at boot.

**Run by `qvo-nightly` on Render** (daily schedulers with an existing run-once function; the worker never starts their interval version):
`docs-feedback-alert`, `docs-feedback-reply-digest`, `connector-stale-alert`, `outbox-archive-sweep`, `crm-stale-cache-retention`, `call-events-retention`, `tenant-isolation`, `encryption-reminder`, `plan-recommendation-digest`, `recommendation-direction-digest`, `stripe-price-verification`, `portal-config-cleanup`, `billing-reconciliation`.

Notes on the move to a once-a-day cron:
- `stripe-price-verification` runs hourly on Replit and once a day on Render. A one-shot run has no previous status in memory, so a failing check alerts on every nightly run until fixed (instead of only on the transition).
- The `*_INTERVAL_MS` overrides of these schedulers (e.g. `BILLING_RECONCILIATION_INTERVAL_MS`) do not apply on Render; the cron schedule does.
- A nightly step fails if it throws or its result reports a failure (`portal-config-cleanup` status failure, `billing-reconciliation` errors, failed digest/reminder emails, connector snapshot load, isolation cycle error). Checks that report findings through their own alerts (tenant isolation failures, Stripe drift) still exit 0.
- Failures only visible in logs (the function swallows the error and returns a normal-looking result): `crm-stale-cache-retention`, `outbox-archive-sweep`, `docs-feedback-alert` and `docs-feedback-reply-digest` email delivery, and DB query errors in `connector-stale-alert` (ledger), `encryption-reminder` and `plan-recommendation-digest`.

**Stay in the worker** (interval schedulers, plus daily/weekly ones without an exported run-once function):
`usage-metering`, `metrics-rollup`, `system-metrics`, `usage-guardrails`, `campaigns`, `insights` (mixed 30 min–24 h timers), `call-view-digest`, `csat-expiration`, `workforce`, `gin` (daily; `runGinCycle` not exported), `milestones` (daily; not exported), `docs-feedback-reply-retry`, `support-reply-retry`, `retry-attempts-cleanup`, `connector-auth-alert`, `verified-caller-health` (weekly), `verified-caller-sync`, `trusthub-status` (weekly), `connector-outbox-drain`, `scheduling-drift-alert`, `oauth-token-refresh`, `crm-caller-identity-revalidation`, `route-export-archive-cleanup` (skipped unless `PRIVATE_OBJECT_DIR` is set), `marketplace-discount-backfill` (daily; only the lock-wrapped tick exists, not exported), `federal-dnc-sync` (weekly).

**Shop-tool schedulers: off on the Render worker until go-to-market.** Both run in the worker every 60 s once enabled:
- `sms-deferred-release`: sends SMS that the `sms.send` chokepoint deferred for quiet hours once the recipient's window opens, and retries transient Twilio failures with backoff. A message whose send attempt already reached Twilio is never sent twice; if its outcome is unknown it is marked `failed` (`SEND_OUTCOME_UNKNOWN`) for the owner to see. Even when enabled, nothing sends unless `SMS_ENABLED` is on **and** the tenant's `sms_messaging_enabled` flag is set.
- `scheduling-hold-sweeper` (added by PR-08, #106): releases `held` bookings whose hold has expired, so the slot opens again.

Both stay off on the Render worker (in shadow mode `SCHEDULERS_ENABLED` is unset/`none`, and they must not be in the cutover list). Wayne enables them at go-to-market by adding their names to `SCHEDULERS_ENABLED` on `qvo-worker` (e.g. `…,sms-deferred-release,scheduling-hold-sweeper`). Until then, don't set the worker to `all`, which would start them.

### Worker leader lock

- `server/worker/start.ts` takes `pg_try_advisory_lock` on a **dedicated session connection** (`WORKER_LEADER_DB_URL`), retrying every 10 s while another worker holds it. The leader re-checks its lock connection every 10 s and stops schedulers if it drops.
- `WORKER_LEADER_DB_URL` must be a **session-mode** connection: the Supabase **session pooler (port 5432)** or a direct connection. The transaction pooler (port 6543, `PLATFORM_DB_POOL_URL`) cannot hold session advisory locks and is refused.
- SIGTERM: stop scheduling new ticks → wait for the in-flight tick (observed as "no checked-out DB client", up to 100 s) → release the lock → close the pool → exit. The next worker acquires the lock only after that, so jobs never run twice. Tested against a real Postgres: a standby takes over ~10 s after the leader exits or is killed.

---

## 3. Health endpoints

| Path | Service | Meaning | Used by |
|---|---|---|---|
| `/healthz` | api, voice | Liveness only. **No DB, xAI or Twilio calls.** 200 while the process serves, **including while draining** | Render `healthCheckPath` |
| `/readyz` | api, voice | 200 when the env is valid for the role, `SELECT 1` answers within 1 s, the tool registries are loaded and the process is not draining. Otherwise 503 with reason codes: `env_invalid`, `env_not_validated`, `db_unreachable`, `db_timeout`, `registries_not_loaded`, `draining` (never values) | Deploy checks, uptime monitor, humans |
| `/internal/drain-status` | voice | `{draining, activeSessions, oldestSessionAgeSec, openStreams}`; header `x-admin-token: $ADMIN_INTERNAL_TOKEN` | `scripts/render/deploy.ts` (waits for 0) |
| `/metrics` | voice | Session metrics; now requires `x-admin-token` | Ops |
| `/health` | api, voice | Returns 503 when the DB is down, so it must not be Render's health check. Carries the deploy marker (VA-14): `commit` (`RENDER_GIT_COMMIT`), `buildTime` (written by `scripts/render/build.sh` to `.build-info.json`) and `marker` = `<short sha>@<build time>`, also logged at boot; `unknown` when not available. Before a test call, check `marker` matches the merged commit | Legacy, deploy check |

---

## 4. Zero-dropped-call drain (voice)

On SIGTERM/SIGINT, `qvo-voice`:
1. marks itself draining (`/readyz` → 503, `/healthz` stays 200);
2. answers new `/twilio/voice` webhooks with `<Redirect method="POST">${VOICE_PUBLIC_BASE_URL}/twilio/voice?qvoDrainRedirect=1</Redirect>`. By then Render routes new requests to the new instance. The redirected request has its own replay nonce (same CallSid) and is never redirected a second time. Without `VOICE_PUBLIC_BASE_URL` (Replit) the old "currently unavailable" message is kept;
3. refuses new `/twilio/stream` and `/widget/stream` upgrades (HTTP 503);
4. **waits for active calls to end on their own**, polling every second, up to `DRAIN_TIMEOUT_MS` (default 285000, below the 300 s shutdown delay). It also waits for accepted streams that have not sent their `start` frame yet;
5. only then cleans up stragglers, logging each one's call SID (shortened to `CA…1234` when `DISABLE_PHI_LOGGING=true`) and age;
6. closes the DB pool and exits 0.

`uncaughtException` keeps the old fast path (clean up every call immediately). The admin API on SIGTERM marks itself draining, stops schedulers (role `all` only), closes the HTTP server, waits up to 50 s for in-flight requests, closes the pool and exits.

---

## 5. Environment variables (names only, never values)

Where values live:
- **`qvo-secrets` env group** (Dashboard): every secret shared by more than one service. Entered by Wayne (or Grok Bot with Wayne's approval), never committed.
- **Per-service `sync: false`** in `render.yaml`: `STRIPE_WEBHOOK_SECRET` (api), `SCHEDULERS_ENABLED` and `WORKER_LEADER_DB_URL` (worker).
- **Plain `value:`** in `render.yaml`: non-secret config (roles, URLs, `DRAIN_TIMEOUT_MS`, `DISABLE_PHI_LOGGING`).

Legend: **Azul** = currently Azul-owned or shared; needs a **QVO-owned replacement** before cutover. **?** = owner not verified. **Drop** = do not set on Render.

### New in PR-00
| Name | Services | Notes |
|---|---|---|
| `QVO_PROCESS_ROLE` | all | `voice` / `api` / `worker` / `cron`; unset = `all` (Replit) |
| `SCHEDULERS_ENABLED` | worker (and Replit at cutover) | `none` during shadow; a list or `all` at cutover. Never `all` on both Replit and Render at once |
| `DRAIN_TIMEOUT_MS` | voice | `285000` |
| `VOICE_PUBLIC_BASE_URL` | voice | `https://voice.qualityvoiceoperations.com`. Required for role `voice` in production |
| `VOICE_GATEWAY_INTERNAL_HOSTPORT` | api | From `fromService` (qvo-voice `hostport`) |
| `WORKER_LEADER_DB_URL` | worker | Session-mode Postgres URL (Supabase session pooler `:5432` or direct). Secret. Required for role `worker` in production |
| `RENDER` | all | Set by Render. Turns on the Render guards above |

### Core runtime
`APP_ENV` (=production), `NODE_ENV` (Render sets `production`), `PORT` (Render injects; **do not set `ADMIN_API_PORT` / `VOICE_GATEWAY_PORT` on Render**), `LOG_LEVEL`, `BUILD_VERSION`, `DISABLE_PHI_LOGGING`, the optional `TENANT_LIVE_STREAM_CAP`, `CAMPAIGN_TENANT_MAX_CONCURRENT`, `*_INTERVAL_MS` / `*_TTL_MS` / `*_RETENTION_DAYS` tuning vars.

### Database (Supabase)
| Name | Services | Notes |
|---|---|---|
| `PLATFORM_DB_POOL_URL` | all | **Azul (same Supabase org)** → new QVO project in us-east-1. Supavisor transaction pooler (IPv4, port 6543). Also used by `npm run db:migrate` (pre-deploy) until PR #88's privileged URL lands |
| `DATABASE_URL_PRIVILEGED` | api, worker | From PR #88 (not merged at PR-00 time); same new project |
| `DATABASE_URL` | — | Dev only (Replit Postgres). **Drop** |
| `SUPABASE_DATABASE_URL` | — | **Azul** (Azul Vision schedule lookup). **Drop**; boot warns if set |

### Telephony (Twilio)
| Name | Services | Notes |
|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | voice, api, worker | **Azul** → QVO Twilio account. The auth token must belong to the account that owns the number or signatures fail (403) |
| `TWILIO_OUTBOUND_NUMBER`, `TWILIO_PHONE_NUMBER`, `TWILIO_SMS_FROM` | voice, api, worker | **Azul** → QVO numbers |
| `VOICE_GATEWAY_STREAM_TOKEN` | voice, api | Regenerate for Render |
| `VOICE_GATEWAY_BASE_URL` | all on Render | `https://voice.qualityvoiceoperations.com` (no `/vg`) |
| `VOICE_GATEWAY_STREAM_URL`, `VOICE_GATEWAY_HOST` | voice | Diagnostics |
| `TWILIO_GREETING_*`, `TWILIO_PRETRANSFER_GREETING_ENABLED`, `*_COST_*` | voice, api | Optional |
| `AZUL_VISION_ONCALL_NUMBER` | — | **Azul. Drop**; boot warns if set |
| `STREAM_CANARY_ENABLED` / `_MODE` / `_INTERVAL_MS` | voice | Off at first |

### AI
`XAI_API_KEY` (voice, api; **Azul/?** → QVO xAI team key). `OPENAI_API_KEY`, `OPENAI_ADMIN_API_KEY` (**?**; set only if still used).

### App URLs and security
- `APP_URL`, `APP_BASE_URL`, `APP_PUBLIC_URL`, `ADMIN_API_BASE_URL`, `ADMIN_BASE_URL`, `ADMIN_PUBLIC_URL`, `PLATFORM_ADMIN_BASE_URL`, `PUBLIC_BASE_URL`, `SUPPORT_PUBLIC_BASE_URL` → `https://api.qualityvoiceoperations.com`.
- `ALLOWED_ORIGINS` (api, voice): add the api/voice hosts.
- `ADMIN_JWT_SECRET`, `ADMIN_INTERNAL_TOKEN` (required for role `voice`), `CONNECTOR_ENCRYPTION_KEY`, `ENCRYPTION_MASTER_KEY`, `QVO_PII_LOOKUP_HMAC_KEY`, `QVO_PII_LOOKUP_HMAC_KEY_VERSION`, `QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY` / `_VERSION`, `DISPATCH_COMPLETION_PHOTO_SECRET`, `SUPPORT_UNSUBSCRIBE_SECRET`: **copy the existing values exactly** (encrypted data and JWTs depend on them); confirm none is shared with Azul apps.
- `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY`, `VITE_TURNSTILE_SITE_KEY` (build-time): **?** Cloudflare owner; add the api hostname to the widget.
- `REPLIT_DEV_DOMAIN`, `REPL_ID`: Replit-only. **Drop** (ignored on Render).

### Billing (Stripe)
`STRIPE_SECRET_KEY` (api, worker, cron, api build; **?** owner), `STRIPE_WEBHOOK_SECRET` (api; **new value** for the Render endpoint, `sync: false`), the 12 `STRIPE_PRICE_*` names, `STRIPE_METER_*`, `STRIPE_MARKETPLACE_METER_EVENT`.

### Email
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` (api, worker, cron; **Azul (likely)** → QVO mailbox). `SALES_EMAIL`, `SALES_NOTIFICATION_EMAIL`, `OPS_ALERT_EMAIL`, `BILLING_ALERT_EMAILS`, `FINANCE_ALERT_EMAILS`, `MARGIN_ALERT_EMAIL`, `SUPPORT_UNSUBSCRIBE_MAILTO`, `SUPPORT_INBOUND_DOMAIN`, `SUPPORT_INBOUND_SECRET`, `SUPPORT_BOUNCE_WEBHOOK_SECRET` → QVO addresses.

### Integrations (optional; leave unset unless used)
`CALCOM_WEBHOOK_SECRET` (required in prod for api), `CALENDLY_*`, `BOOK_DEMO_SCHEDULER_PROVIDER`, `VITE_BOOK_DEMO_SCHEDULER_URL` / `_PROVIDER` (build-time); OAuth clients `GOOGLE_*`, `MICROSOFT_*`, `HUBSPOT_*`, `SALESFORCE_*`, `PIPEDRIVE_*`, `ZOHO_*`, `QUICKBOOKS_*`, `SLACK_CLIENT_*` (update redirect URIs if kept); `SLACK_WEBHOOK(_URL)`, `OPS_SLACK_WEBHOOK_URL`, `GOOGLE_MAPS_API_KEY`, `MAPBOX_ACCESS_TOKEN`, `DISPATCH_GEOCODE_*`, `DISPATCH_ROUTING_*`, `GOOGLE_SAFE_BROWSING_*`, `CLAMAV_*`, `FEDERAL_DNC_*`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_BILLING_HEALTH_*`, `REDIS_URL`.
`TICKETING_SYSTEM_URL`, `TICKETING_API_KEY`: **Azul. Drop**; boot warns if set.

### Object storage
`PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`: Replit-only. Without them (Render, until PR-00b), dispatch upload/attachment/photo/route-export routes return **503 `storage not configured`**, voice-preview caching is skipped, and the route-export cleanup scheduler is skipped. PR-00b adds `OBJECT_STORAGE_PROVIDER=s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (Supabase Storage).

### Validation at boot
`scripts/validate-env.ts` decides the required set from `APP_ENV` + role and fails fast listing **names only**. Role `all` keeps the pre-PR-00 list. Production requirements per role:
- **voice:** `PLATFORM_DB_POOL_URL`, `XAI_API_KEY`, `TWILIO_*`, `VOICE_GATEWAY_STREAM_TOKEN`, `VOICE_PUBLIC_BASE_URL`, `ADMIN_INTERNAL_TOKEN`, `ALLOWED_ORIGINS`, `CONNECTOR_ENCRYPTION_KEY`, `QVO_PII_LOOKUP_HMAC_KEY(_VERSION)`.
- **api:** the full pre-PR-00 list minus the new split-only names.
- **worker:** DB, Twilio, `ADMIN_JWT_SECRET`, Stripe, SMTP, `APP_URL`, `VOICE_GATEWAY_BASE_URL`, `ADMIN_API_BASE_URL`, `WORKER_LEADER_DB_URL`, encryption/HMAC keys.
- **cron:** DB, Stripe, SMTP, `APP_URL`, encryption/HMAC keys.
- **Render (any role):** `APP_URL` and `VOICE_GATEWAY_BASE_URL`. Azul-only names produce warnings, not failures.

---

## 6. Deploy procedure

Releases are deliberate. Merges to `main` never deploy (`autoDeployTrigger: off`).

```bash
npx tsx scripts/render/deploy.ts                      # dry-run: prints the plan, no network
RENDER_API_KEY=… VOICE_PUBLIC_BASE_URL=https://voice.qualityvoiceoperations.com \
ADMIN_INTERNAL_TOKEN=… npx tsx scripts/render/deploy.ts --execute [--commit <sha>]
```

Order: **qvo-api → qvo-worker → qvo-nightly → qvo-voice**. A failed step stops the release (e.g. a failed `db:migrate` pre-deploy cancels the api deploy; the old version keeps serving).

**qvo-voice deploys only if:**
- the time is inside **00:30–06:30 America/New_York**, and
- `/internal/drain-status` shows **0 active calls** (and 0 open streams). The script polls every 30 s for up to 15 min, then skips voice and reports it (exit code 3).
- `--force-voice` overrides both gates. Emergencies only (e.g. a rollback during business hours).

Rules:
- Use the **QVO workspace** API key only (`RENDER_OWNER_ID` can pin the workspace). Never the Azul account key.
- Migrations must be **backward-compatible with the previous voice build** (expand, then contract): voice may run yesterday's code for hours.
- Validate the Blueprint after editing `render.yaml`: `npx tsx scripts/render/validate-blueprint.ts` (vendored schema) or `--remote` (live schema), and `render blueprints validate` if the Render CLI is installed.

**Before pilots, prove the drain on Render** (render-plan §6.4): place a test call, deploy voice mid-call, the call must reach its natural end and a second call during the deploy must land on the new instance; a 30-minute call (no proxy idle timeout); kill the process mid-call and confirm the Twilio fallback URL rings through.

---

## 7. Twilio cutover and rollback

**Prerequisites:** qvo-voice and qvo-api live on Render in **shadow mode** (`SCHEDULERS_ENABLED` unset/`none` on the worker); custom domains verified with TLS; `/readyz` 200 on both.

**Cutover:**
1. Record every QVO number's Voice URL, status callback, SMS URL, fallback URL, TwiML App and messaging-service membership (read-only) to `render/twilio-before.json` — the rollback source.
2. Point one **test number** at `POST https://voice.qualityvoiceoperations.com/twilio/voice`, `…/twilio/status`, `…/twilio/sms`, fallback = a TwiML Bin that `<Dial>`s the shop. Run the 10-call checklist and the deploy-during-call test.
3. Off-hours window (Wayne approves): set `SCHEDULERS_ENABLED=none` on Replit (needs PR-00 published there), then the agreed list on the Render worker; update the remaining numbers; remove numbers from Azul's "SMS Application" messaging service first; leave 909-413-0674 with NPX.
4. Stripe: add the `https://api.qualityvoiceoperations.com/billing/stripe-webhook` endpoint and put its secret in `STRIPE_WEBHOOK_SECRET`; disable the Replit endpoint after verification. Update Cal.com/Calendly webhooks, OAuth redirect URIs, Turnstile hostnames as needed.
5. Watch 48 h: logs, call outcomes, the daily isolation email, Stripe deliveries.

**Rollback** (until cutover is verified for 7 days): point the Twilio numbers back at the saved URLs; re-enable the Replit Stripe endpoint; set Replit `SCHEDULERS_ENABLED=all` and the Render worker to `none` (never both on). DNS can stay. For a bad Render release after cutover: Dashboard → service → **Rollback** to the previous deploy (migrations can't be undone, hence expand-only).

---

## 8. Cost (Render list prices, Oct 16 2026; excludes Supabase, Twilio, xAI, Vercel)

| | Start (shadow → tests) | Pilots (3 shops) |
|---|---|---|
| qvo-voice | Starter $7 | Standard $25 |
| qvo-api | Starter $7 | Starter $7 (Standard $25 if memory > 80%) |
| qvo-worker | Starter $7 | Starter $7 |
| qvo-nightly | ~$1 | ~$1 |
| Workspace | Hobby $0 | Hobby $0 or Pro $25 |
| **Total** | **≈ $23–25/month** | **≈ $59–61 (Hobby) / $84–86 (Pro)** |

Bandwidth (~2 MB per call-minute) and build minutes add a few dollars. Two custom domains are included on Hobby.
