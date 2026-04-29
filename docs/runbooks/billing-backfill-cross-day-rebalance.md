# Runbook — Backfill correction shifted call across calendar days

Audience: Finance / billing ops
Surface: `operations_alerts.type = 'billing_backfill_cross_day'` (Operations →
Alerts panel, severity `info`)

## TL;DR — verify only, no manual rebalance

The ingest pipeline now **auto-rebalances** the OLD-day buckets in the same
transaction as the call upsert. There is nothing for finance to run by hand.
The alert is informational so finance still has visibility on cross-day
restatements; this runbook walks through the SQL queries to confirm the
auto-rebalance landed correctly, and what to do in the rare case it didn't.

> Looking for the historical manual rebalance procedure (the one with the
> `UPDATE daily_org_usage` / `UPDATE usage_metrics` statements)? See
> [Appendix A](#appendix-a--legacy-manual-rebalance-procedure-no-longer-required).
> It is retained for audit / forensic use only.

## What happened

A backfill correction (POST `/v1/ingest/calls/backfill`, or a corrective
re-issue against `/v1/ingest/calls`) re-ingested a call whose `external_id`
already existed in `call_sessions`, AND the new event's `start_time` falls on
a different calendar day from the original.

The ingest pipeline at `server/admin-api/routes/ingest.ts`:

1. Updates the existing `call_sessions` row in place with the corrected
   values.
2. Credits the **NEW** day's `daily_org_usage` and `usage_metrics` rows with
   the FULL new amount (+1 call, +new_minutes, +new_cost, +new_openai).
3. Debits the **OLD** day's `daily_org_usage` and `usage_metrics` rows by
   the FULL original amount (-1 call, -old_minutes, -old_cost,
   -old_openai).

All three steps run inside the same `BEGIN … COMMIT` block, so either every
row moves or none of them do — there is no double-count window.

## Information you'll find on the alert

The `operations_alerts.metadata` JSON contains:

| Field             | Meaning                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `tenant_id`       | Affected tenant.                                                       |
| `external_id`     | Upstream call identifier — also on `call_sessions.external_id`.        |
| `old_date`        | Calendar day the original call was attributed to (UTC).                |
| `new_date`        | Calendar day the corrected call is now attributed to (UTC).            |
| `source`          | `remix` (live correction) or `remix-backfill`.                         |
| `auto_rebalanced` | Always `true` for alerts produced by the current ingest path.          |
| `runbook_url`     | This document.                                                         |

The `call_session_id` column on the alert points at the affected row in
`call_sessions`, which is the source of truth for the corrected values.

## Step 1 — Confirm the corrected call landed

```sql
SELECT id, external_id, start_time, duration_seconds, total_cost_cents
FROM call_sessions
WHERE tenant_id = $tenant_id AND external_id = $external_id;
```

`start_time` should match `metadata.new_date`, and `duration_seconds` /
`total_cost_cents` should reflect the corrected (post-shift) values.

## Step 2 — Confirm the daily buckets balance

Both days should now reflect the corrected attribution:

* the NEW day includes the corrected call once
* the OLD day no longer includes the original call

```sql
SELECT date, total_calls, total_ai_minutes, total_cost_cents
FROM daily_org_usage
WHERE tenant_id = $tenant_id
  AND date IN ($old_date, $new_date);
```

You can also spot-check `usage_metrics`:

```sql
SELECT period_start, metric_type, quantity, total_cost_cents
FROM usage_metrics
WHERE tenant_id = $tenant_id
  AND period_start IN (
    ($old_date || 'T00:00:00Z')::timestamptz,
    ($new_date || 'T00:00:00Z')::timestamptz
  )
ORDER BY period_start, metric_type;
```

If the totals look right (and they almost always will), there is nothing to
do — go to Step 3 and acknowledge.

## Step 3 — Acknowledge the alert

In the admin UI, open Operations → Alerts and dismiss the
`billing_backfill_cross_day` alert. The dismiss action sets
`acknowledged = true, acknowledged_by = <your user id>` so the audit trail
records who verified the rebalance.

## When the auto-rebalance looks wrong

If Step 2 shows totals that do not match the audit trail (for example, the
OLD-day bucket still includes the call's minutes, or the NEW-day bucket
double-counts it), that is a bug — the auto-rebalance should leave the rows
balanced. Capture:

* the alert metadata (`tenant_id`, `external_id`, `old_date`, `new_date`,
  `auto_rebalanced` flag, `source`)
* the current `daily_org_usage` rows for both days
* the `ingest_events` audit trail for the `external_id`:

```sql
SELECT idempotency_key, processed_at, status, payload
FROM ingest_events
WHERE org_id = $tenant_id
  AND payload->>'external_id' = $external_id
ORDER BY processed_at ASC;
```

…and escalate to platform engineering. Do not run the legacy manual
rebalance from Appendix A on a row the auto-rebalance has already touched —
that would back the call out of the OLD day twice.

## Prevention

If a tenant produces these alerts repeatedly, escalate to platform
engineering — it usually points at a clock-skew bug in the upstream system
or a misconfigured backfill window. The rebalance is automatic and safe,
but a flood of cross-day shifts is a signal the upstream system needs
fixing.

## Appendix B — Sweeping pre-existing negative-quantity rollup rows

Audience: Finance / billing ops
Surface: `operations_alerts.type = 'billing_negative_usage_row_detected'`
(severity `warning`)

The forward-looking guard in `server/admin-api/routes/ingest.ts` ensures
the cross-day rebalance path can never *create* a new
`daily_org_usage` / `usage_metrics` row with a negative quantity. But
rows that landed in the database *before* the guard shipped are still
sitting there, and downstream invoicing has to special-case them.

The one-off sweeper at `scripts/sweep-negative-usage-rows.ts`:

* lists every `daily_org_usage` and `usage_metrics` row whose `quantity`
  / `total_calls` / `total_ai_minutes` / `total_cost_cents` is negative,
  grouped by tenant and date;
* opens one `billing_negative_usage_row_detected` alert per affected
  tenant (severity `warning`) with the row counts, date range, and a
  capped sample of the offending rows in `metadata`;
* is idempotent: tenants with an already-open
  `billing_negative_usage_row_detected` alert are skipped so re-runs
  don't churn duplicate alerts at finance.

### Running the sweeper

```bash
# Development (against the local Replit DB)
APP_ENV=development DATABASE_URL=postgres://... \
  npx tsx scripts/sweep-negative-usage-rows.ts --dry-run

# Production
APP_ENV=production PLATFORM_DB_POOL_URL=postgres://... \
  npx tsx scripts/sweep-negative-usage-rows.ts
```

`--dry-run` prints the audit report without inserting any alerts.
`--tenant=<id>` scopes both the audit and the alert to a single
tenant — useful when re-running after a manual cleanup pass.

### Audit query (run-anywhere, no dependencies)

If you'd rather just see the rows without touching `operations_alerts`:

```sql
-- Negative daily_org_usage rows
SELECT tenant_id, date, total_calls, total_ai_minutes, total_cost_cents
  FROM daily_org_usage
 WHERE total_calls < 0
    OR total_ai_minutes < 0
    OR total_cost_cents < 0
 ORDER BY tenant_id, date;

-- Negative usage_metrics rows
SELECT tenant_id, metric_type, period_start, quantity, total_cost_cents
  FROM usage_metrics
 WHERE quantity < 0
    OR total_cost_cents < 0
 ORDER BY tenant_id, period_start, metric_type;
```

### Cleaning up a flagged row by hand

For each negative row the sweeper surfaces, finance has two options:

1. **Zero it out** when the OLD-day rollup row is purely residue from a
   pre-guard cross-day correction (the call has already been credited
   to the NEW day in `call_sessions`, so the OLD-day row is just a
   stale debit):

   ```sql
   UPDATE daily_org_usage
      SET total_calls       = GREATEST(total_calls,       0),
          total_ai_minutes  = GREATEST(total_ai_minutes,  0),
          total_cost_cents  = GREATEST(total_cost_cents,  0)
    WHERE tenant_id = $tenant_id AND date = $old_date;

   UPDATE usage_metrics
      SET quantity         = GREATEST(quantity,         0),
          total_cost_cents = GREATEST(total_cost_cents, 0)
    WHERE tenant_id   = $tenant_id
      AND metric_type = $metric_type
      AND period_start = ($old_date || 'T00:00:00Z')::timestamptz;
   ```

2. **Re-derive** the day's totals from `call_sessions` when the negative
   value indicates a deeper drift (e.g. a bulk delete that took out
   real calls along with the residue). Recompute the day's totals from
   the surviving `call_sessions` rows for that tenant/day and replace
   the rollup row's columns wholesale.

After cleanup, re-run the audit query above to confirm the row is no
longer negative, then acknowledge the
`billing_negative_usage_row_detected` alert in the admin UI. Re-running
`scripts/sweep-negative-usage-rows.ts` after acknowledgement will open
a fresh alert if any negative rows remain — a useful self-check.

## Appendix A — Legacy manual rebalance procedure (no longer required)

> **Retained for audit / forensic use only.** As of the auto-rebalance
> rollout, the ingest path performs these reversals automatically inside
> the same transaction as the call upsert. Running these statements
> against a row the pipeline has already auto-rebalanced will
> double-debit the OLD day. Use only when explicitly instructed by
> platform engineering.

Original procedure:

```sql
-- Pre-correction values, read from the FIRST ingest_events row
-- for this external_id.
old_minutes  = ceil(original.duration_seconds / 60)
old_cost     = original.costs.total_cents
old_openai   = original.costs.openai_cents

UPDATE daily_org_usage
SET total_calls       = total_calls       - 1,
    total_ai_minutes  = total_ai_minutes  - $old_minutes,
    total_cost_cents  = total_cost_cents  - $old_cost
WHERE tenant_id = $tenant_id AND date = $old_date;

UPDATE usage_metrics
SET quantity         = quantity         - 1,
    total_cost_cents = total_cost_cents - $old_cost
WHERE tenant_id   = $tenant_id
  AND metric_type = $direction       -- 'calls_inbound' or 'calls_outbound'
  AND period_start = ($old_date || 'T00:00:00Z')::timestamptz;

UPDATE usage_metrics
SET quantity         = quantity         - $old_minutes,
    total_cost_cents = total_cost_cents - $old_openai
WHERE tenant_id   = $tenant_id
  AND metric_type = 'ai_minutes'
  AND period_start = ($old_date || 'T00:00:00Z')::timestamptz;
```
