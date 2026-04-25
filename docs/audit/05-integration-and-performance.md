# 05 — Integration & Performance

Connector reliability, retry/backoff, webhook integrity, latency hot spots, N+1 patterns.

---

## I-01 — Zapier webhook adapter SSRF allow-list bypass (DNS rebinding) — also B-03
- See `01-bug-list.md` B-03.
- P0 security finding.

## I-02 — Connector adapters do not implement exponential back-off
- `hubspot.ts`, `salesforce.ts`, `pipedrive.ts`, `zapier.ts`, `slack.ts` all do a single `fetch` with a 15s timeout.
- On 429 / 503 the adapter returns the failure immediately; the caller (`ConnectorService.execute`) writes an `error` sync status and notifies for revenue-critical providers, but does not retry.
- The `outbox` worker exists (`platform/integrations/outbox`) but only processes events queued for outbox-mode delivery; real-time adapter calls do not go through it.
- Recommend a uniform retry helper: 3 attempts, 1s/4s/16s, jittered; 429 should respect `Retry-After` headers when present.

## I-03 — Webhook signature verification — Stripe is correct, but Twilio is not centrally enforced
- Stripe webhook uses `stripe.webhooks.constructEvent(body, signature, getWebhookSecret())` (correct).
- Twilio voice webhook (`/twilio/voice`) does not verify the `X-Twilio-Signature` header. In production any unauthenticated POST that reaches the gateway can spoof an inbound call and consume OpenAI minutes.
- Recommend adding `twilio.validateRequest(authToken, signature, fullUrl, params)` in a middleware.

## I-04 — `connectorOAuth.ts` state cookie attributes
- Verify `Secure`, `HttpOnly`, `SameSite=Lax`, and a short max-age (5–10 minutes).
- The current code (~800 LOC) sets the state cookie, but the audit window did not confirm all three attributes are set in production. Treat as P1 to verify.

## I-05 — Token refresh is on-demand only
- See W-10. Add a 12-hour worker that pre-refreshes tokens within 24h of expiry to avoid first-request latency.

## I-06 — N+1 — `routes/dispatch.ts:listJobsHandler`
- Lists jobs, then for each job runs a separate query for `attachments_count`, `assigned_resource_name`, `last_status_at`.
- For a tenant with 200 active jobs, this is 600 extra queries per page load.
- Fix: a single `LEFT JOIN LATERAL` or a CTE that aggregates counts.

## I-07 — N+1 — `routes/scheduling.ts:list bookings + reminderConfig`
- Each booking triggers a per-row reminder lookup.
- Fix: pre-load `reminder_configs` keyed on `appointment_type_id`.

## I-08 — N+1 — `routes/tickets.ts:GET /tickets`
- For each ticket, the handler runs a separate query for `last_activity` and `linked_tickets_count`.
- Fix: window functions (`MAX(activity.created_at) OVER (PARTITION BY ticket_id)`) or pre-aggregation.

## I-09 — Over-fetching — `Calls.tsx`
- The list page requests `/calls?include=transcript_excerpt,sentiment,duration,cost,outcome,quality_score` regardless of which columns are visible.
- Fix: client-side pruning OR backend `?columns=…` parameter.

## I-10 — SSE — `callsLive` and demo endpoints
- Demo SSE has IP rate limit (5/min stream, 20/min poll).
- Tenant SSE (`callsLive`) has none (B-07).
- Recommend per-tenant cap (e.g. 20 concurrent connections) and a heartbeat every 15s to detect dead clients.

## I-11 — Background workers run unconditionally even when their feature flag is off
- 13 workers boot in `start.ts`. There is no env flag to disable, e.g., the GIN scheduler in a tenant that does not opt into the federated intelligence network.
- Recommend `START_*` env flags for each worker.

## I-12 — Stripe metering report fails silently when `STRIPE_SECRET_KEY` is missing
- The worker logs and continues on each cycle. In dev this is fine; in prod missing key should be fatal at startup (already true via `validateEnvironment({ exitOnFailure: true })`), but the worker logs a per-tick warning that can drown other logs.
- Fix: log once on startup, then go silent until configured.

## I-13 — `pool.connect()` discipline
- A spot-check of `auth.ts:resolveCurrentRole` shows `try { … BEGIN … } catch { ROLLBACK }` but no `await` on the `ROLLBACK` (silently swallowed), and the `if (rows.length === 0) return null` path leaves the transaction open until `COMMIT` runs **after** the bail-out. Not a leak today because the COMMIT runs above the return, but the structure is fragile.
- Recommend adopting `withClient(fn)` helpers everywhere instead of manual `BEGIN`/`COMMIT`.

## I-14 — Latency hot spot — auth middleware
- Two DB queries per authenticated request (B-05). At 100 RPS that is 200 extra queries.
- Combined with the dynamic `await import` per request, this is wasteful.
- Fix: cache and pre-import.

## I-15 — Memory worry — the in-memory rate-limiter map in `websiteAgent.ts` never bounds its size
- A flood of unique IPs grows the Map unboundedly until the cleanup interval runs.
- Fix: use the shared `createRateLimiter` in `platform/infra/rate-limit/`.

## I-16 — Bundle size — client app
- 55 dashboard pages + 23 public pages + XYFlow + lucide + react-query is heavy.
- No route-based code splitting visible (all pages imported eagerly in `App.tsx`).
- Fix: convert each `import Page from './pages/Page'` to `React.lazy(() => import('./pages/Page'))`. First-paint should drop substantially.

## I-17 — Vite dev does not allow all hosts explicitly
- The repl's preview pane requires `server.allowedHosts: true` in `vite.config.ts`. Verify this is set; if not, the preview pane shows blank intermittently when the proxied iframe origin shifts.

## I-18 — Webhook URL allow-list does not include AAAA / IPv6 ranges
- Even after fixing B-03, the IPv4-only check misses IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`).

## I-19 — `ConnectorService.execute` writes to `recordIntegrationEvent` with `requestUrl: connector://…`
- That is a synthetic URL — fine — but the response body is logged with `success` only. For non-success, the error message is logged but not the upstream response code, so triage of a "Slack 404" vs "Slack 500" requires reading provider logs.
- Fix: include `responseStatusFromAdapter` in the recorded event.

## I-20 — `voice-gateway/services/sessionLogger.ts` writes per-frame audio metadata; high-cardinality, high-volume
- At 50 fps for a 5-min call that is 15,000 rows per call.
- Fix: aggregate to per-second or per-utterance summaries.

## I-21 — `voice-gateway/services/openaiSession.ts` handles WS reconnect but does not reset the AI minute timer on reconnect
- Result: a flaky network can over-bill AI minutes by counting both the disconnected and reconnected windows.

## I-22 — Outbox processing is on-demand
- `OutboxService` is invoked from inline call sites. There is no periodic worker that drains stuck rows.
- Recommend a minute-cadence drain worker.

## I-23 — `usage_metrics` index coverage
- After 60+ migrations there is no explicit composite index on `(tenant_id, recorded_at, metric_type)` that is critical for the analytics endpoints.
- Recommend `CREATE INDEX CONCURRENTLY usage_metrics_tenant_time_type ON usage_metrics(tenant_id, recorded_at DESC, metric_type)`.

## I-24 — `call_events` table accumulates without a retention policy
- Tied to W-08 and I-20. After a year, this table dominates the DB.
- Recommend a 90-day partition strategy or scheduled prune.
