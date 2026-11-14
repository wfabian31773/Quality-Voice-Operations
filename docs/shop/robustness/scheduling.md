# Scheduling robustness

What owner/staff booking routes and agent scheduling actions guarantee today,
which [tools-spec](../tools-spec.md) §1.6 edge cases have tests, and what is
still open. Agent writes live in `platform/actions/scheduling/**`. Owner writes
are the admin booking handlers in `server/admin-api/routes/scheduling.ts`.

## Guarantees now in force

- **Validation.** `POST/PUT /scheduling/bookings`, `POST /scheduling/bookings/:id/transition`, and `DELETE /scheduling/bookings/:id` parse params and bodies with zod (`schedulingSchemas.ts`). Bad input is **400** `{ error, fields }`. Datetime-local values from the Scheduling page (`YYYY-MM-DDTHH:MM`) stay valid.
- **Zero double-book of a live phone hold (spec §1.6 #10).** Creating or confirming into a slot held by a live phone call (`status = 'held'`, `hold_expires_at > now()`) is **409** `{ code: 'CONFLICT', heldBy: 'phone_call', holdExpiresAt, error }` with a tenant-timezone message such as `Held by a phone call until 3:34 PM`. A 23P01 exclusion hit is mapped the same way when the overlapping row is that hold; otherwise it stays `{ error, reason: 'slot_unavailable' }`.
- **UI idempotency.** Optional `Idempotency-Key` on `POST /scheduling/bookings` is stored as `ui:` + key on `bookings.idempotency_key` (migration 122 unique index). Same key + same body returns the existing booking (no second row). Same key + different body is **409** `{ code: 'IDEMPOTENCY_KEY_REUSED' }`. The prefix cannot collide with agent confirmation tokens.
- **Atomic transitions.** `transitionBooking` updates with `WHERE id AND tenant_id AND status = expected`. Two concurrent transitions: one commits, the other gets **409**.
- **Tenant isolation.** Update, transition, and delete of another tenant's booking id are **404** and do not write.
- **Audit.** Create, update, transition, and delete write `scheduling_audit_log` with `changed_by` set to the acting user. Delete now records the previous status.

## Spec §1.6 edge cases → tests

| # | Edge case | Agent tests | Owner/staff tests |
|---|---|---|---|
| 1 | Two callers, same 3:30 slot → CONFLICT + alternatives | `two concurrent prepares for the same staff and slot: exactly one held, the other CONFLICT (23P01)` (`writeActions.integration.test.ts`); `returns CONFLICT with up to 3 nearby alternatives over a confirmed booking or a live hold`; `lets exactly one of two concurrent inserts for the same slot win` (`postgres.integration.test.ts`) | `create with allow_double_book = true into a taken slot returns 409` (`scheduling.overlap.integration.test.ts`) |
| 2 | "Next Tuesday" on Tuesday / Sunday / Monday night | `dateSlot.test.ts` (relative dates vs tenant timezone) | — (agent protocol) |
| 3 | DST change and an 11:30 PM–12:30 AM override | `dstLocale.test.ts`; availability engine DST cases | Recurring/override coverage in `schedulingOverrides` / overlap recurring skip — not a DST scenario |
| 4 | Staff off, shop open; "any" vs named staff | `readActions.test.ts` staff week / off-day / any-staff cases | — |
| 5 | Multi-service, only one staff does both | `books multi-service with the one staff member who does both, honoring bookings and holds` | — |
| 6 | Caller changes service after readback → new prepare, old hold released | `releases the earlier hold when the caller corrects the booking (spec §1.6 #6)` | — |
| 7 | Blocked / mismatched caller ID | `identity.test.ts` | — |
| 8 | Reschedule inside the cancellation window | reschedule policy cases in `writeActions.integration.test.ts` | — |
| 9 | Commit retried with the same token → one booking | `replays a commit retried with the same token: one booking, same result (spec §1.6 #9)` | `idempotent double POST with the same UI key inserts one row`; `same key + same body returns the original booking without a second insert` |
| 10 | Owner books the slot the agent is holding | Agent prepare already CONFLICT-blocks a live hold (see #1). The UI message is owner-side. | `create into a live phone-call hold returns 409 CONFLICT with expiry (spec §1.6 #10)`; `confirm into a live phone-call hold returns 409 and leaves the pending booking pending`; unit: `create into a live phone hold returns 409 with expiry in the tenant timezone`; `confirm into a live phone hold returns 409 and rolls back` |
| 11 | No services configured | `listServices.test.ts` empty catalog; book.prepare VALIDATION_FAILED / NOT_FOUND for missing services | — |
| 12 | Two family members, same phone | `findBookings` / identity contract tests | — |
| 13 | Unpriced service | `says the shop will confirm the price when any service is unpriced` (`readback.test.ts`); prepare `'any'` price fallback | — |
| 14 | Earliest-anything after same-day cutoff | `applies booking rules from the database (same-day off)` (`readActions.test.ts`) | Lead-time / same-day 400s on create (handler + existing overlap tests) |
| 15 | Booking for someone else (name vs caller phone) | book.prepare customer name/phone in `writeActions.integration.test.ts` | — |

Owner-side extras (not numbered in §1.6): `two concurrent cancels: one wins and the other gets 409`; `tenant B booking ids 404 on update, transition, and delete and leave the row unchanged`; `same Idempotency-Key with a different body returns 409 and does not insert`.

## Still open

- Admin create/confirm does not expire stale holds before inserting (the agent prepare path does via `expireStaleHolds`). An expired-but-not-yet-swept hold still occupies the slot under the 122 exclusion constraint and returns generic `slot_unavailable` rather than `heldBy: 'phone_call'`.
- Owner routes still implement booking writes in the HTTP handler rather than `runAction()` (ADR-001). Extracting them onto `platform/actions/scheduling` is out of this slice.
- Idempotency is on create only, not on PUT/transition/delete.
- §1.6 items 2–8, 11–13, and 15 remain agent-protocol scenarios; the owner UI does not speak them.
- Hold conflict responses do not yet include `alternatives` (agent CONFLICT does).
