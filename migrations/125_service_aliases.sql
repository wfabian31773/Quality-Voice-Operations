-- Spoken aliases on services (barber vocabulary follow-up to the Oct 17
-- live call: "a fade" / "shape-up" / "degradado").
--
-- Adds scheduling_appointment_types.aliases: alternative names a caller may
-- say for the service ("skin fade", "bald fade", "degradado"). The catalog
-- loader (platform/actions/scheduling/availability/loaders.ts) reads it, and
-- platform/actions/scheduling/serviceMatch.ts matches spoken text against
-- the name, then the aliases, then the shared EN/ES service lexicon.
--
-- Expand-only: one new column with a constant default, so existing rows read
-- '{}' and no row is rewritten (PostgreSQL 11+ stores the default in the
-- catalog). No drops, renames or data changes.
--
-- No index: matching runs in the app over one tenant's catalog (a few dozen
-- rows already loaded by tenant_id), never as an alias lookup in SQL. Add a
-- GIN index only if a query ever filters on aliases.
--
-- RLS: the table's existing tenant policies cover the new column.
--
-- Locking: ADD COLUMN takes ACCESS EXCLUSIVE on scheduling_appointment_types
-- for a catalog-only change. lock_timeout makes the migration fail fast
-- instead of queueing behind a long transaction.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is a no-op the second time.

SET LOCAL lock_timeout = '5s';

ALTER TABLE scheduling_appointment_types
  ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';
