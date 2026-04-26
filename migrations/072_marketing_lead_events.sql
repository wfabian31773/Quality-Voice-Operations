-- Track every status change and note that happens against a marketing lead so
-- sales reps can see the full triage history in /admin/sales-inbox instead of
-- just the latest status + note.
--
-- The table is created lazily by server/admin-api/services/marketing-leads.ts
-- (so a fresh database that has never recorded a lead can still run), but we
-- also create it here so existing deployments get the new table immediately
-- on the next migration run.

CREATE TABLE IF NOT EXISTS marketing_lead_events (
  id BIGSERIAL PRIMARY KEY,
  lead_id BIGINT NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'status_change', 'note')),
  previous_status TEXT,
  new_status TEXT,
  notes TEXT,
  author TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS marketing_lead_events_lead_id_created_at_idx
  ON marketing_lead_events (lead_id, created_at DESC);

-- Backfill a 'created' event for every existing lead that doesn't have one
-- yet, so the expanded triage panel always has at least one row to render.
INSERT INTO marketing_lead_events (lead_id, event_type, new_status, created_at)
SELECT l.id, 'created', 'new', l.created_at
FROM marketing_leads l
LEFT JOIN marketing_lead_events e
  ON e.lead_id = l.id AND e.event_type = 'created'
WHERE e.id IS NULL;

-- Synthesize the most recent status_change event for leads that have already
-- been triaged before this migration ran. We only have one historical
-- timestamp/author/note per lead, so this gives a single best-effort event
-- representing "they ended up at the current status". Going forward, every
-- new triage update writes its own row.
INSERT INTO marketing_lead_events (
  lead_id, event_type, previous_status, new_status, notes, author, created_at
)
SELECT
  l.id,
  'status_change',
  'new',
  l.status,
  l.status_notes,
  l.status_updated_by,
  l.status_updated_at
FROM marketing_leads l
WHERE l.status_updated_at IS NOT NULL
  AND l.status IS NOT NULL
  AND l.status <> 'new'
  AND NOT EXISTS (
    SELECT 1 FROM marketing_lead_events e
    WHERE e.lead_id = l.id AND e.event_type = 'status_change'
  );
