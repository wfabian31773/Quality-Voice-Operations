# SMS robustness

Inbound SMS is handled by `platform/actions/sms/inbound.ts` (`handleInboundSms`).
`POST /twilio/sms` is a thin adapter: parse the Twilio body, call the handler,
return TwiML. Outbound sends stay on `sms.send` (`platform/actions/sms/send.ts`).

## What is now guaranteed

- **Validation.** `From`/`To` must normalize to E.164 (`normalizeE164`).
  `MessageSid` must start with `SM` or `MM`. `Body` is capped at
  `SMS_MAX_INBOUND_BODY_CHARS` (1600, Twilio's inbound max — not the outbound
  640-char cap). `NumMedia` is 0–10; `MediaUrlN` must be http(s).
  Invalid payloads return empty TwiML (HTTP 200) and a warn log with no phone
  number, body, or other PHI. The process does not throw.
- **Idempotency.** Twilio may deliver the same `MessageSid` more than once.
  Persist runs in one tenant transaction under
  `pg_advisory_xact_lock(hashtext('sms-inbound:' || tenantId || ':' || MessageSid))`
  and checks for an existing inbound `sms_messages` row first.
  `sms_messages.twilio_sid` is not unique (migration 052), so the lock + check
  is the guard — no new migration. A second delivery does not save a second
  message, log a second consent row, re-add DNC, re-run CSAT, or send a second
  auto-reply. Duplicate deliveries return empty TwiML (HTTP 200); Twilio already
  received the first response.
- **Consent atomicity.** For STOP, the DNC insert (`source = 'sms'`), the
  `sms_consent_log` `opt_out` row, and the inbound message save commit together.
  START logs `opt_in` and deletes the SMS-sourced DNC row in the same
  transaction. HELP logs `help_request` with the message. Keywords come from
  `isSmsOptOut` / `isSmsOptIn` / `isSmsHelp` (exact match after trim +
  lower-case), including the CTIA set STOP, STOPALL, UNSUBSCRIBE, CANCEL, END,
  QUIT, START, UNSTOP, HELP, INFO.
- **Tenant isolation.** Routing is by the *called* number. Writes use
  `withTenantClient` and `tenant_id` predicates. The same handset can be opted
  out at tenant A and opted in at tenant B.
- **MMS.** `NumMedia` and media URL/content-type pairs are stored on
  `sms_messages.metadata`. Media is never fetched.
- **Likely opt-out.** A non-exact phrase such as "stop texting me so much" or
  "please stop" does **not** opt the number out. It writes an activity-log row
  `action = 'likely_opt_out'` so the owner can see it. The phrase list is
  small and conservative (`isLikelySmsOptOut`).
- **Signature.** Invalid Twilio signatures never reach this handler.
  `twilioSignatureMiddleware` on `/twilio/sms` returns 403.

## Opt-out persist failure (choice)

If the STOP transaction fails, nothing is committed (no DNC, no consent row, no
message). The handler logs at **error** with `tenantId` + `MessageSid` only (no
phone), sends **no** auto-reply, and returns **HTTP 500** empty TwiML so Twilio
retries. A later successful retry is idempotent. Returning 200 would acknowledge
the STOP and lose it; 500 is the choice that keeps a STOP from being dropped
when the database is briefly unavailable.

Auto-reply evaluation, auto-reply persist, CSAT, and assignment run **after**
commit. A failure there does not roll back the STOP. Auto-reply persist failure
is logged at error (tenant + MessageSid) and the TwiML `<Message>` is still
returned so the customer can receive the reply via Twilio.

## tools-spec §2.6 inbound edge cases

| # | Case | Test |
|---|---|---|
| 1 | Caller texted STOP last month, now booking by phone: chokepoint suppresses | `handleInboundSms` › `§2.6 #1 opted-out caller later books…` and `sms.send` › `returns RECIPIENT_OPTED_OUT and never calls Twilio for an opted-out recipient` (`send.test.ts`) |
| 2 | STOP then START: latest consent wins, DNC lifted | `handleInboundSms` › `§2.6 #2 STOP then START…`; `handleInboundSms (local Postgres)` › `STOP then START: latest consent is opt_in…` |
| 3 | "Stop texting me so much" / "please stop": not an opt-out; likely_opt_out flag | `handleInboundSms` › `§2.6 #3 flags a non-exact opt-out phrase…`; Postgres › `records likely_opt_out on the conversation activity log…` |
| 10 | Inbound MMS photo | `handleInboundSms` › `§2.6 #10 records NumMedia…`; Postgres › `stores MMS NumMedia and media metadata…` |
| 11 | Spoofed webhook, no valid Twilio signature → 403 | `POST /twilio/sms` mounts `twilioSignatureMiddleware`; 403 cases in `tests/security/twilioSignatureMiddleware.test.ts` (`rejects with 403 when X-Twilio-Signature header is missing`, tampered signature, replay on `/twilio/sms`) |

§2.6 #4–#9 are outbound/booking/quiet-hours cases, not inbound webhook work.

Also covered: CTIA keyword table (case and whitespace) in `CTIA keywords`;
double-delivery concurrency (Postgres); cross-tenant isolation (Postgres);
invalid payload; persist failure → 500 and no auto-reply.

## Still open

- Auto-reply and assignment are best-effort after commit. If the process dies
  after a successful STOP persist but before `<Message>` TwiML is returned,
  Twilio may retry; the retry is a duplicate and will **not** re-send the
  auto-reply.
- CSAT replies are now saved to the inbox (needed so `MessageSid` idempotency
  has a row). Previously a handled CSAT short-circuited before
  `getOrCreateConversation`.
- `please stop` as a substring can flag unrelated chat ("please stop by"). The
  list stays conservative; tightening to whole-message match is a follow-up.
- Confirmation keywords C/X (§2.3 #5) are not wired to bookings.
- Outbound MMS is out of scope (tools-spec: wk 2).
