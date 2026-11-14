# Tickets robustness

What `platform/actions/tickets` now guarantees, which tools-spec §3.6 cases have tests, and what is still open.

## Guaranteed

- **Open** is two-phase (`tickets.open.prepare` / `.commit`). A repeat of the same kind and phone in one call becomes a note on the first ticket (advisory lock on `(tenant, call, kind, phone)`). A new ticket writes exactly one `ticket.opened` outbox row in the same transaction.
- **Notes and updates** lock the ticket `FOR UPDATE`. Invalid status transitions fail with `VALIDATION_FAILED`. Missing or foreign ids fail with `NOT_FOUND` and write nothing.
- **List / get** are tenant-scoped reads. List accepts `status` (`open` / `overdue` / `all`), `kind`, and an optional `phone` filter. The phone is digits-normalized the same way as in-call dedupe (`normalizePhone`: non-digits stripped, a leading US `1` dropped on 11-digit numbers) and matched against `tickets.contact_phone`. Default list status is `open`, so staff/MCP can find a caller's open tickets. The agent still cannot list or get.
- **`tickets.merge`** is a UI/MCP write (`tenant_owner` / `operations_manager`, `qvo:admin`). It is not on the agent. Input `{ sourceId, targetId }`. Same tenant only; `sourceId === targetId` is `VALIDATION_FAILED`. Both rows are locked `FOR UPDATE` in sorted id order. Source is closed with `parent_ticket_id = target`; both tickets get a `merged` activity row; source notes are copied onto the target as one note. Re-running the same pair is a no-op success. Merging into a closed target, or using a ticket that already has `parent_ticket_id` set (merged away), is `VALIDATION_FAILED`. Another tenant's ids are `NOT_FOUND` and write nothing.

Callback due times still come only from tenant settings or an active SLA policy. Nothing invents a promised callback window.

## tools-spec §3.6 coverage

| # | Case | Test |
|---|---|---|
| 1 | Caller refuses a name | `tools-spec §3.6 edge cases > #1 caller refuses a name: the ticket is stored with an empty name` (`tickets.test.ts`) |
| 2 | Callback number differs from caller ID | `tools-spec §3.6 edge cases > #2 callback number differs from caller ID: the stated number is stored and read back` (`tickets.test.ts`) |
| 3 | Caller repeats the request three times | `tools-spec §3.6 edge cases > #3 caller repeats the request three times: one ticket plus notes` (`tickets.test.ts`); also `tickets.open.commit > dedupe within one call` |
| 4 | Abusive caller: offer a message then end the call | **Open** — agent/runtime policy, not this action layer |
| 5 | Call-back about an existing ticket | `tools-spec §3.6 edge cases > #5 call-back about an existing ticket: list by phone then add a note` (`tickets.test.ts`) |
| 6 | Caller asks for a lawyer's opinion | **Open** — agent phrasing / template, not this action layer |
| 7 | After-hours urgent with no on-call | `tools-spec §3.6 edge cases > #7 urgent after hours with no on-call: one urgent ticket, one ticket.opened, no promised callback time` (`tickets.test.ts`) |
| 8 | Spanish caller: original language plus English summary | **Open** — storage of a second-language summary is not in the action |

## Concurrency and isolation (real Postgres)

| Case | Test (`postgres.integration.test.ts`) |
|---|---|
| List by digits-normalized phone | `lists a caller's tickets by digits-normalized phone under RLS`; also the open/dedupe/read flow |
| Two concurrent updates on one ticket → both apply, both activities | `two concurrent updates on one ticket both serialize and both activities are recorded` |
| Two concurrent merges of the same pair → one merge | `two concurrent merges of the same pair produce one merge` |
| Foreign ticket ids on get / add_note / update / merge → `NOT_FOUND`, nothing written | `another tenant's ticket ids on get, add_note, update and merge return NOT_FOUND and write nothing` |

## Still open / follow-ups

- §3.6 #4, #6, #8 (agent policy and bilingual summary).
- Merge does not walk `parent_ticket_id` to the current survivor; a ticket that was merged away cannot be used as source or target except to re-run the same pair.
- List `phone` is exact after normalization, not a prefix/fuzzy search.
- The admin HTTP route (`server/admin-api/routes/tickets.ts`) is still a separate implementation; adapters should call `runAction('tickets.merge')` rather than duplicate this.
