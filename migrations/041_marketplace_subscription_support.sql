ALTER TABLE marketplace_purchases ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE marketplace_purchases ADD COLUMN IF NOT EXISTS subscription_status TEXT CHECK (subscription_status IS NULL OR subscription_status IN ('active', 'past_due', 'canceled', 'unpaid', 'incomplete'));
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_subscription ON marketplace_purchases(stripe_subscription_id);
