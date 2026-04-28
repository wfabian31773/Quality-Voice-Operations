// Helpers for replaying a technician's GPS breadcrumb on the dispatcher's
// "Route taken" tab. Kept as pure functions in their own module so they
// can be unit-tested in vitest without rendering the React component.
//
// The replay model is *minute-based*: dispatchers should be able to scrub
// to any minute between the first and last ping and see an interpolated
// position there, even when pings are sparse (e.g. 5–10 minute gaps when
// a tech parks and signal degrades).

export interface RoutePoint {
  lat: number;
  lng: number;
  recorded_at: string | null;
  speed_mps?: number | null;
  accuracy_m?: number | null;
  heading_deg?: number | null;
}

export interface TimedPing {
  ts: number; // unix ms
  lat: number;
  lng: number;
  speed_mps: number | null;
  accuracy_m: number | null;
}

export interface ReplayWindow {
  startMs: number;
  endMs: number;
  minutes: number; // total minutes spanned (>= 0)
}

export interface ReplayPosition {
  lat: number;
  lng: number;
  ts: number;
  speed_mps: number | null;
  accuracy_m: number | null;
  /**
   * 'exact'   — the requested time matched a recorded ping precisely.
   * 'between' — interpolated between two surrounding pings.
   * 'before'  — clamped to the first ping (request was earlier).
   * 'after'   — clamped to the last ping (request was later).
   */
  source: 'exact' | 'between' | 'before' | 'after';
}

/** Build a sorted, timestamped list of pings, dropping any without a usable timestamp. */
export function buildTimedPings(points: RoutePoint[]): TimedPing[] {
  const out: TimedPing[] = [];
  for (const p of points) {
    if (!p.recorded_at) continue;
    const ts = Date.parse(p.recorded_at);
    if (Number.isNaN(ts)) continue;
    out.push({
      ts,
      lat: p.lat,
      lng: p.lng,
      speed_mps: p.speed_mps ?? null,
      accuracy_m: p.accuracy_m ?? null,
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Compute the replay window. Returns null when there are no usable pings. */
export function replayWindow(timed: TimedPing[]): ReplayWindow | null {
  if (timed.length === 0) return null;
  const startMs = timed[0].ts;
  const endMs = timed[timed.length - 1].ts;
  const minutes = Math.max(0, Math.ceil((endMs - startMs) / 60000));
  return { startMs, endMs, minutes };
}

/**
 * Compute the technician's position at a given target timestamp.
 *
 *   * If the target falls between two pings, lat/lng are linearly
 *     interpolated by time fraction. Speed is interpolated; accuracy is
 *     widened to the worse of the two surrounding fixes (we can't be
 *     more confident than the worse neighbor).
 *   * If the target is before the first or after the last ping, the
 *     nearest endpoint is returned (clamped) with `source` set to
 *     `'before'` / `'after'` so the UI can hint at it.
 *
 * Returns null only when there are no pings at all.
 */
export function positionAt(timed: TimedPing[], targetMs: number): ReplayPosition | null {
  if (timed.length === 0) return null;

  const first = timed[0];
  const last = timed[timed.length - 1];

  if (targetMs <= first.ts) {
    return {
      lat: first.lat,
      lng: first.lng,
      ts: first.ts,
      speed_mps: first.speed_mps,
      accuracy_m: first.accuracy_m,
      source: targetMs === first.ts ? 'exact' : 'before',
    };
  }
  if (targetMs >= last.ts) {
    return {
      lat: last.lat,
      lng: last.lng,
      ts: last.ts,
      speed_mps: last.speed_mps,
      accuracy_m: last.accuracy_m,
      source: targetMs === last.ts ? 'exact' : 'after',
    };
  }

  // Binary search for the surrounding pings: timed[lo].ts <= target < timed[hi].ts.
  let lo = 0;
  let hi = timed.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (timed[mid].ts <= targetMs) lo = mid;
    else hi = mid;
  }
  const a = timed[lo];
  const b = timed[hi];
  if (a.ts === targetMs) {
    return { lat: a.lat, lng: a.lng, ts: a.ts, speed_mps: a.speed_mps, accuracy_m: a.accuracy_m, source: 'exact' };
  }
  if (b.ts === targetMs) {
    return { lat: b.lat, lng: b.lng, ts: b.ts, speed_mps: b.speed_mps, accuracy_m: b.accuracy_m, source: 'exact' };
  }
  const span = b.ts - a.ts;
  const frac = span > 0 ? (targetMs - a.ts) / span : 0;
  const interpSpeed =
    a.speed_mps != null && b.speed_mps != null
      ? a.speed_mps + (b.speed_mps - a.speed_mps) * frac
      : (a.speed_mps ?? b.speed_mps ?? null);
  const interpAcc =
    a.accuracy_m != null && b.accuracy_m != null
      ? Math.max(a.accuracy_m, b.accuracy_m)
      : (a.accuracy_m ?? b.accuracy_m ?? null);
  return {
    lat: a.lat + (b.lat - a.lat) * frac,
    lng: a.lng + (b.lng - a.lng) * frac,
    ts: targetMs,
    speed_mps: interpSpeed,
    accuracy_m: interpAcc,
    source: 'between',
  };
}

/** Convenience: position at minute `m` after the window start. */
export function positionAtMinute(timed: TimedPing[], minute: number): ReplayPosition | null {
  if (timed.length === 0) return null;
  const startMs = timed[0].ts;
  return positionAt(timed, startMs + Math.max(0, minute) * 60_000);
}
