-- Drop the legacy global is_pinned column on call_saved_views.
-- Per-user pinning now lives in call_saved_view_pins (migration 063).
-- The pin_order index from migration 063_call_saved_views_pin_order.sql
-- predicates on is_pinned, so drop it first.
DROP INDEX IF EXISTS idx_call_saved_views_pin_order;
DROP INDEX IF EXISTS idx_call_saved_views_pinned;

ALTER TABLE call_saved_views
  DROP COLUMN IF EXISTS is_pinned;
