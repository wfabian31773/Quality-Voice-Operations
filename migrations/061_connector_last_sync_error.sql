ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_sync_error TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_sync_error_at TIMESTAMP;
