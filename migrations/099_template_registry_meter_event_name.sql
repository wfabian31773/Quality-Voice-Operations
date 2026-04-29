-- Add per-template Stripe meter event name so marketplace add-ons with a
-- usage-based price model can report consumption through the modern Billing
-- Meter Events API instead of the deprecated subscriptionItems.createUsageRecord
-- endpoint. NULL means "fall back to the STRIPE_MARKETPLACE_METER_EVENT env
-- default" inside platform/marketplace/MarketplacePurchaseService.ts#reportUsage.
ALTER TABLE template_registry
  ADD COLUMN IF NOT EXISTS stripe_meter_event_name TEXT;
