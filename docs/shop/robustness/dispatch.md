# Dispatch actions — robustness

**Spec:** [tools-spec.md](../tools-spec.md) §0, §2.4 (shared action contract), §4.4  
**Code:** `platform/actions/dispatch/`  
**Status:** implemented, **not registered**. `dispatchActions` is still `[]`, so these actions are not in `ACTION_REGISTRY`, not on `/api/actions`, and not on the agent tool list. Call them by importing the named exports and passing them to `runAction`’s `registry`. Agent exposure is a later, deliberate step.

## What is now guaranteed

| Action | Kind | Guarantee |
|---|---|---|
| `dispatch.create_job.prepare` | prepare | Validates intake (job type, window start < end, address with optional unit, E.164 contact, problem ≤2000, accessNotes ≤500, urgency). Returns a spoken readback (EN/ES) that includes the unit and a **window**, never an exact time, plus a confirmation token. |
| `dispatch.create_job.commit` | commit | Token-keyed idempotency (same token → same job, one `dispatch_jobs` row, one `dispatch_job_events` `created` row). Inserts the job and the audit event in one tenant transaction. An open job for the same tenant + normalized address + overlapping window returns that job id with `duplicate: true` instead of a second row. Concurrent commits take `pg_advisory_xact_lock` on tenant+address so only one job is created. |
| `dispatch.update_status` | write (staff/system) | `SELECT … FOR UPDATE`, then a conditional `UPDATE … AND status = <from>`. Transition must be in `VALID_TRANSITIONS` (`transitions.ts`, the same table the admin dispatch route uses). Concurrent conflicting updates: one wins, the other gets `CONFLICT`. A `status_change` event is written in the same transaction. |
| `dispatch.get_job_status` | read | Phone + name, same identity rules as scheduling find: the agent needs a caller-ID match (from `call_sessions`, never model input) **and** a name match; staff/UI/MCP skip caller ID. Output is `{ status, window }` — no job id, no other customers. Failure is always `NOT_FOUND` with the same caller-safe message (spec §4.4 #7). |

Status transitions live in `platform/actions/dispatch/transitions.ts`. `server/admin-api/routes/dispatch.ts` imports `VALID_TRANSITIONS` and `TERMINAL_JOB_STATUSES` from there; that import is the only change in the route.

No geocoding and no service-area check. Jobs are stored on the existing `dispatch_jobs` / `dispatch_job_events` tables (no migration).

## Spec §4.4 edge cases → tests

| # | Edge case | Coverage |
|---|---|---|
| 1 | Address out of area | **Open.** `dispatch.check_service_area` is not built. |
| 2 | Apartment / gate codes | Readback includes the unit (`actions.test.ts` “prepares a readback that includes the unit…”; `readback.test.ts`). Gate codes ride in `accessNotes`. Different units are not duplicates (`actions.test.ts` “does not treat a different unit…”). |
| 3 | Caller is a tenant, not the property owner | **Open** (intake does not distinguish owner vs occupant). |
| 4 | Duplicate job from the same address | Sequential: `actions.test.ts` “returns the existing job with duplicate: true…”. Concurrent: `postgres.integration.test.ts` “serializes two overlapping commits…”. Non-overlap / other tenant: `actions.test.ts` and `postgres.integration.test.ts` “does not dedupe a job in another tenant…”. |
| 5 | Tech running late / shifting windows | **Open.** `dispatch.update_status` accepts an optional `eta` but does not reshuffle other jobs. |
| 6 | Same-day emergency after hours | **Open.** `dispatch.page_on_call` / `check_windows` are not built. |
| 7 | “Where’s my tech?” with a different caller ID | `actions.test.ts` “returns the same NOT_FOUND whether the name is wrong, the caller ID does not match, or there is no job”; `postgres.integration.test.ts` “hides a job from an agent whose caller ID does not match”. Cross-tenant: both files, `NOT_FOUND` on get and update. |
| 8 | Address cannot be geocoded | **Open.** Geocoding is out of scope (follow-up). |

Other tests: every allowed and disallowed transition (`transitions.test.ts`); out-of-range input (`schemas.test.ts`, `actions.test.ts`, `postgres.integration.test.ts`); retried token (`actions.test.ts`, `postgres.integration.test.ts`); status concurrency (`postgres.integration.test.ts`).

## Follow-ups

1. **Registry / templates.** Add the four actions to `dispatchActions` and therefore `ACTION_REGISTRY` once the voice/UI adapters are ready. Do not expose them to agents until then.
2. **`dispatch.check_service_area`** and **`dispatch.check_windows`** (spec §4.4). Need territory/zip data and tech capacity; no geocoding in this PR.
3. **Re-point `createDispatchJob`** (`platform/tools/library/handlers/createDispatchJob.ts`) at `dispatch.create_job` so the legacy voice tool stops writing `dispatch_jobs` itself.
4. **`dispatch.page_on_call`** for after-hours emergencies.
5. **`dispatch.assign_job`** (skill / load / territory).
6. Geocoding and service-area enforcement on create (today the address is stored as given, normalized only for duplicate detection).
