# Database security suites (tenant isolation / RLS)

These tests prove that one tenant cannot read or write another tenant's rows,
both at the SQL (Row-Level Security) layer and over the HTTP API. They skip
when no database URL is set, so `npm test` on a laptop without Postgres stays
green. **CI is the merge gate.**

## What runs in CI

GitHub Actions workflow: `.github/workflows/db-security.yml` (on every PR and
every push to `main`).

On a throwaway Postgres 16 container it:

1. Creates Supabase-compatible stub roles (`anon`, `authenticated`,
   `service_role`) and a passworded `qvo_app` login
   (`npm run db:setup-ci-roles`).
2. Applies every migration (`npm run db:migrate`).
3. Re-applies the role script so `qvo_app` still has a password after
   migration 120 (which creates the role but never sets one).
4. Runs `npm run db:verify-rls` — SELECT and INSERT isolation as
   `platform_rls_tester`.
5. Runs `npm run test:security:db` — the Vitest suites below. The job fails
   if those suites skip instead of running.

No production secrets are used. The `qvo_app` password in
`scripts/ci-setup-postgres-roles.sql` is a well-known CI-only value.

## npm scripts (local)

| Script | What it does |
|--------|----------------|
| `npm run db:setup-ci-roles` | Create `anon` / `authenticated` / `service_role` / `qvo_app` on the database in `DATABASE_URL_PRIVILEGED` (falls back to `DATABASE_URL`). Superuser required. |
| `npm run db:migrate` | Apply `migrations/*.sql` as the privileged role. |
| `npm run db:verify-rls` | Cross-tenant SELECT + INSERT probes (`scripts/verify-rls.ts`). Uses SSL only when `APP_ENV` is not `development`, same as `db:migrate`, so the GitHub Actions `postgres:16` service (TLS off) can connect. |
| `npm run test:security:isolation` | `tenantIsolation`, `crossTenantEndpoints`, `adminEndpointGuard`. |
| `npm run test:security:rls` | `qvoAppRlsRealDb` (needs `QVO_RLS_TEST_DATABASE_URL`) and the 117-remediation SQL-shape tests. |
| `npm run test:security:db` | Isolation + RLS suites together (what CI runs). |

### One-shot local run against a disposable Postgres

```bash
# Privileged superuser URL (migrations + role setup)
export APP_ENV=development
export DATABASE_URL_PRIVILEGED=postgres://postgres:postgres@127.0.0.1:5432/voiceaihub_test
# Restricted app pool (must be qvo_app after db:setup-ci-roles)
export DATABASE_URL=postgres://qvo_app:qvo_app@127.0.0.1:5432/voiceaihub_test
export QVO_RLS_TEST_DATABASE_URL=$DATABASE_URL_PRIVILEGED
export QVO_RLS_TEST_APP_URL=$DATABASE_URL
export ADMIN_JWT_SECRET=local-db-security-jwt-not-a-secret

createdb voiceaihub_test   # or equivalent
npm run db:setup-ci-roles
npm run db:migrate
npm run db:setup-ci-roles
npm run db:verify-rls
npm run test:security:db
```

`QVO_RLS_TEST_DATABASE_URL` must be local (`127.0.0.1` / `localhost`). The
`qvo_app` real-DB file refuses remote hosts because it alters roles and table
ownership.

## Suites

| File | Layer | Needs a live DB? |
|------|--------|------------------|
| `tests/security/tenantIsolation.test.ts` | RLS enabled, cross-tenant SQL read/write, audit_logs immutability, plus pure unit checks (encryption, API-key scopes, tenant guard) | SQL cases skip without a URL |
| `tests/security/crossTenantEndpoints.test.ts` | HTTP: tenant A's JWT must not list or fetch tenant B's resources | Yes |
| `tests/security/qvoAppRlsRealDb.test.ts` | Daily isolation suite (`runAllIsolationTests`) against real `qvo_app` | Yes (`QVO_RLS_TEST_DATABASE_URL`) |
| `tests/security/adminEndpointGuard.test.ts` | `requirePlatformAdmin` / route wiring | No |
| `tests/security/tenantRlsRemediationMigration.test.ts` | Migration 117 SQL shape | No |
| `scripts/verify-rls.ts` | SELECT + INSERT as `platform_rls_tester` | Yes |
| `platform/security/TenantIsolationService.*.test.ts` | Mocked service logic | No (already in `npm test`) |

## Known failures (Replit / pre-`qvo_app` rollout)

On Replit the app still connects as `postgres` (`rolbypassrls=true`). The
daily isolation suite therefore fails:

1. **Connected role subject to RLS** — the pool is not `qvo_app`.
2. **Cross-tenant read blocked on `agents`** — seen on that Replit database.
3. **Cross-tenant read blocked on `audit_logs`** — same.

CI does **not** connect as `postgres`. It uses `qvo_app` on a freshly migrated
database, so (1) is expected to pass. (2) and (3) are listed here so a red
isolation suite on Replit is not confused with a CI regression.

Follow-up (out of scope for this CI job; do not weaken other probes to hide
them): finish the `qvo_app` rollout (`docs/runbooks/qvo-app-rls-rollout.md`)
and fix any remaining `agents` / `audit_logs` leaks on the long-lived Replit
database.

If a check still fails on a **fresh** migrated database, mark **only that
check** as an expected failure in the Vitest file with a TODO pointing at this
follow-up. Do not skip the rest of the suite.

## Related docs

- `docs/tenant-admin-isolation-audit.md` — HTTP vs SQL isolation audit
- `docs/runbooks/qvo-app-rls-rollout.md` — switching the app pool to `qvo_app`
- `docs/audit/06-security-compliance.md` (S-09) — RLS coverage
