-- Drop the unused global `pin_order` column on `call_saved_views`.
-- Per-user pin order now lives on `call_saved_view_pins.pin_order`
-- (see migration 063_call_saved_view_pins.sql), so this column is no
-- longer read or written by application code.

ALTER TABLE call_saved_views
  DROP COLUMN IF EXISTS pin_order;
