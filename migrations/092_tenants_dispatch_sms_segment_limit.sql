-- Per-tenant cap on the number of SMS segments a saved dispatch
-- notification template body is allowed to render to. Carriers bill
-- per segment (160 GSM-7 chars / 70 UCS-2 chars in the first segment,
-- then 153 / 67 for each additional concatenated segment) so a 200-
-- char dispatch SMS that ships thousands of times a month is a real
-- cost line item. Task #824 added the live segment count under the
-- template editor preview; task #844 turns it into an enforceable
-- cap when dispatchers opt in.
--
-- NULL (the default) means "unlimited" — we explicitly do NOT
-- backfill an opinion here so existing templates that already render
-- to 2+ segments keep working unchanged. A tenant has to flip the
-- setting on (e.g. to 1) from the dispatch admin Settings panel
-- before the editor + API will start rejecting oversize bodies.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS dispatch_sms_segment_limit INTEGER;

-- Sanity guard: the cap is consumed by both an SQL `>` comparison on
-- the rendered preview (server) and a JS `>` comparison in the
-- editor (client), so a zero or negative value would either reject
-- every save or silently behave like "unlimited". Bound the column
-- to the same 1..10 range the editor offers; 10 segments is well
-- past anything a dispatch SMS should reasonably ship.
ALTER TABLE tenants
  ADD CONSTRAINT tenants_dispatch_sms_segment_limit_range
  CHECK (dispatch_sms_segment_limit IS NULL
         OR dispatch_sms_segment_limit BETWEEN 1 AND 10);
