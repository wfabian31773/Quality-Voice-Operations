-- Audit trail for support-email resubscribes.
--
-- The `/support/resubscribe` handler DELETEs the row from
-- `support_email_unsubscribes` so the send-side gate (`checkSupportEmailSkip`)
-- starts allowing mail again. That delete is the right end state, but it
-- erases ops's only on-table evidence that the recipient ever opted out —
-- the PlatformAdmin "Suppression list" view simply stops showing the
-- address with no explanation. Support reps then have to grep server logs
-- to answer "did the customer opt back in themselves, or did we drop the
-- entry by mistake?".
--
-- This table records each resubscribe as its own immutable row so:
--   * the existing read path stays a single PK lookup against
--     `support_email_unsubscribes` (no `WHERE resubscribed_at IS NULL`
--     filter creeping into the hot send path),
--   * `addSupportEmailUnsubscribe` keeps using `ON CONFLICT DO UPDATE`
--     unchanged — re-unsubscribes don't have to coordinate with the audit
--     row, and
--   * the same address can resubscribe / re-unsubscribe / resubscribe
--     again over time and we'll have one audit row per resubscribe to
--     reconstruct the timeline.
--
-- Why capture the previous unsubscribe state inline instead of joining?
--   * The unsubscribe row is gone the moment we audit (that's the whole
--     point of the resubscribe), so there's nothing left to join to.
--     Snapshotting `previous_unsubscribed_at` + `previous_source` at
--     resubscribe time is the only way to keep a forensic trail.
--
-- Address is lowercased to match `support_email_unsubscribes` so a
-- mixed-case resubscribe can never silently land under a different key
-- than the original opt-out.

CREATE TABLE IF NOT EXISTS support_email_unsubscribe_audit (
  id BIGSERIAL PRIMARY KEY,
  email_lower TEXT NOT NULL,
  -- Free-form source label captured by the resubscribe caller, e.g.
  -- 'landing_page_resubscribe'. Mirrors the `source` column on
  -- `support_email_unsubscribes` for symmetry.
  resubscribed_source TEXT,
  -- Snapshot of the unsubscribe row that was deleted, so ops can see
  -- where / when the opt-out happened without needing the (now gone)
  -- unsubscribe row. Nullable because a forged resubscribe POST against
  -- an address that was never on the list is still a successful no-op
  -- at the helper level — we don't audit those, but if we ever do the
  -- snapshot columns can stay null.
  previous_unsubscribed_at TIMESTAMPTZ,
  previous_source TEXT,
  resubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recent-first scan for the PlatformAdmin "recently resubscribed" panel.
-- The panel shows the last 30 days of resubscribes; this index keeps that
-- read O(matching-rows) instead of a full table scan as the audit grows.
CREATE INDEX IF NOT EXISTS support_email_unsubscribe_audit_recent_idx
  ON support_email_unsubscribe_audit (resubscribed_at DESC);

-- Per-address timeline lookup ("show me every time this address opted in
-- or out"). Used by the per-recipient drill-down and by the resubscribe
-- handler when it wants to dedup repeated form submits in the future.
CREATE INDEX IF NOT EXISTS support_email_unsubscribe_audit_email_idx
  ON support_email_unsubscribe_audit (email_lower, resubscribed_at DESC);
