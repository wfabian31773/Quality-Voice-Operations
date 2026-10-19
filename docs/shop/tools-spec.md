# QVO tools spec: the in-app tools the agent acts through
Version 1 · Fri Oct 16, 2026 · Planning only (nothing launched, merged or deployed)
Repo inspected: `wfabian31773/Quality-Voice-Operations`, `main` @ `6a98241` (Oct 14).

**Why this document exists.** QVO won't win on voice. It wins because its tools are better than the ones a small business already pays for, and because the voice agent is "one with the tools": it can only act through them, and it gets things right almost every time. Customers don't build agents. QVO configures each business's agent from a **use-case template** (section 7), which turns on one or more of the five tools below.

**How the benchmarks were built.** Benchmark features come from the products' public feature pages and common knowledge of them. They are a target list, not a set of verified competitor claims. Re-check any specific claim before it appears in marketing.

---

## 0. Architecture: one action layer, three callers

```
             ┌──────────── App UI (owner/staff)  ── HTTP adapter  /api/actions/:name
platform/    │
actions/  ◄──┼──────────── Voice/SMS agent        ── agent-tool adapter (generated tool schemas)
<tool>/*     │
             └──────────── QVO MCP server          ── MCP adapter (Wayne's bots: provision, configure, test, review)
```

**Rules (non-negotiable)**
1. **Business logic lives only in `platform/actions/<tool>/`.** Routes, voice tools and MCP tools are thin adapters. Today, the logic sits in route handlers (`server/admin-api/routes/scheduling.ts` is 2,518 lines, `tickets.ts` 2,403, `dispatch.ts` 5,747, `smsInbox.ts` 1,057), and the voice tools bypass it. The work extracts that logic; it does not rewrite it.
2. **The agent acts only through actions.** A shop agent's tool list is generated from the action registry and filtered by the tenant's template. Legacy library handlers (`platform/tools/library/handlers/createBooking.ts`, etc.) and `registerTemplateTools` are not exposed to template-configured agents. No action means the agent can't do it, so it says so and offers a message or a transfer.
3. **Every write is two-phase for the agent:** `prepare` (validate, hold, return a readback and a `confirmationToken`) → the caller says yes → `commit(token)`. The server enforces this. The UI may commit directly (its own confirm dialog), and MCP writes need a write scope and default to `dryRun: true`.
4. **Every write is idempotent.** The agent's commits use the confirmation token as the idempotency key. UI and MCP writes send an `Idempotency-Key` header or argument.
5. **Correctness lives in the database, not the prompt:** exclusion constraints, unique keys, RLS (`withTenantContext`, `platform/db/index.ts:71`), and transactions.
6. **Browser automation only where no API exists** (for example, a POS with no API). It runs as an isolated connector behind an action, never as a code path the agent can call directly.

### 0.1 Shared action contract (`platform/actions/core`)
```ts
type Actor = { type: 'user'|'agent'|'mcp'|'system'; id: string; role?: string; scopes?: string[] };
interface ActionContext {
  tenantId: string; actor: Actor; now: Date;            // injectable clock (tests, DST)
  idempotencyKey?: string;                              // required for writes (adapter enforces)
  callId?: string; conversationId?: string;             // agent provenance
  locale?: string; tenantTimezone: string;
}
type ActionResult<T> =
  | { ok: true; data: T; readback?: string; effects?: Effect[] }   // effects = events emitted (e.g. booking.confirmed)
  | { ok: false; error: { code: ActionErrorCode; message: string; callerSafeMessage: string;
                         retryable: boolean; field?: string; alternatives?: unknown[] } };
interface ActionDefinition<I, O> {
  name: string;                     // 'scheduling.book.prepare'
  tool: 'scheduling'|'sms'|'tickets'|'dispatch'|'orders'|'business'|'calls';
  kind: 'read'|'prepare'|'commit'|'write';   // 'write' = UI/MCP-only single-step
  input: z.ZodType<I>; output: z.ZodType<O>;
  permissions: { roles?: string[]; agent?: boolean; mcpScope?: string };
  agentDescription?: string;        // spoken-tool description; generated into the tool schema
  run(ctx: ActionContext, input: I, tx: TenantTx): Promise<ActionResult<O>>;
}
```
**Common error codes:** `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `TOOL_NOT_ENABLED` (the template didn't turn the tool on), `CONFLICT` (slot taken, comes with `alternatives`), `OUTSIDE_POLICY` (lead time, cancel window, hours), `CONFIRMATION_REQUIRED`, `CONFIRMATION_INVALID` (expired, wrong call, or payload changed), `IDEMPOTENCY_KEY_REUSED` (same key, different payload), `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE` (Twilio/email), `INTERNAL`.
**`callerSafeMessage`** is what the agent may say. It is never a stack trace and never a guess.

**Storage** (migration 121): `action_idempotency(tenant_id, action, key, request_hash, status, response jsonb, expires_at, UNIQUE(tenant_id, action, key))`, `action_proposals(id = confirmationToken, tenant_id, action, call_id, payload_hash, payload jsonb, readback, expires_at, consumed_at)` and `action_audit_log(tenant_id, action, actor, input_redacted, result_code, latency_ms, call_id, created_at)`. All three have RLS enabled and forced.

**Idempotency semantics:** the same key with the same request hash returns the stored response, with no second side effect. The same key with a different hash returns `IDEMPOTENCY_KEY_REUSED`. Keys live 24 h.

### 0.2 Agent protocol (applies to every tool)
1. **Gather → prepare → read back → explicit yes → commit → confirm.** The agent reads back the `readback` string returned by `prepare`, which the server builds in plain spoken form (for example, "a men's cut with Marco, Tuesday October 20th at 3:30 PM, for Luis, at 555-0142"). It doesn't paraphrase facts.
2. **Explicit yes only.** "Yes", "correct" and "that's right" count. "Uh-huh" during the readback, silence or "I guess" do not, so the agent asks once more. A correction leads to a new `prepare`, never an edit to the old token.
3. **No success language before `ok:true` from commit.** Phrases like "you're booked", "I've sent", "I've let them know" or "your order is in" are banned until then, and the scenario suite checks for them.
4. **On failure, say what is true.** Use `callerSafeMessage`, then offer `alternatives`, a message ticket or a transfer. Never retry a commit with a new token without a new readback.
5. **Facts only from read actions** (`business.get_info`, `scheduling.check_availability`, `orders.get_menu`, …). If the data is missing, the agent says "I don't have that, I can take a message."
6. **Identity before changes.** Finding, rescheduling or cancelling a booking needs the caller-ID match **and** the name on the booking. If caller ID doesn't match, it needs name + date + time (the time is never offered first). Otherwise the agent takes a message.
7. **AI disclosure** in the greeting when the template requires it, and on request always.

---

## 1. Scheduling (appointments)
**Benchmarks:** Square Appointments, Booksy, Fresha.

### 1.1 Best-in-class feature set (target)
| Area | Feature | v1 (this week) | Later |
|---|---|---|---|
| Catalog | Services with duration, price (fixed / "from" / range), buffer after, **processing/gap time** (for example, color sets while staff take another client) | ✅ duration, price, buffer | processing time (wk 2) |
| Catalog | Who performs what (staff ↔ service), **per-staff duration/price overrides** | ✅ mapping; overrides wk 2 | |
| Catalog | Add-ons / multi-service bookings (cut + beard; gel mani + pedi), done back-to-back with the same or different staff | ✅ same staff back-to-back | multi-staff combos |
| Hours | Business hours, staff weekly schedules, time off, holiday closures, one-off extra hours | ✅ (reuse `scheduling_provider_schedules`, `scheduling_overrides`; add business hours) | |
| Rules | Lead time (min/max), same-day cutoff, cancel/reschedule window, max per day, "any staff" assignment policy (least busy / round-robin) | ✅ (reuse `scheduling_booking_rules`) | |
| Booking | Real-time availability, "first available" and "with X", next-N suggestions, holds while the caller decides | ✅ | |
| Booking | Find / reschedule / cancel by phone, with identity checks | ✅ | |
| Booking | **Zero double bookings** (DB constraint, concurrency-tested) | ✅ | |
| Booking | Walk-in queue / check-in (barbers) | — | wk 2–3 |
| Booking | Waitlist with auto-offer when a slot frees up | — (table exists: `scheduling_waitlist`) | wk 2 |
| Booking | Recurring standing appointments ("every 3 weeks with Marco") | — (table exists) | wk 3 |
| Booking | Group bookings (two friends, two chairs) | — | wk 3 |
| Payments | Deposits / card on file / no-show fee | — (needs Stripe live) | after Stripe live |
| Comms | Confirmation + reminders (24 h, 2 h) by SMS/email, with confirm/cancel by reply | ✅ via SMS tool (§2), email fallback | |
| Owner | Today view, week calendar, drag to move, block time, client card with history and notes | ✅ Today + week + client card basic | drag polish wk 2 |
| Channels | Online booking page, Google/Apple calendar sync, Reserve with Google | — | wk 3+ |
| Reports | No-show rate, utilization, rebook rate, revenue booked by the agent | basic counts | wk 2 |

### 1.2 What QVO already has (code)
- **Tables (migration 052 + 048):** `bookings` (+ provider_id, appointment_type_id, resource_id, recurring_series_id, cancellation_reason, checked_in_at, completed_at, intake_data, timezone, location, booking_source), `scheduling_providers`, `scheduling_provider_schedules`, `scheduling_overrides`, `scheduling_appointment_types` (duration_minutes, buffer_minutes, capacity, required_resources, allow_self_scheduling), `scheduling_resources`, `scheduling_booking_rules` (min/max lead, same-day, double-book, max daily, cancellation_window_hours), `scheduling_recurring_series`, `scheduling_waitlist`, `scheduling_reminder_configs`, `scheduling_reminder_log`, `scheduling_audit_log`.
- **Routes:** `server/admin-api/routes/scheduling.ts` covers bookings CRUD + transition, providers, schedules, overrides, appointment types, resources, rules, waitlist, reminders, recurring, availability, reports, utilization, audit log and self-schedule config.
- **UI:** `client-app/src/pages/Scheduling.tsx`.
- **Voice tool:** `create_booking` (`platform/tools/library/handlers/createBooking.ts`).

### 1.3 Gaps (ranked by risk)
1. 🔴 **The voice tool bypasses the scheduler.** `createBooking.ts` inserts `status 'pending'` directly, with no availability check, conflict check, provider or appointment type. The agent can book a closed day or an occupied chair.
2. 🔴 **Double-booking race.** `checkConflicts()` (`scheduling.ts:975`) does a SELECT and then an INSERT, with no lock and no exclusion constraint in any migration.
3. 🟠 Logic lives in route handlers, so the agent and MCP can't reuse it.
4. 🟠 No price on appointment types, and no staff ↔ service mapping (anyone can be booked for anything).
5. 🟠 No business-level hours (only per-provider schedules), no `held` status, no hold expiry.
6. 🟠 No idempotency on booking creation.
7. 🟡 No find/reschedule/cancel tools for the agent, and no caller verification.
8. 🟡 Timezone: `bookings.timezone` defaults to `America/New_York`. Availability must use the tenant's timezone and be DST-safe (US change **Sun Nov 1, 2026**).

### 1.4 Actions
| Action | Kind | Input (zod) | Output | Errors |
|---|---|---|---|---|
| `scheduling.list_services` | read | `{ staffId? }` | `[{id, name, durationMin, priceText, staffIds}]` | — |
| `scheduling.list_staff` | read | `{ serviceId? }` | `[{id, displayName, serviceIds}]` | — |
| `scheduling.check_availability` | read | `{ serviceIds: string[1..3], staffId?: string \| 'any', date?: ISODate, window?: {from,to}, partOfDay?: 'morning'\|'afternoon'\|'evening', limit≤5 }` | `{ slots: [{start, end, staffId, staffName, spoken}], nextOpenDate?, reasonIfNone?: 'closed'\|'fully_booked'\|'outside_lead_time'\|'staff_off' }` | VALIDATION_FAILED, NOT_FOUND |
| `scheduling.book.prepare` | prepare | `{ serviceIds, staffId\|'any', start, customer: {name, phone(E.164), email?}, notes? }` | `{ confirmationToken, holdId, expiresAt (+5 min), readback, priceText }`, plus a **held** booking row | CONFLICT (+alternatives), OUTSIDE_POLICY, VALIDATION_FAILED |
| `scheduling.book.commit` | commit | `{ confirmationToken }` | `{ bookingId, status:'confirmed', readback, confirmationChannel: 'sms'\|'email'\|'none' }` | CONFIRMATION_INVALID, CONFLICT (hold lost) |
| `scheduling.find_bookings` | read | `{ phone(E.164), name?, date?: ISODate (local), time?: 'HH:MM' (local) }` | `{ verified, bookings: [{bookingId, customerName, serviceNames, staffId, staffName, start, end, spoken}], needs?: 'name'\|'name_date_time', matchCount? }`. Upcoming `confirmed` bookings only. For the agent, only **verified** matches are listed (§0.2.6; caller ID from `call_sessions`, never input); otherwise `verified:false, bookings:[]` plus `needs` (`matchCount` only for a caller-ID match with no name). Staff/UI/MCP get a plain lookup | VALIDATION_FAILED. No NOT_FOUND: "no bookings" looks exactly like a refusal |
| `scheduling.reschedule.prepare` / `.commit` | prepare/commit | `{ bookingId, newStart, staffId? }` | token + readback / new times | OUTSIDE_POLICY (inside the cancel window), CONFLICT |
| `scheduling.cancel.prepare` / `.commit` | prepare/commit | `{ bookingId, reason? }` | token + readback / `{status:'cancelled'}` | OUTSIDE_POLICY (policy text in the message) |
| `scheduling.block_time` | write (UI/MCP) | `{ staffId, start, end, reason }` | override id | CONFLICT (existing bookings listed) |
| `scheduling.mark_status` | write (UI) | `{ bookingId, status: 'checked_in'\|'completed'\|'no_show' }` | — | invalid transition |

**Service refs** (`serviceId` on list_staff, `serviceIds` on check_availability and book.prepare): an id is preferred, but an exact service name or alias also resolves (case, accents and regular plurals either way ignored, so "massage" = "Massages" and "therapy" = "Therapies", plus one leading article as written: a/an/the/un/una/unos/unas/el/la/los/las, so "the fade" = "Fade" but "combo" ≠ "Combo A" and "uña de gel" keeps its "uña"; an unaccented leading "una(s)" is tried both as article and as "uña(s)", two services from the two readings → ambiguous; tenant's active catalog only; `serviceRefs.ts`). Two services matching → VALIDATION_FAILED with the candidates in `alternatives` as `{serviceId, name}`; none → NOT_FOUND (book.prepare: VALIDATION_FAILED) with the closest few. Nothing looser than an exact name/alias ever resolves.

**Validation:**
- `start` aligns to the slot grid (default 15 min).
- Service and staff are active, and the staff member performs every service.
- Lead-time and max-days rules apply.
- Phones normalize to E.164.
- Names are 1–80 chars.
- The total duration is the sum of service durations plus the buffer.

**Integrity:**
- Migration 122 adds `blocked_until` (end + buffer), `hold_expires_at`, `idempotency_key` and the `held` status.
- It adds `EXCLUDE USING gist (tenant_id WITH =, provider_id WITH =, tstzrange(start_time, blocked_until) WITH &&) WHERE (status IN ('held','confirmed') AND provider_id IS NOT NULL)` (btree_gist).
- Before adding the constraint, the migration reports any existing overlaps and aborts. It never deletes rows.
- `prepare` cancels expired holds for that staff member in the same transaction. A sweeper also expires holds every minute.
- A `23P01` violation maps to `CONFLICT` with fresh alternatives.

**Idempotency:** commit is keyed by the token. A UI write is keyed by its `Idempotency-Key`.

**Effects:** `booking.confirmed`, `booking.rescheduled` and `booking.cancelled` go on an outbox. SMS/email confirmations (§2) and owner notifications consume them, so a failed send never rolls back a booking.

### 1.5 Agent rules (scheduling)
- Ask the service first, then the staff preference ("anyone is fine" → `'any'`), then the day or part of day.
- Offer **at most 3** options and say them as spoken times ("Tuesday at 3:30").
- Never offer a time that didn't come from `check_availability` within the last 2 minutes. If more time has passed, re-check before `prepare`.
- Relative dates resolve against `get_current_tenant_time`. When a phrase is ambiguous, say the actual date ("next Tuesday, that's the 27th?").
- Hold expiry during a long call: re-prepare and re-read back.
- Prices: say `priceText` exactly ("from $45"). If there is no price, say "the shop will confirm the price."

### 1.6 Edge cases (each one becomes a scenario)
1. Two callers want the same 3:30 slot. The second gets CONFLICT and alternatives.
2. "Next Tuesday" said on a Tuesday, a Sunday or a Monday night after midnight.
3. A booking that crosses the DST change (Sun Nov 1), and an 11:30 PM–12:30 AM override.
4. A staff member is off that day but the shop is open. "Any staff" works, and "with Marco" gets an offer of his next day.
5. Multi-service (cut + beard) where only one staff member does both.
6. The caller changes the service after the readback, which means a new prepare (the old hold is released).
7. Caller ID is blocked or differs: rescheduling is refused without name + date + time, and the agent offers a message.
8. A reschedule inside the cancellation window: the agent states the policy and offers to take a message for the owner.
9. The commit times out on the network and is retried with the same token, so exactly one booking exists.
10. The owner books the same slot in the UI while the agent holds it. The UI gets CONFLICT showing "held by phone call, expires 3:34".
11. The shop has no services configured: the agent takes a message and never invents a service.
12. Two family members are booked from the same phone. `find` returns both, and the agent asks which.
13. A price question for an unpriced service.
14. A caller asks for "the earliest anything" today, after the same-day cutoff.
15. A booking for someone else ("for my son"): the customer name is the son's and the phone is the caller's.

---

## 2. SMS: two-way inbox, confirmations and consent
**Benchmarks:** Podium, Heymarket, OpenPhone/Quo-style shared inboxes, plus the native SMS of Square/Booksy/Fresha.

### 2.1 Best-in-class feature set
| Area | Feature | v1 | Later |
|---|---|---|---|
| Inbox | One thread per customer and number; unread/open/closed; assign; internal notes; canned replies; search; mobile-friendly | ✅ (exists; UI pass Wed) | |
| Inbox | Customer context beside the thread: next booking, last call, open tickets | ✅ | |
| Inbox | Delivery status (queued/sent/delivered/failed/undelivered) with failure reasons | ✅ (StatusCallback) | |
| Automation | Booking confirmation, 24 h and 2 h reminders; replies C (confirm) / R (reschedule) / X (cancel) | ✅ C/X; R becomes a callback ticket | R → agent-led reschedule by SMS (wk 2) |
| Automation | After-hours auto-reply; missed-call text-back ("Sorry we missed you, book here / reply") | ✅ missed-call text-back (flagged) | |
| AI | Agent drafts a reply for the owner (exists: ai-draft); agent replies autonomously only within the template's allowed intents | drafts ✅; autonomous wk 2 | |
| Compliance | STOP/START/HELP, consent log, quiet hours, per-tenant sender, A2P/toll-free status gating, opt-out honored across every send path | ✅ **single chokepoint** | |
| Media | MMS in/out (photos of nail designs, damage photos for dispatch) | inbound view ✅ | outbound wk 2 |
| Campaigns | Broadcasts/marketing | — (out of scope; compliance risk) | later |

### 2.2 What QVO already has
- **Inbox routes:** `server/admin-api/routes/smsInbox.ts` covers threads, messages, notes, activity, counts, deferred messages, bulk update, templates, auto-reply rules, assignment rules, consent history, analytics, AI draft and compliance settings.
- **Conversation service:** `platform/sms/SmsConversationService.ts` (consent log `opt_in`/`opt_out`/`help_request`, analytics).
- **Quiet hours:** `platform/sms/SmsQuietHours.ts` (`evaluateSmsQuietHoursForTenant`, federal window clamp).
- **Inbound STOP handling:** `server/voice-gateway/routes/twilio.ts:903` (logs `opt_out`).
- **Tables:** `052_sms_enterprise.sql`.
- **UI:** `client-app/src/pages/SmsInbox.tsx`.

### 2.3 Gaps
1. 🔴 **No send chokepoint.**
   - `platform/integrations/twilio/sender.ts → sendTwilioSms()` posts straight to Twilio with no opt-out check, no quiet-hours check and no StatusCallback.
   - The agent's `send_sms` tool (`handlers/sendSms.ts`) calls it directly, and so does `voice-gateway/routes/stream.ts`.
   - Quiet hours are enforced only in campaigns (`ComplianceService.ts`).
   - Result: an opted-out number can still be texted by the agent.
2. 🔴 There's no messaging-readiness gate. Nothing stops sends before A2P/toll-free approval (`SMS_ENABLED` doesn't exist yet).
3. 🟠 The agent can compose free-text SMS. Agent sends should be **template-only** (confirmation, directions, "here's the link"), with variables filled from data.
4. 🟠 No outbox/retry. A Twilio error during a call bubbles up into the conversation.
5. 🟡 The confirmation reply keywords (C/X) aren't wired to bookings.

### 2.4 Actions
| Action | Kind | Input | Output | Errors |
|---|---|---|---|---|
| `sms.send` (internal chokepoint; every path uses it) | write | `{ to, templateKey?, body?, vars?, purpose: 'transactional'\|'conversational'\|'marketing', relatedEntity?: {type,id} }` | `{ messageId, status:'queued'\|'deferred_quiet_hours'\|'suppressed', reason? }` | `RECIPIENT_OPTED_OUT`, `MESSAGING_NOT_ENABLED`, `QUIET_HOURS` (deferred, not lost), `INVALID_NUMBER`, `LANDLINE` (when lookup is available), UPSTREAM_UNAVAILABLE |
| `sms.send_confirmation.prepare` / `.commit` (agent) | prepare/commit | `{ bookingId \| orderId \| jobId, kind: 'confirmation'\|'directions'\|'link' }` | readback ("I'll text the confirmation to the number ending 0142, okay?") → `{ status }` | as above |
| `sms.reply` (UI/MCP) | write | `{ threadId, body \| templateKey }` | message | as above |
| `sms.list_threads` / `sms.get_thread` | read | filters | threads/messages + customer context | — |
| `sms.assign` / `sms.close` / `sms.add_note` | write (UI) | `{ threadId, … }` | — | — |
| `sms.handle_inbound` (system, from the webhook) | write | Twilio payload | routes to STOP/HELP/START, C/X keywords, auto-reply, or the inbox + owner notification | signature invalid → 403 |

**Validation:**
- E.164 numbers only.
- A body is either a template or ≤ 640 chars; GSM-7/UCS-2 segments are counted.
- No URLs except allow-listed shop links.
- `marketing` purpose is rejected in v1.

**Send order inside the chokepoint:**
1. Tenant messaging status (`SMS_ENABLED` and the A2P/TF status).
2. Opt-out (latest consent event).
3. Quiet hours (transactional messages sent within 1 minute of a live call are exempt, e.g. "here's our address"; that is configurable).
4. Rate limit per recipient.
5. Persist the outbound message.
6. Twilio send with StatusCallback.
7. Update the status.

**Idempotency:** key = `relatedEntity + templateKey + to` for automated sends (so a reminder is never sent twice). Agent commits are keyed by the token.

### 2.5 Agent rules (SMS)
- Never say "I've texted you" unless `sms.send_confirmation.commit` returned `queued`.
- `deferred_quiet_hours` → "you'll get the text in the morning."
- `MESSAGING_NOT_ENABLED` or `RECIPIENT_OPTED_OUT` → "I can't text this number; the shop will confirm by email or you can call back."
- Read the destination back as "the number ending in 0142." The caller can give a different mobile number, which then gets its own readback.
- No free-text SMS from the agent in v1.

### 2.6 Edge cases
1. The caller texted STOP last month and is now booking by phone. No confirmation SMS goes out, and the agent says so truthfully.
2. The caller replies "STOP" to a reminder, then "START".
3. "Stop texting me so much" (not the exact keyword): the inbox flags it as a likely opt-out for the owner.
4. A reply arrives after the booking was cancelled.
5. A landline caller ID: the send fails with `undelivered`, and the owner sees the failure on the booking.
6. Quiet hours at 9:05 PM local for a reminder: it's deferred to 8 AM.
7. A two-segment Spanish message (UCS-2).
8. A Twilio 5xx during a live call: the booking stays confirmed, the send is retried by the outbox, and the agent doesn't claim it was sent.
9. The same number belongs to two customers (a family): the thread links to both.
10. An MMS photo arrives inbound.
11. A spoofed webhook without a valid Twilio signature.

---

## 3. Ticketing: messages, callbacks and requests
**Benchmarks:** Zendesk, Freshdesk and Help Scout, narrowed to the small-business use: "take a message", "have someone call me back", complaints, quote requests, and legal or real-estate intake.

### 3.1 Best-in-class feature set
| Area | Feature | v1 | Later |
|---|---|---|---|
| Capture | Ticket from a call, SMS or UI, with **kind**: message, callback, complaint, quote request, intake, other | ✅ | |
| Capture | Structured fields per kind and template (law: matter type, conflict-check names; real estate: property, buyer/seller, budget) | ✅ via the template's intake schema | |
| Context | Linked call (transcript, summary, recording if on), customer, booking/order/job | ✅ | |
| Workflow | Status open → in progress → resolved/closed; assignee; priority; **callback due-by** (SLA) with overdue highlighting | ✅ (reuse SLA tables) | |
| Notify | Owner/assignee alert on new urgent tickets (email; SMS when enabled; push via mobile later) | ✅ email | push wk 2 |
| Actions | "Call back" button (click-to-call from the business number), canned replies, merge duplicates | ✅ call-back link + merge | |
| Reports | Open/overdue counts, time to first callback | basic | wk 2 |

### 3.2 What QVO already has
- **Routes:** `server/admin-api/routes/tickets.ts`.
- **Tables:** `migrations/049_enterprise_ticketing.sql` covers categories, activity log, watchers, attachments, links, SLA policies/instances, macros, saved views, templates, custom fields, workflow rules, queue configs, retention and notifications.
- **`tickets` columns:** call_id, status (open/in_progress/resolved/closed), priority, source (`ai_agent` allowed), ticket_number, contact name/email/phone, parent_ticket_id, first_response_at, resolved_at.
- **Voice tool:** `create_ticket` (`handlers/createTicket.ts`).
- **UI:** `client-app/src/pages/Tickets.tsx`.

### 3.3 Gaps
1. 🟠 There's no `kind` (message/callback/…), no `callback_due_at`, and no structured intake payload tied to a template.
2. 🟠 The agent tool writes directly. It has no dedupe: one call can create 3 tickets when the caller repeats themselves.
3. 🟠 The owner alert isn't guaranteed (no outbox).
4. 🟡 The UI is enterprise-heavy, and a shop owner needs a simple "Messages & callbacks" list.

### 3.4 Actions
| Action | Kind | Input | Output | Errors |
|---|---|---|---|---|
| `tickets.open.prepare` / `.commit` | prepare/commit | `{ kind, subject ≤120, details ≤2000, customer:{name, phone}, urgency:'normal'\|'urgent', callbackWindow?, intake?: object (validated by the template's schema), related?:{type,id} }` | readback ("I'll pass this to Dana: you'd like a callback about … at 555-0142, today after 3") → `{ ticketId, ticketNumber, dueAt }` | VALIDATION_FAILED (intake), TOOL_NOT_ENABLED |
| `tickets.add_note` | write | `{ ticketId, note }` | — | NOT_FOUND |
| `tickets.update` | write (UI/MCP) | `{ ticketId, status?, assigneeId?, priority?, dueAt? }` | ticket | invalid transition |
| `tickets.list` / `tickets.get` | read | filters (`open`, `overdue`, `kind`) | tickets + linked call summary | — |
| `tickets.merge` | write (UI) | `{ sourceId, targetId }` | — | — |

**Dedupe:** within one call, a second `open` of the same kind for the same phone becomes `add_note` on the first ticket (the server decides). **Idempotency:** token-keyed. **Effects:** `ticket.opened` → owner alert through the outbox.

### 3.5 Agent rules
- Collect the name, the callback number (read back digit-grouped), the reason in the caller's words, and the best time.
- Never promise a callback time the business didn't set. Use the template's SLA text ("usually within 2 business hours").
- Law and real estate: never give advice or opinions. The agent only takes the intake.
- Urgent keywords set by the template (e.g. "flooding", "court date tomorrow") → `urgency:'urgent'`, and transfer if the template allows it.

### 3.6 Edge cases
1. The caller refuses to give a name.
2. The caller's callback number differs from caller ID.
3. The caller repeats the request three times (dedupe).
4. Abusive caller: the agent offers a message and then ends the call per policy.
5. Someone calls back about an existing ticket (find by phone → add a note).
6. A caller asks for a lawyer's opinion: the agent declines and takes the intake.
7. An after-hours urgent request with no on-call number configured.
8. A Spanish caller: the ticket is stored in the original language plus an English summary.

---

## 4. Dispatch: field-service jobs (built next week)
**Benchmarks:** Jobber, Housecall Pro.

### 4.1 Best-in-class feature set
- Job intake with address validation and service-area check.
- Job types with durations and skills.
- **Arrival windows** rather than exact times.
- A dispatch board by tech/day, with assignment by skill, territory and load.
- "On my way" SMS with ETA, and job status (scheduled → en route → on site → done).
- A tech mobile app with photos, notes and checklists.
- Emergency/after-hours on-call routing.
- Recurring maintenance jobs.
- Estimates and invoices later (out of scope for v1, which uses Stripe links when live).

### 4.2 What QVO already has
- **Routes:** `server/admin-api/routes/dispatch.ts` (5,747 lines) covers jobs CRUD/transition/follow-up/exceptions/attachments/batch, resources, skills, locations, routes/export, completion photos, territories, notification templates, assignment rules, reporting, settings and live ETA.
- **Tables:** `052_enterprise_dispatch.sql` (+ territory_id, resource_id, job_type, estimated/actual duration, eta_start/eta_end, address, contact, required_skills, parent_job_id) and migrations 083/085/090.
- **Mobile:** the Expo tech app in `mobile/` + `routes/mobileApi.ts`.
- **Voice tool:** `create_dispatch_job` (`handlers/createDispatchJob.ts`).
- **UI:** `client-app/src/pages/Dispatch.tsx`.

### 4.3 Gaps
- Same pattern as scheduling: the voice tool writes directly, logic lives in routes, and there's no arrival-window availability, no service-area check, and no double-assignment constraint per tech/window.
- Address validation is not verified to exist.
- The "on my way" SMS needs the §2 chokepoint.

### 4.4 Actions (contract now, build week 2)
| Action | Kind | Input | Output | Errors |
|---|---|---|---|---|
| `dispatch.check_service_area` | read | `{ address \| zip }` | `{ inArea, territoryId, normalizedAddress }` | `OUT_OF_AREA` |
| `dispatch.check_windows` | read | `{ jobTypeId, date?, urgency }` | `[{windowStart, windowEnd, spoken}]` (from tech capacity/skills) | — |
| `dispatch.create_job.prepare` / `.commit` | prepare/commit | `{ jobTypeId, window, address, contact, problem, accessNotes?, urgency }` | readback → `{ jobId, window }` | CONFLICT, OUT_OF_AREA, OUTSIDE_POLICY |
| `dispatch.assign_job` | write (UI/MCP/system) | `{ jobId, techId }` | — | `TECH_UNAVAILABLE`, `SKILL_MISMATCH` |
| `dispatch.update_status` | write (tech app) | `{ jobId, status, eta? }` | emits `job.en_route` → SMS | invalid transition |
| `dispatch.get_job_status` | read (agent) | `{ phone, name }` | status + window (verified caller only) | NOT_FOUND |
| `dispatch.page_on_call` | write (agent, urgent) | `{ jobId }` | `{ paged:true, who }` | `NO_ON_CALL` |

**Agent rules:** quote windows, never exact times. Read the address back including the unit number. Never quote prices unless the template has flat-rate data. Emergencies (gas smell, active flooding) follow the template script: safety line first, then page on-call or transfer.

**Edge cases:**
1. An address that's out of area.
2. Apartment/gate codes.
3. A caller who isn't the property owner (a tenant).
4. A duplicate job from the same address.
5. A tech running late shifts later windows.
6. A same-day emergency after hours.
7. "Where's my tech?" with a different caller ID.
8. The address can't be geocoded.

---

## 5. Order taking: restaurants and takeout (built next week)
**Benchmarks:** Toast Online Ordering, Square Online.

### 5.1 Best-in-class feature set
- A menu with categories, items, sizes and **modifiers** (required/optional, min/max, priced).
- Item availability ("86'd") in real time, and menus by daypart.
- Prep-time quoting with throttling (max orders per 15 min).
- Pickup now / scheduled pickup; delivery zones later.
- Allergy/special-instruction notes.
- Order ticket to the kitchen: printer/KDS or a POS integration, or an owner screen with sound in v1.
- Order-ready SMS.
- Pay at pickup in v1; a pay link when Stripe is live.
- Upsell suggestions configured by the owner, never invented.

### 5.2 What QVO already has
- **No order tables, order routes or menu model** (`rg` over migrations finds no `orders`/`menu_items` tables).
- Only `platform/reasoning/industry-packs/restaurant.ts` (prompt-level industry pack).
- **This is a greenfield tool.**

### 5.3 Actions (contract now, build week 2; migration reserved then)
| Action | Kind | Input | Output | Errors |
|---|---|---|---|---|
| `orders.get_menu` | read | `{ daypart? }` | items with modifiers, prices and availability | — |
| `orders.quote` | read | `{ items:[{itemId, qty 1–20, modifiers:[{groupId, optionIds}], note?}], fulfillment:'pickup', pickupAt?: 'asap'\|ISO }` | `{ lines, subtotal, tax, total, readyAt, spokenSummary }` | `ITEM_UNAVAILABLE`, `MODIFIER_INVALID` (required group missing, max exceeded), `CLOSED`, `THROTTLED` (next available time) |
| `orders.place.prepare` / `.commit` | prepare/commit | quote input + `{ customer:{name, phone} }` | full line-by-line readback with total and ready time → `{ orderId, orderNumber, readyAt }` | as above + CONFIRMATION_INVALID |
| `orders.update_status` | write (UI/POS) | `{ orderId, status: 'accepted'\|'ready'\|'picked_up'\|'cancelled' }` | emits `order.ready` → SMS | — |
| `orders.get_status` | read | `{ phone, name }` | status, readyAt | NOT_FOUND |

**Integrity:**
- Prices are recomputed server-side at commit; the agent's numbers are never trusted.
- Throttling is checked in the commit transaction.
- `orderNumber` is a per-day sequence.

**Agent rules:**
- Confirm each item as it's added ("one large pepperoni, extra cheese").
- Read back the full order with the total **before** commit.
- Allergy questions get only the menu's allergen data plus "please tell staff at pickup." The agent never says something is "safe."

**Edge cases:**
1. An item is 86'd mid-call.
2. A required modifier is skipped ("which size?").
3. "Same as last time."
4. Multiple people ordering on one call.
5. Kitchen throttled: the agent offers a later pickup.
6. The caller changes an item after the readback (new prepare).
7. Large catering orders above a threshold become a ticket.
8. A call 5 minutes before close.
9. Menu prices changed between the quote and the commit (re-readback).

**POS:** v1 is QVO's own owner screen. Week 3+ adds Square/Toast connectors behind `orders.*` actions, using the partner APIs where available; browser automation only where no API exists.

---

## 6. Business info, calls and transfer (supporting actions every template uses)
| Action | Kind | Notes |
|---|---|---|
| `business.get_info` | read | Hours (today/this week, holidays), address, parking, services/prices summary and policies, from structured tenant data only. Missing fields return `null`, and the agent says it doesn't know |
| `calls.transfer_to_human.prepare` / `.commit` | prepare/commit | Within the template's transfer hours: warm transfer (Twilio `<Dial>` with timeout). No answer or after hours → `tickets.open` (kind message). The readback is "I'll connect you to Dana now" |
| `calls.record_outcome` | write (agent) | Outcome code + summary for call review; required before hangup |
| `customers.lookup` | read | By caller phone → name and upcoming items. Used only to personalize after verification |

---

## 7. Use-case templates (QVO configures; customers don't build agents)
A template is a versioned config in `platform/templates/use-cases/<id>.ts`. It holds:
- **enabled actions** (only these become agent tools);
- **required setup** (what onboarding must collect);
- intake schemas;
- greeting and disclosure;
- policies (transfer hours, urgent keywords, SLA text);
- the scenario-pack IDs that must pass before go-live.

A business can enable one tool or all of them; the template sets the defaults.

| Template | Scheduling | SMS | Tickets | Dispatch | Orders | Required setup | Template-specific rules | Ships |
|---|---|---|---|---|---|---|---|---|
| **Barbershop** | ✅ core | ✅ confirmations, reminders, missed-call text-back | ✅ messages/callbacks | — | — | Services (duration/price), barbers + who does what, hours, transfer number | "Anyone" defaults to first available; walk-in questions get the current wait = "call or come by" (no queue v1); cut + beard combos | **This week** |
| **Nail salon** | ✅ core + multi-service | ✅ | ✅ | — | — | As above + service add-ons, processing time (wk 2), group bookings (wk 3) | Gel removal add-on prompts; "can I get two chairs at once" → ticket until group bookings ship; Spanish/Vietnamese language option where supported | **This week** |
| **Home-service dispatch** (HVAC, plumbing, cleaning) | (windows via dispatch) | ✅ on-my-way/ETA | ✅ quotes, complaints | ✅ core | — | Service area (zips), job types + skills, techs, on-call rota, emergency script | Windows only; safety script for gas/flooding; never price unless flat-rate data exists | Week 2 |
| **Real estate** (small brokerage/team) | ✅ showings (agent = provider, property = resource) | ✅ | ✅ intake: buyer/seller/renter, property, budget, pre-approval yes/no, timeline | — | — | Agents, listings feed or a manual property list, showing rules | Fair-housing-safe language; no opinions on price/value; showing booked only for listed properties; lead routed to the listing agent | Week 3 (after vertical-2 choice) |
| **Restaurant** (takeout) | (optional: reservations later) | ✅ order-ready | ✅ catering/large orders | — | ✅ core | Menu + modifiers, hours/dayparts, prep time, throttle, tax rate | Full readback with total; allergens only from data; catering > threshold → ticket | Week 2–3 |
| **Law office** (≤ 20 people) | ✅ consultations | ✅ (confirmations only) | ✅ core: intake with matter type, opposing-party names for conflict check, urgency/deadline | — | — | Practice areas, consult types/durations, attorneys, intake questions, conflict-check routing | Never legal advice; "no attorney-client relationship yet" disclosure; deadline keywords → urgent; record-retention settings | Week 3 |

**MCP surface for templates** (Wayne's bots):
- `qvo.list_templates`
- `qvo.provision_business({template, businessInfo})` (dryRun default)
- `qvo.apply_template({tenantId, templateId, overrides})`
- `qvo.validate_setup({tenantId})` (lists missing required fields)
- `qvo.run_test_calls({tenantId, scenarioPack, mode:'text'|'phone'})`
- `qvo.get_call_reviews({tenantId, since})`
- `qvo.get_quality_report({tenantId})`

All write tools need the `qvo:admin` scope. Phone test runs need Wayne's approval flag, because they place real calls.

---

## 8. Definition of "full spec" for this week
**Full spec this week:** scheduling (§1, v1 column), SMS (§2, v1 column, with sending behind `SMS_ENABLED` until the texting path is approved), ticketing (§3, v1 column), business info + transfer (§6), barbershop + nail salon templates, and the MCP server with provisioning, templates, test runs and reviews.

**Contract-only this week, built next week:** dispatch (§4) and orders (§5).

**Exit test per tool:**
- every action has zod schemas, unit tests and a route test via the HTTP adapter;
- the agent-tool schema is generated from the action (snapshot test);
- each listed edge case is a passing scenario;
- concurrency and idempotency tests exist for every commit;
- RLS cross-tenant denial is tested.
