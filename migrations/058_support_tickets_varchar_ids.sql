-- The recreated support_tickets table from migration 057 used UUID for tenant_id
-- and user_id (matching migration 055's intent), but the project's tenants.id and
-- users.id columns are stored as VARCHAR. The resulting type mismatch caused the
-- LEFT JOIN tenants tn ON tn.id = t.tenant_id query in the support inbox endpoint
-- to fail with "operator does not exist: character varying = uuid", returning 500.
--
-- Convert both columns to VARCHAR(64) to match the rest of the schema.

ALTER TABLE support_tickets
  ALTER COLUMN tenant_id TYPE VARCHAR(64) USING tenant_id::text,
  ALTER COLUMN user_id   TYPE VARCHAR(64) USING user_id::text;

ALTER TABLE support_ticket_replies
  ALTER COLUMN author_user_id TYPE VARCHAR(64) USING author_user_id::text;
