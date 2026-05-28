-- Per-user pins for shared (and personal) call saved views. Replaces the
-- global is_pinned column on call_saved_views, so that one teammate pinning
-- a shared view no longer forces it into everyone else's sidebar.
-- Each pin also carries its own per-user `pin_order` so teammates can drag
-- their own pinned chips into whatever order they want without affecting
-- anyone else.
CREATE TABLE IF NOT EXISTS call_saved_view_pins (
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  view_id VARCHAR(255) NOT NULL REFERENCES call_saved_views(id) ON DELETE CASCADE,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pin_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, view_id)
);

CREATE INDEX IF NOT EXISTS idx_call_saved_view_pins_view
  ON call_saved_view_pins(view_id);
CREATE INDEX IF NOT EXISTS idx_call_saved_view_pins_tenant_user
  ON call_saved_view_pins(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_call_saved_view_pins_user_order
  ON call_saved_view_pins(user_id, pin_order);

ALTER TABLE call_saved_view_pins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_call_saved_view_pins ON call_saved_view_pins;
CREATE POLICY tenant_isolation_call_saved_view_pins ON call_saved_view_pins
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Backfill: any view that was previously pinned globally becomes a per-user
-- pin for its owner so they don't lose their sidebar shortcut.
--
-- NOTE: we use a literal 0 for `pin_order` instead of reading it from
-- `call_saved_views.pin_order` because of a prefix-collision ordering bug:
-- the sibling migration that ADDS `call_saved_views.pin_order` is also
-- prefixed 063 (`063_call_saved_views_pin_order.sql`) and sorts AFTER this
-- file alphabetically, so the column doesn't exist yet when this migration
-- runs against a fresh database (e.g. CI). The cross-migration data
-- dependency made `Admin pages e2e` fail every push since 2026-05-25.
--
-- The cost of dropping that COALESCE is exactly zero in practice: the
-- per-view `pin_order` column was only added by sibling-063 and dropped
-- entirely by migration 065_call_saved_views_drop_pin_order.sql, so the
-- column's effective lifetime is one migration. Any in-flight value
-- would have been lost at 065 regardless.
INSERT INTO call_saved_view_pins (user_id, view_id, tenant_id, pin_order)
SELECT created_by, id, tenant_id, 0
FROM call_saved_views
WHERE is_pinned = true AND created_by IS NOT NULL
ON CONFLICT DO NOTHING;
