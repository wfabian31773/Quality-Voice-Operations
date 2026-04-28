// Unit tests for the minute-based replay helpers used by the dispatcher's
// "Route taken" tab. These prove the slider can land on *any minute*
// inside the window — not just minutes that happen to have a recorded
// ping — which was the original product requirement.

import { describe, it, expect } from 'vitest';
import {
  buildTimedPings,
  replayWindow,
  positionAt,
  positionAtMinute,
  type RoutePoint,
} from '../../client-app/src/lib/dispatchRouteReplay';

function p(iso: string, lat: number, lng: number, extras: Partial<RoutePoint> = {}): RoutePoint {
  return { recorded_at: iso, lat, lng, speed_mps: null, accuracy_m: null, heading_deg: null, ...extras };
}

describe('dispatchRouteReplay helpers', () => {
  describe('buildTimedPings', () => {
    it('drops pings without a recorded_at and sorts by ts ASC', () => {
      const pings = [
        p('2026-04-28T12:30:00Z', 1, 1),
        { lat: 9, lng: 9, recorded_at: null } as RoutePoint,
        p('2026-04-28T12:00:00Z', 0, 0),
        p('2026-04-28T13:00:00Z', 2, 2),
      ];
      const t = buildTimedPings(pings);
      expect(t).toHaveLength(3);
      expect(t.map((x) => x.ts)).toEqual([
        Date.parse('2026-04-28T12:00:00Z'),
        Date.parse('2026-04-28T12:30:00Z'),
        Date.parse('2026-04-28T13:00:00Z'),
      ]);
    });

    it('drops pings whose recorded_at fails to parse', () => {
      const pings = [
        p('not-a-date', 1, 1),
        p('2026-04-28T12:00:00Z', 0, 0),
      ];
      expect(buildTimedPings(pings)).toHaveLength(1);
    });
  });

  describe('replayWindow', () => {
    it('returns null when there are no pings', () => {
      expect(replayWindow([])).toBeNull();
    });

    it('computes minutes spanned, rounding up partial minutes', () => {
      const t = buildTimedPings([
        p('2026-04-28T12:00:00Z', 0, 0),
        p('2026-04-28T12:30:30Z', 1, 1), // 30m 30s span
      ]);
      const w = replayWindow(t)!;
      expect(w.startMs).toBe(Date.parse('2026-04-28T12:00:00Z'));
      expect(w.endMs).toBe(Date.parse('2026-04-28T12:30:30Z'));
      expect(w.minutes).toBe(31); // ceil(30.5)
    });

    it('returns minutes=0 for a single-ping window', () => {
      const t = buildTimedPings([p('2026-04-28T12:00:00Z', 0, 0)]);
      expect(replayWindow(t)!.minutes).toBe(0);
    });
  });

  describe('positionAt — exact / clamp behavior', () => {
    const pings = buildTimedPings([
      p('2026-04-28T12:00:00Z', 10, -80, { speed_mps: 5, accuracy_m: 12 }),
      p('2026-04-28T12:10:00Z', 11, -80, { speed_mps: 0, accuracy_m: 8 }),
    ]);

    it('returns exact when target matches a ping ts', () => {
      const r = positionAt(pings, Date.parse('2026-04-28T12:00:00Z'))!;
      expect(r.source).toBe('exact');
      expect(r.lat).toBe(10);
      expect(r.lng).toBe(-80);
    });

    it("clamps to the first ping with source='before' when target precedes window", () => {
      const r = positionAt(pings, Date.parse('2026-04-28T11:55:00Z'))!;
      expect(r.source).toBe('before');
      expect(r.lat).toBe(10);
      expect(r.ts).toBe(Date.parse('2026-04-28T12:00:00Z'));
    });

    it("clamps to the last ping with source='after' when target exceeds window", () => {
      const r = positionAt(pings, Date.parse('2026-04-28T12:30:00Z'))!;
      expect(r.source).toBe('after');
      expect(r.lat).toBe(11);
      expect(r.ts).toBe(Date.parse('2026-04-28T12:10:00Z'));
    });

    it('returns null on empty pings', () => {
      expect(positionAt([], 0)).toBeNull();
    });
  });

  describe('positionAt — minute-resolution scrub across SPARSE pings', () => {
    // Simulates a tech whose phone only managed 3 fixes during an
    // 18-minute job (5min then 13min gap) — the kind of sparse data
    // the slider has to interpolate through.
    const pings = buildTimedPings([
      p('2026-04-28T12:00:00Z', 30.0000, -97.0000, { speed_mps: 10, accuracy_m: 10 }),
      p('2026-04-28T12:05:00Z', 30.0500, -97.0500, { speed_mps: 12, accuracy_m: 14 }),
      p('2026-04-28T12:18:00Z', 30.1300, -97.1300, { speed_mps: 0, accuracy_m: 6 }),
    ]);

    it('produces a distinct interpolated position for EVERY minute in the window', () => {
      const w = replayWindow(pings)!;
      expect(w.minutes).toBe(18);

      const seen = new Set<string>();
      for (let m = 0; m <= w.minutes; m++) {
        const r = positionAtMinute(pings, m)!;
        expect(r).not.toBeNull();
        // Every minute from start to end should resolve to *some* coord —
        // either an exact ping or a between-ping interpolation. Nothing
        // should clamp 'before' or 'after' inside the window.
        expect(['exact', 'between']).toContain(r.source);
        seen.add(`${r.lat.toFixed(6)},${r.lng.toFixed(6)}`);
      }
      // 19 distinct minute slots; expect ~19 unique positions because
      // the path is monotonic. Sparse-ping interpolation must NOT collapse
      // multiple minutes to the same coord.
      expect(seen.size).toBeGreaterThanOrEqual(18);
    });

    it('interpolates lat/lng linearly between the two surrounding pings', () => {
      // Minute 2 of a 5-minute leg [12:00 → 12:05] is 40% of the way along.
      const r = positionAtMinute(pings, 2)!;
      expect(r.source).toBe('between');
      // 30.0 + 0.05 * (2/5) = 30.02
      expect(r.lat).toBeCloseTo(30.02, 5);
      expect(r.lng).toBeCloseTo(-97.02, 5);
      expect(r.ts).toBe(Date.parse('2026-04-28T12:02:00Z'));
    });

    it('interpolates correctly across a wide gap (minute 9 inside the 13-min gap)', () => {
      // Leg [12:05 → 12:18]: minute 9 of the window is 4 min into a 13-min leg.
      const r = positionAtMinute(pings, 9)!;
      expect(r.source).toBe('between');
      const frac = 4 / 13;
      const expectedLat = 30.05 + (30.13 - 30.05) * frac;
      const expectedLng = -97.05 + (-97.13 - -97.05) * frac;
      expect(r.lat).toBeCloseTo(expectedLat, 6);
      expect(r.lng).toBeCloseTo(expectedLng, 6);
      expect(r.ts).toBe(Date.parse('2026-04-28T12:09:00Z'));
    });

    it('returns exact at every recorded ping time', () => {
      const exact0 = positionAt(pings, Date.parse('2026-04-28T12:00:00Z'))!;
      const exact5 = positionAt(pings, Date.parse('2026-04-28T12:05:00Z'))!;
      const exact18 = positionAt(pings, Date.parse('2026-04-28T12:18:00Z'))!;
      expect(exact0.source).toBe('exact');
      expect(exact5.source).toBe('exact');
      expect(exact18.source).toBe('exact');
      expect(exact5.lat).toBe(30.05);
      expect(exact5.speed_mps).toBe(12); // exact => unmodified speed
    });

    it('interpolates speed when both neighbors have it', () => {
      // Halfway between 12:05 (speed 12) and 12:18 (speed 0): expect ~6.
      const r = positionAtMinute(pings, 5 + Math.round(13 / 2))!; // minute 12
      expect(r.source).toBe('between');
      const frac = (12 - 5) / 13;
      expect(r.speed_mps).toBeCloseTo(12 + (0 - 12) * frac, 5);
    });

    it("widens accuracy to the WORSE of the two neighbors (don't claim false confidence)", () => {
      // Between 12:00 (acc 10) and 12:05 (acc 14): interpolated acc must be 14.
      const r = positionAtMinute(pings, 2)!;
      expect(r.accuracy_m).toBe(14);
    });
  });

  describe('positionAtMinute — boundary behaviors', () => {
    it('minute=0 returns the first ping exactly', () => {
      const t = buildTimedPings([
        p('2026-04-28T12:00:00Z', 1, 1),
        p('2026-04-28T12:10:00Z', 2, 2),
      ]);
      const r = positionAtMinute(t, 0)!;
      expect(r.source).toBe('exact');
      expect(r.lat).toBe(1);
    });

    it("minute beyond window clamps to the last ping with source='after'", () => {
      const t = buildTimedPings([
        p('2026-04-28T12:00:00Z', 1, 1),
        p('2026-04-28T12:10:00Z', 2, 2),
      ]);
      const r = positionAtMinute(t, 999)!;
      expect(r.source).toBe('after');
      expect(r.lat).toBe(2);
    });

    it('handles single-ping window — every minute returns that one ping', () => {
      const t = buildTimedPings([p('2026-04-28T12:00:00Z', 5, 5)]);
      const r0 = positionAtMinute(t, 0)!;
      const r3 = positionAtMinute(t, 3)!;
      expect(r0.lat).toBe(5);
      expect(r0.source).toBe('exact');
      expect(r3.lat).toBe(5);
      expect(r3.source).toBe('after');
    });
  });
});
