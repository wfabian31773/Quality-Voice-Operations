-- Allow users to pin saved Conversations views into the tenant sidebar.
ALTER TABLE call_saved_views
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_call_saved_views_pinned
  ON call_saved_views(tenant_id)
  WHERE is_pinned = true;
