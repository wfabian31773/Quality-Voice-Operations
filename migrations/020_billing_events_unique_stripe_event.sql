CREATE UNIQUE INDEX IF NOT EXISTS billing_events_stripe_event_id_unique
  ON billing_events (stripe_event_id) WHERE stripe_event_id IS NOT NULL;
