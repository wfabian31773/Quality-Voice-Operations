-- Per-recipient dedup table for the "first hard bounce" ops alert.
--
-- Why a separate table rather than a column on support_email_suppressions?
--   * The suppression list is a write-frequently / clear-occasionally store —
--     ops can clear an entry once an address is fixed, and a future re-bounce
--     should re-fire the alert. Stamping `alerted_at` directly on the
--     suppression row would couple those lifecycles and force ops to remember
--     to also clear the alert flag when they clear suppression.
--   * Having a dedicated table keeps the dedup signal narrow ("the first time
--     we paged ops about THIS address bouncing"), and makes it cheap for the
--     bounced-recipients admin panel to show an "alerted" badge via a single
--     PK lookup.
--
-- Address is lowercased for the same reason as support_email_suppressions: a
-- mixed-case bounce must not silently re-fire an alert that an entry under
-- different casing already covered.

CREATE TABLE IF NOT EXISTS support_recipient_bounce_alerts (
  email_lower TEXT PRIMARY KEY,
  -- Reply / ticket / tenant attribution for the failure that triggered the
  -- first alert. Nullable so an entry written from a future code path that
  -- doesn't have a reply context (e.g. an out-of-band provider webhook) can
  -- still record the dedup row.
  reply_id INTEGER,
  ticket_id VARCHAR(64),
  tenant_id VARCHAR(64),
  -- Most recent SMTP error captured at alert time, for forensics from the
  -- admin panel without a join back to support_ticket_replies.
  last_error TEXT,
  first_alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
