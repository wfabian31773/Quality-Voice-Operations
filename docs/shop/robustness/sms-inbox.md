# SMS inbox robustness

Owner/staff two-way SMS inbox (`server/admin-api/routes/smsInbox.ts`). The voice agent does not call these routes; it uses `sms.send` / `sms.send_confirmation.*` (tools-spec §2.4). This doc is for the HTTP adapter the owner UI uses.

## Guaranteed now

- **Write validation.** PUT/PATCH thread, POST messages, POST notes, POST bulk-update, template create/update/substitute, auto-reply create/update, and assignment-rule create reject bad bodies with `400 { error, fields }` before any database write. Extra keys are rejected (`.strict()`). Bulk-update accepts at most 200 ids.
- **Reply idempotency.** `POST /sms-inbox/threads/:id/messages` reads an optional `Idempotency-Key` header, namespaces it (`sms:inbox:{tenantId}:{threadId}:{key}`), and passes it to `sendUserSms`. The `sms.send` chokepoint already keys writes on that value: the same key + same body returns the stored result and does not send a second text. The header is optional so today's client-app (which does not send one) still works; each click then gets a fresh `sms:user:{uuid}` inside `sendUserSms`.
- **Single send chokepoint.** Immediate inbox replies call `sendUserSms`; the scheduled dispatcher calls `sendStoredSms`. Both are `sms.send`. An opted-out recipient is `403` with `{ error, reason: 'recipient_opted_out', code: 'RECIPIENT_OPTED_OUT' }` (the chokepoint's message); Twilio is not called.
- **Tenant isolation.** Every write looks up the thread/template/rule with `tenant_id` from the session. A tenant-B id is `404` and the mutation is not invoked. Bulk-update walks the id list, keeps only rows `getConversation` returns for this tenant, and updates those; foreign ids are skipped (`updated` counts only own rows).
- **Activity log.** Assignment, close, reopen, bulk-update (per own thread), and notes each write a `logActivity` row (`assigned`, `status_changed`, `tagged`, or `note_added` — the existing check constraint). Close/reopen on a single thread already logged `status_changed`; bulk-update previously only wrote the platform audit log.

## tools-spec edge cases and tests

| Spec | Case | Test |
|---|---|---|
| §0.4 / §2.4 idempotency | Double-click reply with the same `Idempotency-Key` → one Twilio send, same message id | `sends one SMS and returns the same body when the Idempotency-Key is replayed` (`smsInbox.integration.test.ts`); header is namespaced in `passes a namespaced Idempotency-Key into sendUserSms` |
| §2.3 / §2.4 / §2.6.1 opt-out | Owner replies to a number whose latest consent is `opt_out` → 4xx, nothing sent | `returns 403 with the chokepoint opt-out reason and never calls Twilio` (integration); `returns the chokepoint reason and does not send when the recipient opted out` (unit). Quiet-hours suite keeps `does not text an opted-out recipient (403)`. |
| §0.5 tenant isolation | Tenant B thread/template/rule ids on writes → 404 | `returns 404 and does not update tenant B thread ids`; `returns 404 and does not send for tenant B thread ids`; `returns 404 and does not insert a note on tenant B thread ids`; template/rule 404 tests in `smsInbox.test.ts` |
| §0.5 tenant isolation | Mixed bulk-update id list | `changes only own rows when the id list mixes own and foreign threads` |
| §2.4 validation | Bad write bodies never reach the DB | `rejects an invalid status`, `rejects unknown fields so they never reach the database`, `rejects more than 200 ids`, missing body/title/replyBody tests |
| §2.4 audit (UI writes) | Assignment / close / reopen / bulk / notes leave activity | `logs assignment when assigneeUserId changes`, `logs status_changed on reopen`, `updates the conversation + logs activity + audit`, bulk mixed-id test, `adds a note and writes an activity row` |

Not covered here (other PRs / later): inbound STOP/START/HELP and spoofed webhooks (voice-gateway), quiet-hours deferral (already `smsInboxQuietHours.test.ts`), landline lookup, UCS-2 segment counting, MMS outbound, marketing purpose, agent `sms.send_confirmation.*`.

## Still open

- Client-app does not send `Idempotency-Key` yet, so a UI double-click without the header can still send two texts. Wire the header in the composer as a follow-up.
- Replaying a reply with a key writes a second `message_sent` activity row (the SMS is not resent). Skip activity on chokepoint replay if that becomes noisy.
- Notes / template / rule writes are not keyed for HTTP idempotency (only replies go through `sms.send`).
- `PUT /sms-inbox/compliance-settings` and `POST /sms-inbox/ai-draft` are outside this validation pass.
- `message_deferred` activity rows used by the scheduler are not in `sms_activity_action_check` (pre-existing; needs a migration if Postgres enforces it).
- Extracting inbox writes into `sms.reply` / `sms.assign` / `sms.close` / `sms.add_note` actions (tools-spec §2.4) is still the larger adapter split.
