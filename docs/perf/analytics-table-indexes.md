# Analytics Table Indexing — `(tenant_id, time DESC, kind)`

This note records the EXPLAIN evidence captured when migration
`081_analytics_composite_indexes.sql` rolled out. It extends the
indexing pattern that migration `078` introduced for `usage_metrics` to
the rest of the high-volume per-tenant tables that drive customer-facing
dashboards.

> Source backlog item: `docs/audit/05-integration-and-performance.md` —
> **I-23 family**.
> Companion migration: `migrations/078_call_events_partition_and_usage_metrics_index.sql`.

## Indexes added (migration 081)

| Table                 | Index                                                      | Time column     | Kind tail       |
| --------------------- | ---------------------------------------------------------- | --------------- | --------------- |
| `call_sessions`       | `idx_call_sessions_tenant_created_state`                   | `created_at`    | `lifecycle_state` |
| `tool_invocations`    | `idx_tool_invocations_tenant_invoked_status`               | `invoked_at`    | `status`        |
| `workflow_executions` | `idx_workflow_executions_tenant_started_status`            | `started_at`    | `status`        |
| `audit_logs`          | `idx_audit_logs_tenant_occurred_action`                    | `occurred_at`   | `action`        |
| `analytics_metrics`   | `idx_analytics_metrics_tenant_recorded_name`               | `recorded_at`   | `metric_name`   |
| `call_events`         | `idx_call_events_tenant_occurred_type` (partitioned parent)| `occurred_at`   | `event_type`    |

`error_logs` already carries the equivalent
`(tenant_id, severity, occurred_at DESC)` index from migration 012 and is
intentionally skipped.

## EXPLAIN evidence

All plans below were captured against a freshly-migrated database. For
the cases where the local table was empty, plans were re-captured after
seeding realistic multi-tenant data so the planner had statistics to
work with.

### `tool_invocations` — listing newest invocations per tenant

```text
EXPLAIN SELECT id, tool_name, status, invoked_at
  FROM tool_invocations
 WHERE tenant_id='t1' AND invoked_at >= NOW() - INTERVAL '30 days'
 ORDER BY invoked_at DESC LIMIT 50;

Limit  (cost=0.14..2.36 rows=1 width=262)
  ->  Index Scan using idx_tool_invocations_tenant_invoked_status on tool_invocations
        Index Cond: (((tenant_id)::text = 't1'::text)
                 AND (invoked_at >= (now() - '30 days'::interval)))
```

### `workflow_executions` — failed executions per tenant

```text
EXPLAIN SELECT id, workflow_name, status, started_at
  FROM workflow_executions
 WHERE tenant_id='t1' AND started_at >= NOW() - INTERVAL '7 days' AND status='failed'
 ORDER BY started_at DESC LIMIT 50;

Limit  (cost=0.15..2.37 rows=1 width=262)
  ->  Index Scan using idx_workflow_executions_tenant_started_status on workflow_executions
        Index Cond: (((tenant_id)::text = 't1'::text)
                 AND (started_at >= (now() - '7 days'::interval))
                 AND (status = 'failed'::workflow_execution_status))
```

### `audit_logs` — newest-first audit listing

```text
EXPLAIN SELECT id, action, occurred_at
  FROM audit_logs
 WHERE tenant_id='t1'
 ORDER BY occurred_at DESC LIMIT 50;

Limit  (cost=0.14..2.36 rows=1 width=258)
  ->  Index Scan using idx_audit_logs_tenant_occurred_action on audit_logs
        Index Cond: ((tenant_id)::text = 't1'::text)
```

### `analytics_metrics` — per-name rollup window

```text
EXPLAIN SELECT recorded_at, metric_value
  FROM analytics_metrics
 WHERE tenant_id='t1'
   AND metric_name='calls_per_minute'
   AND recorded_at >= NOW() - INTERVAL '7 days'
 ORDER BY recorded_at DESC;

Index Scan using idx_analytics_metrics_tenant_recorded_name on analytics_metrics
  Index Cond: (((tenant_id)::text = 't1'::text)
           AND (recorded_at >= (now() - '7 days'::interval))
           AND ((metric_name)::text = 'calls_per_minute'::text))
```

### `call_events` — InsightsEngine tool-event window (partitioned parent)

```text
EXPLAIN SELECT call_session_id, event_type, occurred_at
  FROM call_events
 WHERE tenant_id='t1'
   AND occurred_at >= NOW() - INTERVAL '7 days'
   AND event_type IN ('TOOL_START','TOOL_END');

Append  (cost=0.00..6.58 rows=3 width=178)
  Subplans Removed: 1                  -- partition pruning kicked in
  ->  Index Scan using call_events_2026_04_tenant_id_idx on call_events_2026_04
  ->  Index Scan using call_events_2026_05_tenant_id_idx on call_events_2026_05
```

The composite index propagates to every monthly partition, and the
planner combines partition pruning with the per-partition index scan.

### `call_sessions` — re-captured with seeded data

The local table was empty at first capture, which made the planner pick
the cheapest tenant-scoped index regardless. After seeding 50,000 rows
across two tenants over ~365 days (`scripts`-equivalent
`generate_series` insert, then `ANALYZE call_sessions`), the planner
flips to the new composite for both 1-day and 7-day windows:

```text
EXPLAIN SELECT COUNT(*) FILTER (WHERE lifecycle_state='CALL_COMPLETED')
  FROM call_sessions
 WHERE tenant_id='t_idxbench'
   AND created_at >= NOW() - INTERVAL '1 day' AND created_at < NOW();

Aggregate  (cost=92.10..92.11 rows=1 width=8)
  ->  Index Only Scan using idx_call_sessions_tenant_created_state on call_sessions
        Index Cond: ((tenant_id = 't_idxbench'::text)
                 AND (created_at >= (now() - '1 day'::interval))
                 AND (created_at < now()))
```

```text
EXPLAIN SELECT DATE(created_at) AS day, COUNT(*)
  FROM call_sessions
 WHERE tenant_id='t_idxbench'
   AND created_at >= NOW() - INTERVAL '7 days' AND created_at < NOW()
 GROUP BY DATE(created_at) ORDER BY day;

GroupAggregate  (cost=647.21..665.71 rows=925 width=12)
  Group Key: (date(created_at))
  ->  Sort
        ->  Index Only Scan using idx_call_sessions_tenant_created_state on call_sessions
```

`Index Only Scan` here is the win: the index covers `tenant_id`,
`created_at`, and `lifecycle_state`, so the dashboard summary query
never has to touch the heap.

## Rollout / locking notes

- All six statements use `CREATE INDEX IF NOT EXISTS`; reruns are no-ops.
- The migration deliberately does **not** use `CREATE INDEX
  CONCURRENTLY` because (a) the migration runner wraps each file in a
  transaction (CONCURRENTLY is illegal there) and (b) `call_events` is a
  partitioned parent which only accepts non-concurrent
  `CREATE INDEX`. For the production rollout, schedule the migration in
  a low-traffic window — the new indexes take a brief `SHARE` lock on
  each table while they build.
- Future per-tenant time-series tables should follow the same
  `(tenant_id, <time> DESC, <kind>)` triple. This is now codified in
  `replit.md` under **Database**.
