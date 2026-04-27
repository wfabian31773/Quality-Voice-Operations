# Runbook — Backfill correction shifted call across calendar days

Audience: Finance / billing ops
Surface: `operations_alerts.type = 'billing_backfill_cross_day'` (Operations →
Alerts panel, severity `warning`)

## What happened

A backfill correction (POST `/v1/ingest/calls/backfill`, or a corrective
re-issue against `/v1/ingest/calls`) re-ingested a call whose `external_id`
already existed in `call_sessions`, AND the new event's `start_time` falls on
a different calendar day from the original.

The ingest pipeline at `server/admin-api/routes/ingest.ts` updates the
existing `call_sessions` row in place, then applies the new minutes / cost
delta to the **new** day's `daily_org_usage` and `usage_metrics` rows. It does
**not** roll the call out of the **old** day's bucket — that would double the
SQL load on what is supposed to be an exceptional path.

The result: until you rebalance manually, the OLD day's `daily_org_usage`
and `usage_metrics` rows still count the original call's minutes and cost,
and the NEW day's rows count them again. End-of-month invoices and any
finance dashboard that aggregates daily totals may double-count this call.

## Information you'll find on the alert

The `operations_alerts.metadata` JSON contains:

| Field          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `tenant_id`    | Affected tenant.                                                |
| `external_id`  | Upstream call identifier — also on `call_sessions.external_id`. |
| `old_date`     | Calendar day the original call was attributed to (UTC).         |
| `new_date`     | Calendar day the corrected call is now attributed to (UTC).     |
| `source`       | `remix` (live correction) or `remix-backfill`.                  |
| `runbook_url`  | This document.                                                  |

The `call_session_id` column on the alert points at the affected row in
`call_sessions`, which is the source of truth for the corrected values.

## Step 1 — Confirm the shift

```sql
SELECT id, external_id, start_time, duration_seconds, total_cost_cents
FROM call_sessions
WHERE tenant_id = $tenant_id AND external_id = $external_id;
```

Note the row's current `duration_seconds` and `total_cost_cents`. These are
the **post-correction** values: they have already been applied to the NEW
day's bucket. To rebalance, you need the **pre-correction** values that were
applied to the OLD day's bucket — fetch them from the `ingest_events` audit
trail:

```sql
SELECT idempotency_key, processed_at, payload
FROM ingest_events
WHERE org_id = $tenant_id
  AND payload->>'external_id' = $external_id
ORDER BY processed_at ASC;
```

The first row is the original ingest. Read `payload->'duration_seconds'`,
`payload->'costs'->'openai_cents'`, and `payload->'costs'->'total_cents'` —
those are the values that landed on the OLD day. Any subsequent rows are
later corrections.

Compute:

```
old_minutes  = ceil(original.duration_seconds / 60)
old_cost     = original.costs.total_cents
old_openai   = original.costs.openai_cents
```

## Step 2 — Reverse the OLD day's bucket

The original ingest incremented the OLD day's `daily_org_usage` by
(+1 call, +`old_minutes`, +`old_cost`). Subtract those numbers back out:

```sql
UPDATE daily_org_usage
SET total_calls       = total_calls       - 1,
    total_ai_minutes  = total_ai_minutes  - $old_minutes,
    total_cost_cents  = total_cost_cents  - $old_cost
WHERE tenant_id = $tenant_id AND date = $old_date;
```

If `total_calls` would go negative, stop and escalate — there's a deeper
inconsistency.

## Step 3 — Reverse the OLD day's `usage_metrics` rows

Two metric rows were written on the original ingest: one for the call
direction (`calls_inbound` or `calls_outbound`) and one for `ai_minutes`.

```sql
-- Direction metric
UPDATE usage_metrics
SET quantity         = quantity         - 1,
    total_cost_cents = total_cost_cents - $old_cost
WHERE tenant_id   = $tenant_id
  AND metric_type = $direction       -- 'calls_inbound' or 'calls_outbound'
  AND period_start = ($old_date || 'T00:00:00Z')::timestamptz;

-- AI minutes metric
UPDATE usage_metrics
SET quantity         = quantity         - $old_minutes,
    total_cost_cents = total_cost_cents - $old_openai
WHERE tenant_id   = $tenant_id
  AND metric_type = 'ai_minutes'
  AND period_start = ($old_date || 'T00:00:00Z')::timestamptz;
```

Direction comes from `call_sessions.direction` for the corrected row.

## Step 4 — Verify the NEW day already has the corrected totals

The ingest path applied (+1, +new_minutes, +new_cost) to the NEW day on the
original ingest pass — that already happened. Spot-check:

```sql
SELECT date, total_calls, total_ai_minutes, total_cost_cents
FROM daily_org_usage
WHERE tenant_id = $tenant_id
  AND date IN ($old_date, $new_date);
```

The NEW day should now reflect the call once. The OLD day should no longer
include the call.

## Step 5 — Acknowledge the alert

In the admin UI, open Operations → Alerts and dismiss the
`billing_backfill_cross_day` alert. The dismiss action sets
`acknowledged = true, acknowledged_by = <your user id>` so the audit trail
records who handled the rebalance.

## When NOT to rebalance

If the cross-day shift was caused by a clock-skew correction of less than a
few minutes (e.g. 23:59:59 → 00:00:01 the next day) AND no daily caps,
invoices, or month-boundary reports have been finalised against the OLD
day, the drift is cosmetic. Acknowledge the alert and move on.

## Prevention

If a tenant produces these alerts repeatedly, escalate to platform
engineering — it usually points at a clock-skew bug in the upstream system
or a misconfigured backfill window.
