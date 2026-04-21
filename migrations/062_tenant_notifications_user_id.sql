-- Add per-user targeting to tenant_notifications.
-- When user_id IS NULL the notification is tenant-wide (visible to all members,
-- preserving the prior behavior). When user_id is set, only that user sees it.
ALTER TABLE tenant_notifications
  ADD COLUMN IF NOT EXISTS user_id VARCHAR REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_tenant_notifications_user
  ON tenant_notifications(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_tenant_notifications_user_unread
  ON tenant_notifications(tenant_id, user_id, read) WHERE read = FALSE;
