# Cost-tracking audit — where cost data flows in vs out today

**Date:** 2026-05-28
**Audited by:** Claude (read-only, no code changes)
**Scope:** Penny-accurate per-call cost attribution for OpenAI Realtime API,
Twilio, and infrastructure overhead. Bridge between captured cost and the
Stripe-metered invoice the customer pays.

This is the answer to: "if we ran 10,000 calls today, do we know to the
penny what we owe OpenAI + Twilio, and what we charged the customer for
each one?" Today the answer is **no, by a wide margin** — and three of the
four root causes are silent bugs, not missing features.

---

## TL;DR — three SEVERE bugs, one architectural gap

| # | Finding | Severity | What it means in cents |
|---|---------|----------|------------------------|
| 1 | **OpenAI token counts are estimated as `Math.ceil(text.length / 4)`** — we never read the `usage` payload OpenAI sends with `response.done` | **SEVERE** | Audio-token cost (the dominant cost on Realtime) is under-counted by ~10–50× per call |
| 2 | **Twilio's per-call `Price` field is never read** from the status callback | **SEVERE** | Carrier cost is a flat `TWILIO_COST_PER_MINUTE_CENTS` env default (2¢/min); real Twilio cost varies 10–100× by destination |
| 3 | **`usage_metrics.details` JSONB column does NOT exist** in any migration; the insert that writes per-call metadata silently fails on `.catch` | **SEVERE** | Per-hour rollup loses the per-call detail row entirely; we can't reconstruct which conversation drove a given hour's cost |
| 4 | **Stripe billing path reads `usage_metrics` minutes, never `conversation_costs.total_cost_cents`** — no reconciliation loop | **HIGH** (architectural) | We bill the customer by minutes × catalog rate; we have no automatic check that our cost ≤ their bill |

Margin per call is **not computable to the penny** until (1), (2), (3),
and (4) are fixed. Today the system produces plausible-looking dashboards
that are off by an unknown but large factor.

---

## 1. What actually exists today

### 1.1 Schema (the data model is mostly sound)

`migrations/008_billing.sql` creates the customer-facing usage table:

```sql
CREATE TABLE usage_metrics (
  id, tenant_id, metric_type ENUM('calls_inbound','calls_outbound',
    'sms_sent','sms_received','ai_minutes','tool_invocations','workflow_executions'),
  period_start, period_end,   -- hour buckets
  quantity, unit_cost_cents, total_cost_cents,
  UNIQUE(tenant_id, metric_type, period_start)
);
```

`migrations/046_cost_optimization.sql` creates the internal-cost tables:

```sql
CREATE TABLE conversation_costs (
  id, tenant_id, call_session_id,
  stt_cost_cents, llm_cost_cents, tts_cost_cents, infra_cost_cents, total_cost_cents,
  model_tier, model_used, input_tokens, output_tokens,
  cache_hits, cache_misses, prompt_tokens_saved,
  UNIQUE(tenant_id, call_session_id)
);

CREATE TABLE cost_budget_settings (
  max_cost_per_conversation_cents DEFAULT 500,
  alert_threshold_percent DEFAULT 80,
  auto_downgrade_model BOOLEAN DEFAULT TRUE,
  auto_end_call BOOLEAN DEFAULT FALSE,
  enabled BOOLEAN DEFAULT FALSE,
);

CREATE TABLE model_routing_log ( /* tier decisions per call */ );
CREATE TABLE response_cache    ( /* prompt-cache hits */ );
```

RLS is in place on all four. The `UNIQUE(tenant_id, call_session_id)`
guarantees one row per call with `ON CONFLICT DO UPDATE` accumulation
for late-arriving events — good design.

### 1.2 Rate table — `platform/billing/cost/providerRates.ts`

Hardcoded per-1k-token rates in cents. The Realtime SKUs are current:

| Model | Input ¢/1k | Output ¢/1k |
|-------|-----------:|------------:|
| `gpt-realtime-2` (default, May 2026 GA) | 3.2 | 6.4 |
| `gpt-realtime-mini` (economy) | 0.05 | 0.2 |
| Legacy: `gpt-realtime`, previews | varies | varies |

Plus env-driven flat-rate overlays:
- `STT_COST_PER_MINUTE_CENTS=0.6`
- `TTS_COST_PER_1K_CHARS_CENTS=1.5`
- `INFRA_COST_PER_MINUTE_CENTS=0.5`

**Problem:** Realtime API does not bill STT/TTS separately — audio
input/output is bundled into the model's audio-token rates. Adding
0.6¢/min STT + 1.5¢/1k-chars TTS on top of token cost is **phantom cost**,
not real cost. The columns and code paths exist as if this were a pipeline
architecture (STT → LLM → TTS), but the Realtime API is a single bidirectional
audio stream priced per token.

### 1.3 Write path — `platform/billing/cost/CostTrackingService.ts`

`recordConversationCost(params)` is called from two finalizer paths in
`server/voice-gateway/routes/stream.ts`:

- **Line 199** — Twilio voice call finalize (`finalizeTwilioStream`)
- **Line 764** — Browser widget call finalize (`finalizeWidgetStream`)

Both pass `inputTokens`, `outputTokens`, `ttsCharacters`, `cacheHits`,
`cacheMisses`, `promptTokensSaved`, `modelUsed`, `modelTier` from the
`sessionResult.costTracker` object. Service computes:

```
sttCostCents  = ceil(durationSeconds/60) * 0.6   ¢    (env default)
llmCostCents  = (inputTokens/1k)*rate.in + (outputTokens/1k)*rate.out
ttsCostCents  = ceil(ttsCharacters/1000) * 1.5  ¢   (env default)
infraCostCents= ceil(durationSeconds/60) * 0.5  ¢   (env default)
total         = stt + llm + tts + infra
```

Inserts into `conversation_costs` AND `usage_metrics` (ai_minutes hour
bucket) in one transaction. Rollback bug previously fixed in PR #22
(Iron-out 9).

### 1.4 Stripe billing path — `platform/billing/stripe/usage.ts`

A 60-minute interval timer (`startUsageMeteringWorker`) calls
`reportUsageForAllTenants` → `reportUsageForTenant(tenantId)`:

1. Reads `usage_metrics` for the most recently completed hour bucket
2. Sums `ai_minutes` quantity and `calls_inbound|outbound` quantity
3. Posts two `stripe.billing.meterEvents.create({event_name, value})`
   events — one per metric — with idempotency keys
   `ai_<tenant>_<hourBucket>` and `calls_<tenant>_<hourBucket>`
4. Stripe applies the catalog rate to bill the customer

**`conversation_costs.total_cost_cents` is never read by this path.**

### 1.5 Rate resolution — `platform/billing/usage/UsageRecorder.ts`

`recordCallUsage` (called from voice finalize) resolves the live per-minute
rate from the tenant's Stripe subscription via
`getCachedTenantEffectiveRate(tenantId)` for both:
- AI rate (`rate.overageRatePerMinute`)
- Twilio rate (`rate.twilioRatePerMinute` — set when the tenant has a
  negotiated carrier price line on Stripe)
- SMS rate (`rate.smsRatePerMessage`)

Falls back to env defaults (`TWILIO_COST_PER_MINUTE_CENTS=2`,
`AI_COST_PER_MINUTE_CENTS=6`) when the cache resolver errors. This is the
right architecture for billing-side reconciliation — **but it's an estimate
of carrier cost, not the actual amount Twilio charged**.

### 1.6 Analytics layer — `platform/billing/cost/CostAnalyticsService.ts`

`getCostOptimizationAnalytics(tenantId, from, to)` returns:
- totalConversations, totalCostCents, avgCostPerConversationCents
- Per-component totals (stt/llm/tts/infra)
- Cache hit rate
- Daily breakdown, tier distribution, 6-month monthly trend
- Savings breakdown (cache savings, routing savings, compression savings)

Read by `client-app/src/pages/CostOptimization.tsx` and
`AdminAnalytics.tsx`. **All values derive from `conversation_costs`,
which is fed by the broken token-counting path (see §2.1).**

### 1.7 Budget guard — `platform/billing/cost/CostBudgetService.ts` + `BudgetGuardService.ts`

Mid-call check: if `getConversationCostRunningTotal(tenantId, callSessionId)`
exceeds `cost_budget_settings.max_cost_per_conversation_cents`, the guard
either downgrades the model tier (economy → mini SKU) or ends the call
(if `auto_end_call=true`).

**Same problem:** the running total is the sum of under-counted tokens,
so the guard fires later than it should, and the worst calls bypass it.

---

## 2. Findings, in order of dollar impact

### 2.1 SEVERE — Token counts are character-length estimates, not real OpenAI usage

**File:** `server/voice-gateway/services/openaiSession.ts`, lines 1028–1062.

```ts
const costTracker = {
  inputTokens: 0,
  outputTokens: 0,
  // ...
  addUtterance(role: 'user' | 'assistant', text: string): void {
    const tokenEstimate = Math.ceil(text.length / 4);  // ← THIS
    if (role === 'user') this.inputTokens += tokenEstimate;
    else                  this.outputTokens += tokenEstimate;
    // ...
  },
};
```

The `text.length / 4` heuristic is a rough rule of thumb for **text** token
counts. The OpenAI Realtime API charges separately for:
- `input_text_tokens`, `output_text_tokens`
- `input_audio_tokens`, `output_audio_tokens` ← **dominant on voice calls**
- `input_token_details.cached_tokens` (≈ 50% discount)

The `response.done` event delivers all of these in a `usage` object. Our
code (line 1551) registers a listener that only flips `responseInFlight = false`
and **discards the `usage` payload entirely**.

**Impact:** A 5-minute voice conversation might transcribe to ~5,000
characters (~1,250 estimated tokens). The actual OpenAI bill for that
same call is computed from ~30,000 input audio tokens + ~30,000 output
audio tokens — roughly **48× more cost** than we record.

This is the single biggest source of cost drift today. Wayne's "to the
penny" goal is unreachable without subscribing to `response.done.usage`
and incrementing the tracker from the wire payload.

### 2.2 SEVERE — Twilio per-call `Price` is never captured

**File:** `server/voice-gateway/routes/twilio.ts`, lines 350–386.

The status callback handler:
1. Extracts `StirTelemetry` from `req.body` (good — call security)
2. Calls `coordinator.handleTwilioStatusCallback(callSid, callStatus)`
3. Fans out to terminal-status side effects

It **never reads `req.body.Price`, `req.body.PriceUnit`, `req.body.CallDuration`**
even though Twilio sends them on the `completed` callback for every
voice call. We have the wire data; we throw it away.

The carrier-cost fallback in `recordCallUsage` is:

```
twilioCostCents = ceil(durationSeconds/60) * (resolved rate ?? 2¢/min)
```

The resolved rate comes from the tenant's Stripe price line, not from
Twilio. For most tenants we fall back to the 2¢/min env default. **Real
Twilio rates vary 10–100× by destination**:

| Type | Twilio rate (rough) |
|------|--------------------:|
| US toll-free inbound | $0.0085–0.022/min |
| US local inbound | $0.0085/min |
| US mobile outbound | $0.014/min |
| International (varies) | $0.05–$2.00/min |
| Premium-rate destinations | up to $5+/min |

Tenants like Wayne's ophthalmology customers calling 30 SoCal locations
hit a narrow distribution, but the **moment we cross a fraud boundary or
an international destination, we'll silently eat the spread**.

### 2.3 SEVERE — `usage_metrics.details` JSONB column does not exist

**File:** `platform/billing/cost/CostTrackingService.ts`, lines 94–118.

```ts
await client.query(
  `INSERT INTO usage_metrics (
    id, tenant_id, metric_type, period_start, period_end,
    quantity, total_cost_cents, details   -- ← THIS COLUMN
  ) VALUES (gen_random_uuid(), $1, 'ai_minutes', $2, $3, $4, $5, $6)
  ON CONFLICT (...) DO UPDATE SET ...`,
  [..., JSON.stringify({ callSessionId, modelTier, modelUsed, inputTokens, outputTokens })]
).catch((umErr) => {
  logger.warn('Failed to record cost in usage_metrics', { error: String(umErr) });
});
```

**Verified absent:**
- `migrations/008_billing.sql` creates `usage_metrics` with no `details` column
- `migrations/078_call_events_partition_and_usage_metrics_index.sql`
  only adds an index — no schema change
- No `ALTER TABLE usage_metrics ADD COLUMN details` in any of the
  179 migrations (grep `details JSONB|ADD COLUMN.*details` against
  `migrations/*.sql` finds zero)

The `.catch(...)` swallows the SQL error 42703 ("column does not exist")
into a warning log. The outer transaction commits the
`conversation_costs` row anyway, so the call completes. But:
- The per-call drill-down from a billing hour-bucket is **lost** —
  we can't ask "which call drove this hour's cost?" from `usage_metrics`
  alone
- Production logs are silently filled with this warning on every call;
  it has likely been masked by log volume since the column-less INSERT
  shipped
- Memory note in `project_current_state.md` claims "migration 111 added
  it in Supabase" — **no migration 111 exists in the repo**. Either the
  note is wrong, or Supabase prod is hand-patched and the repo doesn't
  reflect reality (consistent with the 151-migration drift noted in
  `db_topology`)

### 2.4 HIGH (architectural) — No reconciliation loop between cost and Stripe invoice

The data flow today is two parallel streams that never meet:

```
   ┌────────────────────────────┐         ┌────────────────────────────┐
   │  recordConversationCost    │         │  recordCallUsage           │
   │  → conversation_costs      │         │  → usage_metrics(quantity) │
   │  (internal cost view)      │         │  (customer-billable units) │
   └────────────────────────────┘         └────────────────────────────┘
              │                                       │
              │                                       │
   ┌────────────────────────────┐         ┌────────────────────────────┐
   │  CostAnalyticsService      │         │  reportUsageForTenant      │
   │  (dashboards)              │         │  → Stripe meterEvents      │
   └────────────────────────────┘         │  → invoice                 │
                                          └────────────────────────────┘
                                                      │
                                                      ▼
                                          Customer pays $X
```

There is **no path** that:
- Reads the invoice Stripe issued for tenant T for billing period P
- Reads `SUM(conversation_costs.total_cost_cents)` for tenant T in P
- Computes margin = invoice_total − our_cost
- Alerts when margin < threshold or goes negative

The closest thing is `CostAnalyticsService.getCostOptimizationAnalytics`
which returns *internal* aggregates only.

### 2.5 LOW — STT + TTS + infra are phantom cost layers for Realtime API

Already covered in §1.2. The Realtime API does not bill STT/TTS separately;
the audio is in the model's audio-token rate. Today's cost model adds:
- 0.6¢/min as "STT" (not billed by OpenAI)
- 1.5¢/1k chars as "TTS" (not billed by OpenAI)
- 0.5¢/min as "infra" (real, but flat env default — actual Replit/Supabase/
  outbound bandwidth cost per call is not measured)

These three columns add ~5–10¢ per call of fake cost. They make
`total_cost_cents` larger than reality, partly compensating for the
massive under-count of OpenAI tokens in §2.1 — so the headline number on
the dashboard is "less wrong by accident" but the breakdown is meaningless.

### 2.6 LOW — Pre-existing bugs already fixed

Noted for completeness, do not re-fix:
- PR #22 / Iron-out 9: `recordConversationCost` rollback corrupted state
  on partial failure. Fixed.
- Iron-out 5b: All 6 Stripe metered prices had `meter=NONE`; now wired
  to the correct meters. Fixed.

---

## 3. What an end-to-end correct system would look like

For each call, we need one row that includes:

| Component | Where it comes from |
|-----------|---------------------|
| OpenAI input text tokens | `response.done.usage.input_token_details.text_tokens` |
| OpenAI input audio tokens | `response.done.usage.input_token_details.audio_tokens` |
| OpenAI cached input tokens (50% off) | `response.done.usage.input_token_details.cached_tokens` |
| OpenAI output text tokens | `response.done.usage.output_token_details.text_tokens` |
| OpenAI output audio tokens | `response.done.usage.output_token_details.audio_tokens` |
| OpenAI reasoning tokens | `response.done.usage.output_token_details.reasoning_tokens` |
| Twilio actual call cost | `req.body.Price` on status callback, currency `req.body.PriceUnit` |
| Twilio duration billed | `req.body.CallDuration` (carrier-billed, not wall-clock) |
| Infra allocation | monthly bucket / total calls (cron, not per-call) |
| **Total internal cost (cents)** | sum of the above × rate table |
| Stripe-billed minutes (customer view) | `usage_metrics.ai_minutes.quantity` per call |
| Stripe-billed amount (customer view) | invoice line item attributable to this call |
| **Margin (cents)** | billed − internal |

And one reconciliation cron (daily): for each finalized Stripe invoice,
sum the per-call costs and compare. Alert if margin drops below a tenant
floor or goes negative.

---

## 4. Suggested fix order, smallest blast radius first

1. **Add the missing `usage_metrics.details` column** (one migration, ~5
   lines). Stops the silent SQL error on every call. Restores per-call
   drill-down from billing hour-buckets. Zero risk.

2. **Capture Twilio `Price` from status callback.** Add three columns
   to `conversation_costs` (`twilio_price_cents`, `twilio_price_currency`,
   `twilio_billed_seconds`), parse `req.body.Price/PriceUnit/CallDuration`
   in `twilio.ts`, write through. Real Twilio cost per call is then
   captured for free — it was always on the wire. Low risk: the
   columns default to NULL for legacy rows.

3. **Subscribe to `response.done.usage` and replace the char/4 heuristic.**
   Two new columns (`input_audio_tokens`, `output_audio_tokens`,
   `cached_tokens`) on `conversation_costs`, new `audio_input_per_1k`
   and `audio_output_per_1k` fields in `providerRates.ts`. Replace
   `costTracker.addUtterance(role, text)` with a `response.done`
   handler that reads `event.response.usage`. Highest impact; medium
   risk because it changes the dashboards' headline numbers.

4. **Decide whether STT/TTS/infra columns stay or go.** For Realtime API
   they should be zero or removed. For a future pipeline architecture
   (e.g. Whisper STT + GPT + ElevenLabs TTS) they would be real. Recommend
   keeping the columns for forward-compat but defaulting all three to
   zero with a comment until/unless we ship a pipeline path.

5. **Reconciliation cron + margin alert.** New module
   `platform/billing/reconciliation/` that on a daily cadence walks
   finalized Stripe invoices, joins per-call costs, writes a
   `billing_reconciliation` table row, and posts to `OPS_SLACK_WEBHOOK_URL`
   when margin floor is breached. No customer-facing impact.

Each step lands on its own commit, each step is independently revertible,
and the dashboards only change between (2) and (3).

---

## 5. Out of scope for this audit (flagged for later)

- **Supabase prod schema drift**: 151+ migrations behind per
  `project_db_topology.md`. The `usage_metrics.details` situation is
  symptomatic. A separate audit of "what's actually in Supabase right
  now" is needed before any of the fixes above ship.
- **Connector / search API costs**: If any tool calls fan out to
  paid third-party APIs (HubSpot, Salesforce, Pipedrive, Zoho, search
  endpoints), those are not currently tracked. Likely small per call,
  but should be enumerated.
- **CSAT SMS costs**: `dispatchSmsCsatSurvey` fires after qualifying
  calls. `recordSmsUsage` exists in `UsageRecorder` and is on the right
  rate path, but it's not joined back to the originating call_session
  for per-call margin.
- **Knowledge-base RAG embedding costs**: `retrieve_knowledge` tool
  invocations make embedding + retrieval calls. Not currently in the
  cost model.

---

## 6. What I did not change

Per the post-compact directive: **no code changes**. This is the audit
document; the next conversation turn is where Wayne picks which finding
to fix first.

The fact-finding evidence (file paths, line numbers, exact SQL, migration
filenames) is verbatim from the repo as of commit `4d001be` on
`origin/main`.
