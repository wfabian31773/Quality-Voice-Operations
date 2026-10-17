# Runbook: switch QVO to the restricted `qvo_app` role (tenant RLS)

PR #88. Until this runbook is finished, the app connects as `postgres`
(`rolbypassrls=true`), every RLS policy is ignored, and the daily tenant
isolation suite fails. After it, the app pool is `qvo_app` (`NOBYPASSRLS`) and
RLS is enforced.

Host: **Render** (Virginia) — `qvo-api`, `qvo-voice`, `qvo-worker`,
`qvo-nightly`, all reading env group **`qvo-secrets`**. Replit is legacy /
fallback only (see the end).

## What each variable is

Names are exactly what the code reads (`platform/db/index.ts`,
`scripts/run-migrations.ts`, `platform/runtime/leaderLock.ts`).

| Variable | Where | Role / value after rollout | Read by |
|---|---|---|---|
| `PLATFORM_DB_POOL_URL` | `qvo-secrets` (all four services) | **`qvo_app`**, Supavisor transaction pooler `:6543` | default app pool (`getPlatformPool`) when `APP_ENV` ≠ `development` |
| `DATABASE_URL_PRIVILEGED` | `qvo-secrets` (all four services) | **`postgres`** — the value `PLATFORM_DB_POOL_URL` has today | privileged pool (`getPrivilegedPool` / `withPrivilegedClient`: login, workers, platform-admin, pre-tenant webhooks, voice number lookup) and `npm run db:migrate` (pre-deploy) |
| `DATABASE_URL` | **not set on Render** | — | development only (`APP_ENV=development`, Replit/local). Render runs `APP_ENV=production`, so it is never read there |
| `WORKER_LEADER_DB_URL` | `qvo-worker` only | **unchanged**: session-mode URL (session pooler `:5432` or direct), **never `:6543`** | worker leader advisory lock. It touches no tables, so the role switch does not affect it |

Every service needs `DATABASE_URL_PRIVILEGED`: `qvo-api` (login, webhooks,
platform admin, migrations), `qvo-voice` (inbound number → tenant lookup),
`qvo-worker` (cross-tenant schedulers), `qvo-nightly` (cross-tenant jobs). Put it
in `qvo-secrets`, not per service.

Boot check (`scripts/validate-env.ts`): if `PLATFORM_DB_POOL_URL` logs in as
`qvo_app` and `DATABASE_URL_PRIVILEGED` is missing or also `qvo_app`, boot fails
with `FAIL DATABASE_URL_PRIVILEGED` (name only, no value). Before the switch it is
only a warning.

## Steps (in this order)

Do not print or paste secret values into tickets, chat, or logs.

1. **Merge and deploy #88 with env unchanged.** The `qvo-api` pre-deploy
   `npm run db:migrate` applies `120_qvo_app_restricted_role.sql` (creates role
   `qvo_app` with `LOGIN NOBYPASSRLS`, grants, `FORCE ROW LEVEL SECURITY`). It
   still runs as `postgres` from `PLATFORM_DB_POOL_URL`. The app keeps working
   because `postgres` bypasses RLS (FORCE included). The isolation suite stays
   red (`Connected role subject to RLS` fails) — expected.
2. **Supabase: set the `qvo_app` password.** Supabase dashboard → SQL editor,
   QVO project:
   ```sql
   ALTER ROLE qvo_app WITH PASSWORD '<new strong random password>';
   ```
   Store it in the password manager only. The migration never sets a password.
3. **Render → Env Groups → `qvo-secrets`: add `DATABASE_URL_PRIVILEGED`** = the
   current `PLATFORM_DB_POOL_URL` value (the `postgres` URL). Save.
4. **Render → `qvo-secrets`: change `PLATFORM_DB_POOL_URL`** to the `qvo_app`
   transaction-pooler URL — same host, port `6543` and database as today, user
   `qvo_app.<project-ref>` (Supavisor's `role.project-ref` form), the password from
   step 2:
   `postgresql://qvo_app.<project-ref>:<password>@<pooler-host>:6543/postgres`.
   Save.
5. **Leave `WORKER_LEADER_DB_URL` as it is** (session pooler `:5432` or direct;
   never `:6543`). Do **not** add `DATABASE_URL` on Render.
6. **Deploy** `qvo-api`, `qvo-voice` and `qvo-worker` (Manual Deploy → Deploy
   latest commit; `autoDeployTrigger` is off). `qvo-nightly` picks up the group on
   its next run. Steps 3–4 can be one save; deploy only after both are set.

## Verify after deploy

1. **Health stays 200:** `GET https://api.qualityvoiceoperations.com/health`
   and `/healthz`; `GET https://voice.qualityvoiceoperations.com/health`. Render
   events show no failed pre-deploy (`db:migrate`) and no `FAIL
   DATABASE_URL_PRIVILEGED` in boot logs.
2. **Isolation suite is green:** Platform Admin → Platform Compliance → Tenant
   Isolation → run now (`POST /platform/compliance/isolation-tests/run`, runs in
   `qvo-api` with the Render env). Every row passes, including
   `Connected role subject to RLS` (connected as `qvo_app`), every
   `FORCE RLS on <table>`, and `Cross-tenant read blocked on agents / audit_logs /
   api_keys`. The daily scheduled run then logs `Scheduled tenant isolation tests
   passed` and sends **no** `[QVO Security] … FAILED` email. The daily run comes
   from whichever host runs the `tenant-isolation` scheduler (`qvo-worker` once
   `SCHEDULERS_ENABLED` includes it; Replit until cutover — that host must also be
   switched or its email stays red).
3. **Tenant data still loads:** log in as a normal tenant user; tickets,
   agents, calls and dispatch lists show the tenant's rows (not empty). Place one
   test inbound call; the agent answers (voice number lookup uses the privileged
   pool).
4. **Logs:** no new `permission denied` / empty-result errors in `qvo-api`,
   `qvo-voice`, `qvo-worker`; schedulers keep reporting work.

## Roll back

1. Render → `qvo-secrets`: set `PLATFORM_DB_POOL_URL` back to the `postgres`
   URL (the value in `DATABASE_URL_PRIVILEGED`). Keep `DATABASE_URL_PRIVILEGED`.
2. Deploy `qvo-api`, `qvo-voice`, `qvo-worker`.
3. RLS is bypassed again (as before) and the isolation suite goes back to red.
   No database change is needed: role `qvo_app` stays unused, and `FORCE ROW LEVEL
   SECURITY` does not affect `postgres` (BYPASSRLS). Do not revert migration 120.

## Legacy / fallback: Replit

Only if Replit is serving traffic or running schedulers. Replit Secrets use the
same names: `DATABASE_URL_PRIVILEGED` = current postgres URL first, then
`PLATFORM_DB_POOL_URL` (production deployment) → `qvo_app`; in a Replit dev
workspace `DATABASE_URL` is the pool URL instead. Roll back the same way.

## How request paths are bound (for reviewers)

`platform/db/tenantScope.ts` + `bindPoolQueriesToTenantScope` in `platform/db/index.ts`
decide what `getPlatformPool()` does in each async context:

| Context | Pool | RLS |
|---|---|---|
| Authenticated **tenant** request (`requireTenantContext` / API-key auth → `runWithTenantScope`) | `qvo_app`. `query()` runs in `BEGIN` / `SET LOCAL app.tenant_id` / `COMMIT`; a checked-out client gets `app.tenant_id` right after `BEGIN` (autocommit statements wrapped the same way), and is unbound on `release()` | **enforced** |
| Isolation suite (`runWithRestrictedScope`) | `qvo_app`, no tenant | enforced (that is what it tests) |
| Everything else: webhooks, public routes, voice gateway, MFA-verified platform admins, schedulers / nightly jobs (`runWithPrivilegedScope`), timers | privileged (`DATABASE_URL_PRIVILEGED`) | bypassed — **same as today** |

So the switch enforces RLS for tenant-user traffic without changing any other
path. Code that already uses `withTenantContext` / `withTenantClient` /
`getPrivilegedPool()` is unchanged. Moving webhooks, the voice gateway and public
routes onto `qvo_app` is follow-up work, path by path.

Proof against a real Postgres: `tests/security/qvoAppRlsRealDb.test.ts` (local
disposable DB only; see the file header for the command).
