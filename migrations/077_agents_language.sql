ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS language VARCHAR(8) NOT NULL DEFAULT 'en';

UPDATE agents SET language = 'en' WHERE language IS NULL OR language = '';
