-- 088_dispatch_jobs_tracking_token.sql
-- Per-job opaque token used by the customer-facing booking-tracker
-- page. Customers reach the page by tapping the SMS link, which
-- carries this token (never the raw job UUID). The token is the only
-- credential the public endpoint accepts, so it must be unguessable
-- and unique across all jobs.

ALTER TABLE dispatch_jobs
  ADD COLUMN IF NOT EXISTS tracking_token TEXT;

-- Backfill existing rows so the unique index can be created. We use
-- gen_random_uuid() rather than a sequence so old links (if any get
-- stamped by replays of historical SMS) cannot enumerate.
UPDATE dispatch_jobs
   SET tracking_token = gen_random_uuid()::text
 WHERE tracking_token IS NULL;

ALTER TABLE dispatch_jobs
  ALTER COLUMN tracking_token SET DEFAULT gen_random_uuid()::text,
  ALTER COLUMN tracking_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_dispatch_jobs_tracking_token
  ON dispatch_jobs (tracking_token);
