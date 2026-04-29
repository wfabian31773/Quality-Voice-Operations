import { useEffect, useState } from 'react';
import {
  ensureGeocodeCacheHydrated,
  geocodeAddress,
  getCachedGeocode,
  haversineKm,
  type Coords,
} from '@/lib/maps';
import type { DispatchJob } from '@/lib/api';

export type JobDistanceMap = Map<string, number>;

export interface JobDistancesResult {
  distances: JobDistanceMap;
  isComputing: boolean;
}

function buildDistances(
  jobs: DispatchJob[],
  origin: Coords,
  coordsByAddress: Map<string, Coords>,
): JobDistanceMap {
  const next: JobDistanceMap = new Map();
  for (const job of jobs) {
    if (!job.address) continue;
    const dest = coordsByAddress.get(job.address);
    if (dest) {
      next.set(job.id, haversineKm(origin, dest));
    }
  }
  return next;
}

function distancesEqual(a: JobDistanceMap, b: JobDistanceMap): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || other !== value) return false;
  }
  return true;
}

export function useJobDistances(
  jobs: DispatchJob[],
  origin: Coords | null,
): JobDistancesResult {
  const [distances, setDistances] = useState<JobDistanceMap>(() => new Map());
  const [isComputing, setIsComputing] = useState(false);

  useEffect(() => {
    if (!origin) {
      setDistances((prev) => (prev.size === 0 ? prev : new Map()));
      setIsComputing(false);
      return;
    }

    let cancelled = false;
    const coordsByAddress = new Map<string, Coords>();
    const missing = new Set<string>();
    for (const job of jobs) {
      if (!job.address) continue;
      const cached = getCachedGeocode(job.address);
      if (cached) {
        coordsByAddress.set(job.address, cached);
      } else {
        missing.add(job.address);
      }
    }

    const apply = (map: Map<string, Coords>) => {
      const next = buildDistances(jobs, origin, map);
      setDistances((prev) => (distancesEqual(prev, next) ? prev : next));
    };

    apply(coordsByAddress);

    if (missing.size === 0) {
      setIsComputing(false);
      return () => {
        cancelled = true;
      };
    }

    setIsComputing(true);
    void (async () => {
      try {
        await ensureGeocodeCacheHydrated();
        if (cancelled) return;

        const stillMissing: string[] = [];
        for (const addr of missing) {
          const sync = getCachedGeocode(addr);
          if (sync) {
            coordsByAddress.set(addr, sync);
          } else {
            stillMissing.push(addr);
          }
        }
        apply(coordsByAddress);

        if (stillMissing.length === 0) return;

        const results = await Promise.all(
          stillMissing.map(async (addr) => ({
            addr,
            coords: await geocodeAddress(addr),
          })),
        );
        if (cancelled) return;

        let changed = false;
        for (const { addr, coords } of results) {
          if (coords) {
            coordsByAddress.set(addr, coords);
            changed = true;
          }
        }
        if (changed) apply(coordsByAddress);
      } finally {
        if (!cancelled) setIsComputing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobs, origin]);

  return { distances, isComputing };
}
