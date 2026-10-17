# Scenario pack vertical1: coverage

30 scenarios for the barbershop and nail-salon templates, run by
`vertical1.test.ts` in scripted (deterministic) mode against the
`barbershop-basic` and `nail-salon-basic` fixtures in `tests/quality/fixtures/`.
Source of truth: [`docs/shop/tools-spec.md`](../../../../docs/shop/tools-spec.md).

**Status:** 23 pass. 7 are `expectedFail` (PR-13 ×1, PR-14 ×1, PR-17 ×3, PR-20 ×1, PR-26 ×1). An expectedFail scenario that starts passing fails CI as an unexpected pass, so move it to passing when its PR lands.

Ids: `v1-<category>-<template>-<slug>`. `bb` = barbershop, `ns` = nail salon, `es` = Spanish caller.

## Scenarios

| # | Scenario id | Template | Tools | Lang | Status |
|---|---|---|---|---|---|
| 1 | `v1-sched-bb-named-staff` | barbershop | scheduling | en | pass |
| 2 | `v1-sched-ns-anyone-first-available` | nail_salon | scheduling | en | pass |
| 3 | `v1-sched-bb-staff-off-alternatives` | barbershop | scheduling | en | pass |
| 4 | `v1-sched-bb-next-tuesday-on-tuesday` | barbershop | scheduling | en | pass |
| 5 | `v1-sched-bb-multi-service-cut-beard` | barbershop | scheduling | en | pass |
| 6 | `v1-sched-bb-change-after-readback` | barbershop | scheduling | en | expectedFail PR-13 |
| 7 | `v1-sched-bb-race-same-slot` | barbershop | scheduling | en | pass |
| 8 | `v1-sched-bb-for-someone-else` | barbershop | scheduling | en | pass |
| 9 | `v1-sched-bb-unpriced-service` | barbershop | scheduling | en | pass |
| 10 | `v1-sched-bb-after-same-day-cutoff` | barbershop | scheduling | en | pass |
| 11 | `v1-sched-bb-dst-sunday-nov1` | barbershop | scheduling | en | pass |
| 12 | `v1-sched-ns-es-gel-plus-removal` | nail_salon | scheduling | es | pass |
| 13 | `v1-sched-bb-es-anyone-saturday` | barbershop | scheduling | es | pass |
| 14 | `v1-sched-bb-reschedule-verified` | barbershop | scheduling | en | expectedFail PR-14 |
| 15 | `v1-sms-bb-opted-out-no-text-claim` | barbershop | sms, scheduling | en | pass |
| 16 | `v1-sms-ns-flag-off-truthful-fallback` | nail_salon | sms, scheduling | en | pass |
| 17 | `v1-sms-bb-destination-ending-in` | barbershop | sms, scheduling | en | expectedFail PR-17 |
| 18 | `v1-sms-ns-es-different-mobile` | nail_salon | sms, scheduling | es | expectedFail PR-17 |
| 19 | `v1-sms-bb-es-opted-out` | barbershop | sms, scheduling | es | pass |
| 20 | `v1-sms-bb-inbound-x-cancels` | barbershop | sms | en | expectedFail PR-17 |
| 21 | `v1-tickets-bb-callback-request` | barbershop | tickets | en | pass |
| 22 | `v1-tickets-ns-refuses-name` | nail_salon | tickets | en | pass |
| 23 | `v1-tickets-bb-repeat-dedupe` | barbershop | tickets | en | expectedFail PR-20 |
| 24 | `v1-tickets-ns-urgent-keyword` | nail_salon | tickets | en | pass |
| 25 | `v1-tickets-ns-es-callback` | nail_salon | tickets | es | pass |
| 26 | `v1-tickets-bb-different-callback-number` | barbershop | tickets | en | pass |
| 27 | `v1-transfer-bb-asks-for-person` | barbershop | calls | en | pass |
| 28 | `v1-info-ns-hours-question` | nail_salon | business | en | pass |
| 29 | `v1-info-bb-price-no-data` | barbershop | scheduling, business | en | pass |
| 30 | `v1-transfer-bb-after-hours-message` | barbershop | calls, tickets | en | expectedFail PR-26 |

### Why each expectedFail fails today

| Scenario | PR | What fails against `FakeToolProvider` |
|---|---|---|
| `v1-sched-bb-change-after-readback` | PR-13 | The new prepare doesn't release the call's earlier hold, so two booking rows remain (expected 1). |
| `v1-sched-bb-reschedule-verified` | PR-14 | `scheduling.find_bookings` and `scheduling.reschedule.*` are not implemented, so the commit fails and the booking doesn't move. |
| `v1-sms-bb-destination-ending-in` | PR-17 | `sms.send_confirmation.*` is not implemented, so the commit fails. |
| `v1-sms-ns-es-different-mobile` | PR-17 | Same as above, with a different `to` number. |
| `v1-sms-bb-inbound-x-cancels` | PR-17 | `sms.handle_inbound` is not implemented, so the "X" reply doesn't cancel the booking. |
| `v1-tickets-bb-repeat-dedupe` | PR-20 | There's no server-side dedupe, so three tickets are opened (expected 1). |
| `v1-transfer-bb-after-hours-message` | PR-26 | There are no transfer hours, so the transfer is held instead of refused and a transfer row remains. |

## Spec edge case → scenario

### §0.2 Agent protocol

| # | Rule | Scenario id(s) |
|---|---|---|
| 0.2.1 | Gather → prepare → read back → explicit yes → commit | Every write scenario (`readbackRequired: true`): 1–19, 21–27, 30 |
| 0.2.2 | Explicit yes only ("uh-huh" is not a yes) | `v1-sched-ns-anyone-first-available` |
| 0.2.2 | A correction means a new prepare, never an edit to the old token | `v1-sched-bb-change-after-readback` (PR-13) |
| 0.2.3 | No success language before commit `ok:true` | All 30 (`mustNotSay`: EN `you're booked`, `I've sent`, `I've texted you`, `I've let them know`, `your order is in`; ES `ya está reservado`, `le envié`, `ya le avisé`) |
| 0.2.4 | On failure, say what is true; offer alternatives, a message or a transfer | `v1-sched-bb-race-same-slot`, `v1-sms-bb-opted-out-no-text-claim`, `v1-sms-ns-flag-off-truthful-fallback`, `v1-transfer-bb-after-hours-message` (PR-26) |
| 0.2.5 | Facts only from read actions; missing data → "I don't have that" | `v1-info-ns-hours-question`, `v1-info-bb-price-no-data`, `v1-sched-bb-unpriced-service` |
| 0.2.6 | Identity before changes | `v1-sched-bb-reschedule-verified` (PR-14) |
| 0.2.7 | AI disclosure | Not covered. The greeting isn't in the tool trace, so it needs a matcher check on the first `say`. |

### §1.6 Scheduling

| # | Edge case | Scenario id(s) |
|---|---|---|
| 1 | Two callers want the same slot; the second gets CONFLICT and alternatives | `v1-sched-bb-race-same-slot` |
| 2 | "Next Tuesday" said on a Tuesday | `v1-sched-bb-next-tuesday-on-tuesday`. The Sunday and Monday-after-midnight variants are not covered. |
| 3 | A booking across the DST change (Sun Nov 1) | `v1-sched-bb-dst-sunday-nov1`. The 11:30 PM–12:30 AM override is not covered. |
| 4 | Staff off but the shop is open; "with Marco" gets his next day | `v1-sched-bb-staff-off-alternatives` ("any staff" that day: `v1-sched-bb-after-same-day-cutoff`) |
| 5 | Multi-service where only one staff member does both | `v1-sched-bb-multi-service-cut-beard`, `v1-sched-ns-es-gel-plus-removal` (add-on) |
| 6 | Service changed after the readback → new prepare, old hold released | `v1-sched-bb-change-after-readback` (PR-13) |
| 7 | Caller ID blocked or different: reschedule refused without name + date + time | Not covered (needs `scheduling.find_bookings`, PR-14) |
| 8 | Reschedule inside the cancellation window | Not covered (PR-14) |
| 9 | Commit retried with the same token → exactly one booking | Not covered. The fake returns CONFIRMATION_INVALID on replay; add it when PR-13 brings token idempotency. |
| 10 | The owner books in the UI while the agent holds the slot | Not covered (UI/HTTP adapter path, not a voice scenario) |
| 11 | No services configured | Not covered (needs an empty-catalog fixture) |
| 12 | Two family members booked from the same phone | Not covered (PR-14 `find_bookings`) |
| 13 | Price question for an unpriced service | `v1-sched-bb-unpriced-service`, `v1-info-bb-price-no-data` |
| 14 | "Earliest anything" today, after the same-day cutoff | `v1-sched-bb-after-same-day-cutoff` |
| 15 | Booking for someone else (son's name, caller's phone) | `v1-sched-bb-for-someone-else` |
| §1.5 | Named staff; "anyone" → first available; `priceText` said exactly | `v1-sched-bb-named-staff`, `v1-sched-ns-anyone-first-available`, `v1-sched-bb-es-anyone-saturday` |

### §2.6 SMS (plus the §2.5 agent rules)

| # | Edge case | Scenario id(s) |
|---|---|---|
| 1 | Caller texted STOP last month and is booking by phone: no confirmation SMS, and the agent says so truthfully | `v1-sms-bb-opted-out-no-text-claim`, `v1-sms-bb-es-opted-out` |
| §2.5 | `MESSAGING_NOT_ENABLED` (flag off) → truthful fallback | `v1-sms-ns-flag-off-truthful-fallback` |
| §2.5 | Destination read back as "the number ending in 0142" | `v1-sms-bb-destination-ending-in` (PR-17) |
| §2.5 | A different mobile number gets its own readback | `v1-sms-ns-es-different-mobile` (PR-17) |
| §2.1 | Reply keywords: X cancels the booking | `v1-sms-bb-inbound-x-cancels` (PR-17) |
| 2 | STOP then START | Not covered (inbound consent; PR-17) |
| 3 | "Stop texting me so much" flagged as a likely opt-out | Not covered (inbox UI) |
| 4 | Reply after the booking was cancelled | Not covered (PR-17) |
| 5 | Landline caller ID → `undelivered` | Not covered (delivery status callback) |
| 6 | Quiet hours → deferred to 8 AM | Not covered (reminder path, not a live call) |
| 7 | Two-segment Spanish message (UCS-2) | Not covered (segment counting is a unit test, not a scenario) |
| 8 | Twilio 5xx during a call: booking stays confirmed, no "sent" claim | Not covered (needs an upstream-failure fixture switch) |
| 9 | Same number, two customers | Not covered (inbox) |
| 10 | Inbound MMS | Not covered (inbox) |
| 11 | Spoofed webhook signature | Not covered (route test, not a scenario) |

### §3.6 Tickets (plus §3.5)

| # | Edge case | Scenario id(s) |
|---|---|---|
| 1 | Caller refuses to give a name | `v1-tickets-ns-refuses-name` |
| 2 | Callback number differs from caller ID | `v1-tickets-bb-different-callback-number` |
| 3 | Caller repeats the request three times (dedupe) | `v1-tickets-bb-repeat-dedupe` (PR-20) |
| 4 | Abusive caller | Not covered (end-call policy action doesn't exist yet) |
| 5 | Calls back about an existing ticket (find by phone → add a note) | Not covered (`tickets.list` / `tickets.add_note` are not in the fake) |
| 6 | Asks for a lawyer's opinion | N/A (law template; not part of vertical1) |
| 7 | After-hours urgent request with no on-call number | Not covered. The closest is `v1-transfer-bb-after-hours-message`. |
| 8 | Spanish caller: original language plus an English summary | `v1-tickets-ns-es-callback` |
| §3.5 | Urgent keyword → `urgency: 'urgent'` | `v1-tickets-ns-urgent-keyword` |
| §3.5 | Callback request with the name, number and best time collected | `v1-tickets-bb-callback-request` |

### §6 Business info and transfer

| Case | Scenario id(s) |
|---|---|
| Asks for a person → warm transfer with readback | `v1-transfer-bb-asks-for-person` |
| Hours question answered from `business.get_info` | `v1-info-ns-hours-question` |
| Price question with no data → "I don't have that" | `v1-info-bb-price-no-data` |
| Transfer outside transfer hours → message ticket | `v1-transfer-bb-after-hours-message` (PR-26) |

## Fixtures

| Seed | What it adds |
|---|---|
| `barbershop-basic` | Marco, Andre, Tony. Men's cut "from $35", beard trim "$20", cut and beard combo "$50", hot towel shave unpriced. Open Tue–Sun, closed Monday. Marco is off Wednesdays. Only Marco does cut + beard. |
| `barbershop-basic:slot-held-by-other-caller` | Marco's 3:30 on Tue Oct 20 is held by another line. |
| `barbershop-basic:after-same-day-cutoff` | No slots on Tue Oct 20 (`outside_lead_time`); the next open date is Oct 21. |
| `barbershop-basic:existing-booking` | Luis is confirmed with Marco on Thu Oct 22 at 10:00. |
| `barbershop-basic:sms-opted-out` | +15555550142 and +15555550188 are opted out. |
| `nail-salon-basic` | Linh, Kim, Rosa, Mai. Manicure, pedicure, gel manicure, and a gel removal add-on. Open Mon–Sat, closed Sunday. |
| `nail-salon-basic:sms-disabled` | SMS turned off for the tenant (`messagingEnabled: false`). |

The `sms` and `transferHours` fixture fields are not read by `FakeToolProvider` today. They describe the state the PR-17/PR-26 actions must honor when they replace the fake.
