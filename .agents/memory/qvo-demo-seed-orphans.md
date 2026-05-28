---
name: QVO demo seed orphan routings
description: Why the demo seed must purge orphan agent routings, not just orphan phone numbers.
---

# Demo seed must purge orphan AGENT routings, not just orphan phone numbers

When the demo seed (scripts/seed-demo.ts) is re-run with a different agent-name
schema than a previous run, the old agents stay in the `agents` table AND stay
wired in `number_routing` to the SAME demo phone numbers as the new agents. A
demo phone then has two active routings, and the voice gateway can pick either
one. This is how a call to the legal demo line ended up offering restaurant
bookings — the orphan "QVO Demo — Restaurant Reservations" was still routed
to the legal number alongside the new "Legal Intake Assistant Demo".

**Why:** the original cleanup only deleted orphan rows from `phone_numbers`
whose `phone_number` wasn't in the current seed list, plus their routings.
Orphan agents whose phone numbers DID survive (because the new agent reused
the same number) were never touched.

**How to apply:** any seed/upsert script that owns a tenant's routing graph
must, after upserting the current set, delete routings to agents in that
tenant whose names aren't in the current seed list — and ideally mark those
orphan agents inactive — in addition to cleaning up orphan phone numbers.
Same pattern applies to any tenant whose routing is "fully owned" by a seed.

Related smell: if a demo line gives an answer that belongs to a *different*
vertical, check `number_routing` for duplicate active rows on that phone
before debugging the prompt.
