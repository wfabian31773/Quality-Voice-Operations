ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS outcome VARCHAR(30);
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_phone ON campaign_contacts(phone_number);
