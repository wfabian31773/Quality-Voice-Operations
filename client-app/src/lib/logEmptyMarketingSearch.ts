/**
 * Lightweight, fire-and-forget client used by the marketing-page search
 * consumers (HelpWidget docs tab + public Resources page) to report
 * zero-hit queries to the backend.
 *
 * Goals:
 *   - Never block the search UI.
 *   - Never throw — telemetry failures stay silent.
 *   - Debounce per (source + locale) with **latest-query-wins** semantics:
 *     when a user types "p" → "pr" → "pre" → "prec" → "precios" inside one
 *     breath, only the final stabilized phrase ("precios") is logged.
 *     Intermediate prefixes never reach the server.
 *   - Suppress repeats of the same final phrase in the same locale within
 *     a 60 s cooldown, so re-clearing/retyping the same query doesn't
 *     spam the table.
 *   - Skip queries shorter than 2 characters — those are almost always
 *     in-progress typing and would dominate the table with noise.
 *
 * The endpoint contract lives in
 * `server/admin-api/routes/marketingSearchAnalytics.ts`.
 */

export type EmptyMarketingSearchSource = 'help_widget' | 'resources';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 800;
const RECENT_DEDUP_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

interface PendingEntry {
  timer: Timer;
  latest: LogEmptyMarketingSearchInput;
}

// Keyed by (source|locale) — only the most-recent input under a given
// (source, locale) survives, so a typing sequence collapses to one log.
const pendingTimers = new Map<string, PendingEntry>();

// Keyed by (source|locale|normalizedQuery) — prevents the *same* final
// phrase from being logged twice within the cooldown window.
const recentlySent = new Map<string, number>();

function pendingKey(source: string, locale: string): string {
  return `${source}|${locale}`;
}

function dedupKey(source: string, locale: string, normalized: string): string {
  return `${source}|${locale}|${normalized}`;
}

function normalize(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

function pruneRecentlySent(now: number): void {
  if (recentlySent.size < 256) return;
  for (const [key, ts] of recentlySent) {
    if (now - ts > RECENT_DEDUP_MS) recentlySent.delete(key);
  }
}

interface LogEmptyMarketingSearchInput {
  query: string;
  locale: string;
  source: EmptyMarketingSearchSource;
  pagePath?: string;
}

/**
 * Schedule a debounced log of a zero-hit marketing-page search.
 *
 * Safe to call on every keystroke — calls under the same (source, locale)
 * coalesce so only the *latest* query value gets logged once typing
 * settles for `DEBOUNCE_MS`. The same final phrase won't re-log within
 * `RECENT_DEDUP_MS`.
 */
export function logEmptyMarketingSearch(
  input: LogEmptyMarketingSearchInput,
): void {
  const normalized = normalize(input.query);
  if (normalized.length < MIN_QUERY_LENGTH) return;
  if (!input.locale) return;

  const key = pendingKey(input.source, input.locale);

  // Replace any in-flight timer for this (source, locale) — the latest
  // call wins, so partial prefixes typed during a single search session
  // never fire.
  const existing = pendingTimers.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    const entry = pendingTimers.get(key);
    pendingTimers.delete(key);
    const latest = entry?.latest ?? input;
    const finalNormalized = normalize(latest.query);
    if (finalNormalized.length < MIN_QUERY_LENGTH) return;

    const dKey = dedupKey(latest.source, latest.locale, finalNormalized);
    const now = Date.now();
    const lastSent = recentlySent.get(dKey);
    if (lastSent && now - lastSent < RECENT_DEDUP_MS) return;
    recentlySent.set(dKey, now);
    pruneRecentlySent(now);

    void sendLog({
      query: latest.query.trim().slice(0, 512),
      locale: latest.locale,
      source: latest.source,
      pagePath: latest.pagePath,
    });
  }, DEBOUNCE_MS);

  pendingTimers.set(key, { timer, latest: input });
}

async function sendLog({
  query,
  locale,
  source,
  pagePath,
}: LogEmptyMarketingSearchInput): Promise<void> {
  const payload = JSON.stringify({
    query,
    locale,
    source,
    page_path: pagePath ?? null,
  });

  try {
    // We don't use the `api` helper here because (1) we don't want this
    // request to ever inherit the auth-token side effects (the endpoint is
    // public) and (2) `keepalive` lets the request survive page navigation
    // — useful when the user clicks an external link right after typing.
    await fetch('/api/marketing/search/empty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      credentials: 'omit',
      keepalive: true,
    });
  } catch {
    // Telemetry failures are silent by design.
  }
}

/**
 * Test helper — clears in-memory debounce/dedup state so the unit suite
 * can run deterministic scenarios back to back.
 */
export function __resetEmptyMarketingSearchState(): void {
  for (const entry of pendingTimers.values()) clearTimeout(entry.timer);
  pendingTimers.clear();
  recentlySent.clear();
}
