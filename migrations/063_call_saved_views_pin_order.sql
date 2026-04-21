-- Allow users to control the order of pinned saved views in the sidebar.
ALTER TABLE call_saved_views
  ADD COLUMN IF NOT EXISTS pin_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_call_saved_views_pin_order
  ON call_saved_views(tenant_id, pin_order)
  WHERE is_pinned = true;
