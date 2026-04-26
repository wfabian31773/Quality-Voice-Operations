-- Persistent suppression and unsubscribe lists for support emails.
--
-- Why two tables and not a single boolean column on support_tickets?
--   * Suppression and unsubscribe are address-scoped, not ticket-scoped — the
--     same recipient can have many tickets and we want to skip all of them
--     without touching every row when an address goes bad.
--   * They have different lifecycles: a hard-bounce-driven suppression entry
--     can be cleared by ops once the address is fixed (out-of-band), but an
--     unsubscribe is intentionally durable per CAN-SPAM/CASL hygiene.
--   * Splitting the tables lets the read-side return a precise
--     retry_skipped_reason ('suppression_list' vs 'recipient_unsubscribed')
--     without an extra column join — one lookup per source list.
--
-- All addresses are stored lowercased so a mixed-case retry can never
-- accidentally bypass an entry written under a different casing. The send
-- paths must lowercase before lookup as well.

CREATE TABLE IF NOT EXISTS support_email_suppressions (
  email_lower TEXT PRIMARY KEY,
  -- 'permanent_smtp_failure' for hard-bounce-driven entries; left open so we
  -- can later distinguish provider-driven suppression callbacks from local
  -- bounce inference without another migration.
  reason TEXT NOT NULL,
  -- Free-form source label for forensics (e.g. 'support_reply_retry',
  -- 'support_initial_send', 'manual_admin'). Not part of the lookup; only
  -- read in admin tooling.
  source TEXT,
  -- Most recent SMTP error string captured when the entry was added, so ops
  -- can see why an address was suppressed without joining back to a reply.
  last_error TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_email_unsubscribes (
  email_lower TEXT PRIMARY KEY,
  source TEXT,
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
