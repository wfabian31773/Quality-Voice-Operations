-- Track marketing-page (HelpWidget + public Resources) search queries that
-- returned zero hits. The Help widget already speaks the user's language but
-- only returns matches against phrases that exist in
-- `client-app/src/locales/<locale>/marketing.json`. When users type a
-- translated phrase that isn't indexed (or that's in the wrong locale for the
-- target page) the search silently returns nothing — admins had no way to see
-- those gaps.
--
-- Schema is intentionally generic (`source` discriminator + free-form
-- `locale`) so the planned doc-search empty-query tracking can write into the
-- same table without another migration. See `task-1237.md` and the sibling
-- "Track which help searches return no results" task.

CREATE TABLE IF NOT EXISTS marketing_search_empty_queries (
  id BIGSERIAL PRIMARY KEY,
  -- Lower-cased, whitespace-collapsed query text used for grouping in the
  -- admin report. We keep `query_raw` separately so admins can see what
  -- the user actually typed.
  query_normalized TEXT NOT NULL,
  query_raw TEXT NOT NULL,
  -- BCP-47 locale tag at the time of the search (e.g. "en", "es", "pt-BR").
  -- Free-form because i18next ships a long tail of region tags.
  locale VARCHAR(16) NOT NULL,
  -- Which marketing search consumer fired the log.
  --   help_widget       — in-app HelpWidget docs tab
  --   resources         — public /resources page
  -- Future: doc-search consumers will reuse the same table with their own
  -- source values once the sibling task lands.
  source VARCHAR(32) NOT NULL,
  -- Page path the search was performed from (best-effort, used to
  -- disambiguate when the same translated phrase fails on different
  -- marketing pages).
  page_path TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT marketing_search_empty_queries_source_check
    CHECK (source IN ('help_widget', 'resources', 'docs_help_widget', 'docs_search')),
  CONSTRAINT marketing_search_empty_queries_query_normalized_len
    CHECK (char_length(query_normalized) BETWEEN 1 AND 256),
  CONSTRAINT marketing_search_empty_queries_query_raw_len
    CHECK (char_length(query_raw) BETWEEN 1 AND 512),
  CONSTRAINT marketing_search_empty_queries_locale_len
    CHECK (char_length(locale) BETWEEN 1 AND 16)
);

-- Aggregation index: the admin summary groups by (source, locale,
-- query_normalized) and orders by recent activity.
CREATE INDEX IF NOT EXISTS idx_marketing_search_empty_queries_group_recent
  ON marketing_search_empty_queries(source, locale, query_normalized, created_at DESC);

-- Time-window scans (last 30d) without a source filter.
CREATE INDEX IF NOT EXISTS idx_marketing_search_empty_queries_created
  ON marketing_search_empty_queries(created_at DESC);
