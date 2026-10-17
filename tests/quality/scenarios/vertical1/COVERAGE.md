# Scenario pack vertical1: coverage

30 scenarios for the barbershop and nail-salon templates, run by
`vertical1.test.ts` in scripted (deterministic) mode against the
`barbershop-basic` and `nail-salon-basic` fixtures in `tests/quality/fixtures/`.
Source of truth: [`docs/shop/tools-spec.md`](../../../../docs/shop/tools-spec.md).

**Status:** 17 pass. 13 are `expectedFail`: PR-13 ×1, PR-14 ×1, PR-17 ×6, PR-20 ×1, PR-26 ×1, and `matcher-es-readback` ×3 (a harness follow-up, not a product PR; see [Follow-ups](#follow-ups)). An expectedFail scenario that starts passing fails CI as an unexpected pass, so move it to passing when its PR lands. `vertical1.test.ts` asserts these totals, and pins each expectedFail to the exact checks that must fail, so a typo or broken script can't count as the expected failure.

Ids: `v1-<category>-<template>-<slug>`. `bb` = barbershop, `ns` = nail salon, `es` = Spanish caller.

## Scenarios

"all 5" in the Tools column means `scheduling, sms, tickets, business, calls`.

| # | Scenario id | Template | Tools | Lang | Status |
|---|---|---|---|---|---|
| 1 | `v1-sched-bb-named-staff` | barbershop | all 5 | en | pass |
| 2 | `v1-sched-ns-anyone-first-available` | nail_salon | all 5 | en | pass |
| 3 | `v1-sched-bb-staff-off-alternatives` | barbershop | all 5 | en | pass |
| 4 | `v1-sched-bb-next-tuesday-on-tuesday` | barbershop | all 5 | en | pass |
| 5 | `v1-sched-bb-multi-service-cut-beard` | barbershop | all 5 | en | pass |
| 6 | `v1-sched-bb-change-after-readback` | barbershop | all 5 | en | expectedFail PR-13 |
| 7 | `v1-sched-bb-race-same-slot` | barbershop | all 5 | en | pass |
| 8 | `v1-sched-bb-for-someone-else` | barbershop | all 5 | en | pass |
| 9 | `v1-sched-bb-unpriced-service` | barbershop | all 5 | en | pass |
| 10 | `v1-sched-bb-after-same-day-cutoff` | barbershop | all 5 | en | pass |
| 11 | `v1-sched-bb-dst-sunday-nov1` | barbershop | all 5 | en | pass |
| 12 | `v1-sched-ns-es-gel-plus-removal` | nail_salon | all 5 | es | expectedFail matcher-es-readback |
| 13 | `v1-sched-bb-es-anyone-saturday` | barbershop | all 5 | es | expectedFail matcher-es-readback |
| 14 | `v1-sched-bb-reschedule-verified` | barbershop | all 5 | en | expectedFail PR-14 |
| 15 | `v1-sms-bb-opted-out-no-text-claim` | barbershop | all 5 | en | expectedFail PR-17 |
| 16 | `v1-sms-ns-flag-off-truthful-fallback` | nail_salon | all 5 | en | expectedFail PR-17 |
| 17 | `v1-sms-bb-destination-ending-in` | barbershop | all 5 | en | expectedFail PR-17 |
| 18 | `v1-sms-ns-es-different-mobile` | nail_salon | all 5 | es | expectedFail PR-17 |
| 19 | `v1-sms-bb-es-opted-out` | barbershop | all 5 | es | expectedFail PR-17 |
| 20 | `v1-sms-bb-inbound-x-cancels` | barbershop | sms, scheduling | en | expectedFail PR-17 |
| 21 | `v1-tickets-bb-callback-request` | barbershop | all 5 | en | pass |
| 22 | `v1-tickets-ns-refuses-name` | nail_salon | all 5 | en | pass |
| 23 | `v1-tickets-bb-repeat-dedupe` | barbershop | all 5 | en | expectedFail PR-20 |
| 24 | `v1-tickets-ns-urgent-keyword` | nail_salon | all 5 | en | pass |
| 25 | `v1-tickets-ns-es-callback` | nail_salon | all 5 | es | expectedFail matcher-es-readback |
| 26 | `v1-tickets-bb-different-callback-number` | barbershop | all 5 | en | pass |
| 27 | `v1-transfer-bb-asks-for-person` | barbershop | all 5 | en | pass |
| 28 | `v1-info-ns-hours-question` | nail_salon | all 5 | en | pass |
| 29 | `v1-info-bb-price-no-data` | barbershop | all 5 | en | pass |
| 30 | `v1-transfer-bb-after-hours-message` | barbershop | all 5 | en | expectedFail PR-26 |

### Why each expectedFail fails today

"Pinned checks" are the failures `vertical1.test.ts` requires, in matcher order. Any other failure, or a missing one, fails the test.

| Scenario | PR | What fails against `FakeToolProvider` | Pinned checks |
|---|---|---|---|
| `v1-sched-bb-change-after-readback` | PR-13 | The new prepare doesn't release the call's earlier hold, so two booking rows remain (expected 1). | `endState` bookings count |
| `v1-sched-bb-reschedule-verified` | PR-14 | `scheduling.find_bookings` and `scheduling.reschedule.*` are not implemented, so there's no readback, the commit fails and the booking doesn't move. | `actions` reschedule.commit did not succeed; `endState` no booking matched; `readbackRequired` no readback |
| `v1-sms-bb-opted-out-no-text-claim` | PR-17 | `sms.send_confirmation.prepare` returns `NOT_FOUND` ("I couldn't find that.") instead of `RECIPIENT_OPTED_OUT`. The agent relays `{{callerSafeMessage}}`, so the spec §2.5 refusal "I can't text this number…" is never said. | `mustSay` "I can't text this number" |
| `v1-sms-ns-flag-off-truthful-fallback` | PR-17 | Same, with `MESSAGING_NOT_ENABLED` expected. | `mustSay` "I can't text this number" |
| `v1-sms-bb-es-opted-out` | PR-17 | Same, with the refusal expected in Spanish (`ctx.locale`). The Spanish readback also fails (matcher follow-up). | `mustSay` "No puedo enviarle mensajes"; `readbackRequired` book readback not spoken |
| `v1-sms-bb-destination-ending-in` | PR-17 | `sms.send_confirmation.*` is not implemented, so the commit fails. | `actions` sms commit did not succeed |
| `v1-sms-ns-es-different-mobile` | PR-17 | Same as above, with a different `to` number. The Spanish readback also fails (matcher follow-up). | `actions` sms commit did not succeed; `readbackRequired` book readback not spoken |
| `v1-sms-bb-inbound-x-cancels` | PR-17 | `sms.handle_inbound` is not implemented, so the "X" reply doesn't cancel the booking. | `endState` no booking matched |
| `v1-tickets-bb-repeat-dedupe` | PR-20 | There's no server-side dedupe, so three tickets are opened (expected 1). | `endState` tickets count |
| `v1-transfer-bb-after-hours-message` | PR-26 | There are no transfer hours, so the transfer is held instead of refused, a transfer row remains, and its readback is never spoken. | `endState` transfers count; `readbackRequired` transfer readback not spoken |
| `v1-sched-ns-es-gel-plus-removal` | matcher-es-readback | Spanish readback blocked on matcher follow-up: matcher accepts Spanish readback. | `readbackRequired` book readback not spoken |
| `v1-sched-bb-es-anyone-saturday` | matcher-es-readback | Same. | `readbackRequired` book readback not spoken |
| `v1-tickets-ns-es-callback` | matcher-es-readback | Same, for the ticket readback. | `readbackRequired` ticket readback not spoken |

When PR-17 lands, `v1-sms-ns-es-different-mobile` still fails on the readback until follow-up 1 ships; re-pin it to `matcher-es-readback` then. `v1-sms-bb-es-opted-out` stays blocked on both the readback check and the Spanish refusal check (`mustSay` "No puedo enviarle mensajes"): the runner never passes the caller's locale to `ctx.locale`, the scenario format has no locale field, and the spec defines only the English §2.5 refusal. It needs all of follow-up 1, not just PR-17.

## Spec edge case → scenario

### §0.2 Agent protocol

| # | Rule | Scenario id(s) |
|---|---|---|
| 0.2.1 | Gather → prepare → read back → explicit yes → commit | Every write scenario (`readbackRequired: true`): 1–19, 21–27, 30. The Spanish ones (12, 13, 18, 19, 25) fail this check today (matcher follow-up). |
| 0.2.2 | Explicit yes only ("uh-huh" is not a yes) | Not covered. `v1-sched-ns-anyone-first-available` scripts the "Uh-huh." turn, but nothing asserts it: `readbackRequired` only needs some caller turn between the readback and the commit, so committing on "Uh-huh." would also pass. Needs the matcher follow-up below. |
| 0.2.2 | A correction means a new prepare, never an edit to the old token | `v1-sched-bb-change-after-readback` (PR-13) |
| 0.2.3 | No success language before commit `ok:true` | All 30 (`mustNotSay`: EN `you're booked`, `I've sent`, `I've texted you`, `I've let them know`, `your order is in`; ES `ya está reservado`, `quedó confirmada`, `quedó confirmado`, `su cita está confirmada`, `ya quedó`, `quedó registrado`, `le envié`, `ya le avisé`). Spanish phrases never unlock, even after the commit (matcher follow-up), so Spanish post-commit lines avoid them ("Listo, tiene su cita con Rosa el jueves a la 1:00."). |
| 0.2.4 | On failure, say what is true; offer alternatives, a message or a transfer | `v1-sched-bb-race-same-slot`; `v1-sms-bb-opted-out-no-text-claim`, `v1-sms-ns-flag-off-truthful-fallback` (PR-17); `v1-transfer-bb-after-hours-message` (PR-26) |
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
| 5 | Multi-service where only one staff member does both | `v1-sched-bb-multi-service-cut-beard`, `v1-sched-ns-es-gel-plus-removal` (add-on; matcher-es-readback) |
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
| §1.5 | Named staff; "anyone" → first available; `priceText` said exactly | `v1-sched-bb-named-staff`, `v1-sched-ns-anyone-first-available`, `v1-sched-bb-es-anyone-saturday` (matcher-es-readback) |

### §2.6 SMS (plus the §2.5 agent rules)

| # | Edge case | Scenario id(s) |
|---|---|---|
| 1 | Caller texted STOP last month and is booking by phone: no confirmation SMS, and the agent says so truthfully | `v1-sms-bb-opted-out-no-text-claim` (PR-17), `v1-sms-bb-es-opted-out` (PR-17) |
| §2.5 | `MESSAGING_NOT_ENABLED` (flag off) → truthful fallback | `v1-sms-ns-flag-off-truthful-fallback` (PR-17) |
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
| 8 | Spanish caller: original language plus an English summary | `v1-tickets-ns-es-callback` (matcher-es-readback) |
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
| `barbershop-basic:cut-and-beard` | Slots sized for men's cut + beard trim: 45 minutes (base slots are one 30-minute men's cut). |
| `barbershop-basic:cut-beard-combo` | Slots sized for the cut and beard combo service: 45 minutes. Used by `v1-sched-bb-change-after-readback`, so its corrected 4:30 booking ends at 5:15. |
| `barbershop-basic:slot-held-by-other-caller` | Marco's 3:30 on Tue Oct 20 is held by another line. |
| `barbershop-basic:after-same-day-cutoff` | No slots on Tue Oct 20 (`outside_lead_time`); the next open date is Oct 21. |
| `barbershop-basic:existing-booking` | Luis is confirmed with Marco on Thu Oct 22 at 10:00. |
| `barbershop-basic:sms-opted-out` | +15555550142 and +15555550188 are opted out. |
| `nail-salon-basic` | Linh, Kim, Rosa, Mai. Manicure, pedicure, gel manicure, and a gel removal add-on. Open Mon–Sat, closed Sunday. |
| `nail-salon-basic:gel-plus-removal` | Slots sized for gel manicure + gel removal: 60 minutes (base slots are one 45-minute pedicure). |
| `nail-salon-basic:sms-disabled` | SMS turned off for the tenant (`messagingEnabled: false`). |

Slot ends come from the services in `slotServiceIds` (sum of `durationMin` + optional `bufferMin`, default 0), and a start is only offered when that whole interval ends by closing. `FakeToolProvider` returns `slot.end` as seeded and doesn't know the requested services, so each seed's slots are sized for one booking; multi-service scenarios use the `cut-and-beard` / `gel-plus-removal` variants, and `v1-sched-bb-change-after-readback` uses `cut-beard-combo` (follow-up 5).

The `sms` and `transferHours` fixture fields are carried into the tenant state but not read by `FakeToolProvider` today. They describe the state the PR-17/PR-26 actions must honor when they replace the fake.

## Follow-ups

These need changes in `scripts/quality/` (matcher, runner or fake), outside this pack.

1. **Matcher accepts Spanish readback** (`matcher-es-readback`). `readbackRequired` only passes when the fake's English readback is spoken verbatim, so an all-Spanish agent fails. Either have the provider return readbacks in `ctx.locale` (the runner also needs to pass a locale), or match readback facts (staff, date, time, name, number) instead of the exact string. The runner and scenario format must also pass the caller's locale through to `ctx.locale` for error messages (`callerSafeMessage`), not just readbacks, and `docs/shop/tools-spec.md` §2.5 needs a Spanish refusal message (e.g. for `RECIPIENT_OPTED_OUT` / `MESSAGING_NOT_ENABLED`). Then move `v1-sched-ns-es-gel-plus-removal`, `v1-sched-bb-es-anyone-saturday` and `v1-tickets-ns-es-callback` to passing; `v1-sms-bb-es-opted-out` additionally needs PR-17.
2. **Map Spanish success phrases to their commit.** `unlockCommitForBannedPhrase` only maps English phrases, so `quedó confirmada`, `su cita está confirmada`, `quedó registrado` and the rest never unlock, even after the commit. Map the booking phrases to `scheduling.book.commit` and `quedó registrado` to `tickets.open.commit`.
3. **Turn-order checks for commits.** Add "commit must come after caller turn N" and "must not happen" (e.g. no `sms.send_confirmation.commit`) assertions. That covers 0.2.2 ("uh-huh" is not a yes) and lets the opt-out scenarios prove no SMS was sent.
4. **Error-code assertions.** Let an expected action require a failure with a given code (e.g. `RECIPIENT_OPTED_OUT`, `MESSAGING_NOT_ENABLED`). Today the opt-out and flag-off scenarios can only see the refusal through the relayed `callerSafeMessage`.
5. **Fake derives slot ends from the requested services.** `FakeToolProvider.checkAvailability` should compute each slot's `end` from the request's `serviceIds` (sum of durations plus buffers) and only offer starts where that interval fits the hours and doesn't overlap a held/confirmed booking. Then drop the `cut-and-beard` / `gel-plus-removal` / `cut-beard-combo` variants and `slotServiceIds`, and point the multi-service scenarios back at the base seeds. Until then a scenario that books two different-length services can size only one of them: in `v1-sched-bb-change-after-readback` the final combo booking is correct (4:30–5:15), but the superseded 3:30 men's-cut hold is mis-sized at 45 minutes (3:30–4:15, should be 4:00).
