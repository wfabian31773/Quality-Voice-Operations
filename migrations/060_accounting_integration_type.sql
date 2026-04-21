DO $$ BEGIN
  ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'accounting';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
