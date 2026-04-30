-- Persist coupon-aware "Discount applied" badge metadata on marketplace
-- purchase rows so the in-app marketplace purchase history view can
-- render the same badge that the emailed/downloaded receipt PDF carries
-- (Task #1351 stamps the badge on the invoice; this captures it back
-- on `marketplace_purchases` when the `invoice.finalized` webhook fires
-- so the UI does not need a per-row Stripe lookup).

ALTER TABLE marketplace_purchases
  ADD COLUMN IF NOT EXISTS discount_badge_applied BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS discount_coupon_id TEXT,
  ADD COLUMN IF NOT EXISTS discount_promotion_code TEXT,
  ADD COLUMN IF NOT EXISTS discount_name TEXT,
  ADD COLUMN IF NOT EXISTS discount_percent_off NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS discount_amount_off_cents INTEGER,
  ADD COLUMN IF NOT EXISTS discount_currency TEXT;
