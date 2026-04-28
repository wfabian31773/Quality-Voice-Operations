// Unit tests for the dispatcher routing-provider adapter that powers
// the live-map ETA enrichment and customer-facing notification
// substitution.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  __resetRoutingCachesForTests,
  geocodeAddressCached,
  getDriveEta,
  haversineEta,
  haversineMeters,
  getConfiguredRoutingProvider,
} from '../../platform/integrations/routing';
import {
  googleEta,
  mapboxEta,
  osrmEta,
} from '../../platform/integrations/routing/providers';
import {
  geocodeAddress,
  googleGeocode,
  mapboxGeocode,
  nominatimGeocode,
} from '../../platform/integrations/routing/geocoder';

const SF: { lat: number; lon: number } = { lat: 37.7749, lon: -122.4194 };
const SJ: { lat: number; lon: number } = { lat: 37.3382, lon: -121.8863 };

beforeEach(() => {
  __resetRoutingCachesForTests();
  delete process.env.DISPATCH_ROUTING_PROVIDER;
  delete process.env.MAPBOX_ACCESS_TOKEN;
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.DISPATCH_GEOCODE_PROVIDER;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('haversine distance & ETA', () => {
  it('measures roughly the SF→SJ great-circle distance (~67 km)', () => {
    const m = haversineMeters(SF, SJ);
    expect(m).toBeGreaterThan(60_000);
    expect(m).toBeLessThan(75_000);
  });

  it('returns zero for identical points', () => {
    const eta = haversineEta(SF, SF);
    expect(eta.durationSeconds).toBe(0);
    expect(eta.distanceMeters).toBe(0);
    expect(eta.provider).toBe('haversine');
  });

  it('produces a sane ETA for SF→SJ (~50–110 minutes urban estimate)', () => {
    const eta = haversineEta(SF, SJ);
    const minutes = eta.durationSeconds / 60;
    expect(minutes).toBeGreaterThan(50);
    expect(minutes).toBeLessThan(120);
  });
});

describe('OSRM provider', () => {
  it('parses the public OSRM JSON shape into a DriveEta', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          code: 'Ok',
          routes: [{ duration: 1800, distance: 25_000 }],
        };
      },
      async text() { return ''; },
    }));
    const eta = await osrmEta(SF, SJ, { baseUrl: 'http://test', fetchImpl: fetchMock as never });
    expect(eta.durationSeconds).toBe(1800);
    expect(eta.distanceMeters).toBe(25_000);
    expect(eta.provider).toBe('osrm');
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as string;
    // OSRM expects lon,lat order
    expect(url).toContain(`${SF.lon},${SF.lat};${SJ.lon},${SJ.lat}`);
  });

  it('throws when OSRM returns a non-Ok code', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() { return { code: 'NoRoute' }; },
      async text() { return ''; },
    }));
    await expect(osrmEta(SF, SJ, { baseUrl: 'http://x', fetchImpl: fetchMock as never })).rejects.toThrow(/NoRoute/);
  });
});

describe('Mapbox provider', () => {
  it('requires an access token', async () => {
    await expect(mapboxEta(SF, SJ)).rejects.toThrow(/MAPBOX_ACCESS_TOKEN/);
  });

  it('parses the directions response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { code: 'Ok', routes: [{ duration: 600, distance: 9_000 }] };
      },
      async text() { return ''; },
    }));
    const eta = await mapboxEta(SF, SJ, { token: 'pk.test', fetchImpl: fetchMock as never });
    expect(eta.durationSeconds).toBe(600);
    expect(eta.distanceMeters).toBe(9_000);
    expect(eta.provider).toBe('mapbox');
    expect((fetchMock.mock.calls[0][0] as string)).toContain('access_token=pk.test');
  });
});

describe('Google provider', () => {
  it('requires an API key', async () => {
    await expect(googleEta(SF, SJ)).rejects.toThrow(/GOOGLE_MAPS_API_KEY/);
  });

  it('extracts the first row/element duration', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'OK',
          rows: [{ elements: [{ status: 'OK', duration: { value: 720 }, distance: { value: 12_345 } }] }],
        };
      },
      async text() { return ''; },
    }));
    const eta = await googleEta(SF, SJ, { apiKey: 'key', fetchImpl: fetchMock as never });
    expect(eta.durationSeconds).toBe(720);
    expect(eta.distanceMeters).toBe(12_345);
    expect(eta.provider).toBe('google');
  });

  it('throws when the element status is not OK', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'OK',
          rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }],
        };
      },
      async text() { return ''; },
    }));
    await expect(googleEta(SF, SJ, { apiKey: 'key', fetchImpl: fetchMock as never }))
      .rejects.toThrow(/ZERO_RESULTS/);
  });
});

describe('getDriveEta cache & fallback', () => {
  it('serves a second call from the per-tenant cache', async () => {
    process.env.DISPATCH_ROUTING_PROVIDER = 'haversine';
    const a = await getDriveEta({ tenantId: 't', resourceId: 'r', jobId: 'j', origin: SF, destination: SJ });
    const b = await getDriveEta({ tenantId: 't', resourceId: 'r', jobId: 'j', origin: SF, destination: SJ });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.durationSeconds).toBe(a.durationSeconds);
  });

  it('keys the cache per (tenant, resource, job) so different jobs do not collide', async () => {
    process.env.DISPATCH_ROUTING_PROVIDER = 'haversine';
    const a = await getDriveEta({ tenantId: 't', resourceId: 'r', jobId: 'j1', origin: SF, destination: SJ });
    const b = await getDriveEta({ tenantId: 't', resourceId: 'r', jobId: 'j2', origin: SF, destination: SJ });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
  });

  it('falls back to haversine when the configured provider throws', async () => {
    process.env.DISPATCH_ROUTING_PROVIDER = 'osrm';
    const fetchMock = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', fetchMock);
    const result = await getDriveEta({
      tenantId: 't', resourceId: 'r', jobId: 'j', origin: SF, destination: SJ,
    });
    expect(result.provider).toBe('haversine');
    expect(result.fallback).toBe(true);
    expect(result.durationSeconds).toBeGreaterThan(0);
  });

  it('does not mark haversine as a fallback when it is the configured provider', async () => {
    process.env.DISPATCH_ROUTING_PROVIDER = 'haversine';
    const result = await getDriveEta({
      tenantId: 't', resourceId: 'r', jobId: 'j', origin: SF, destination: SJ,
    });
    expect(result.provider).toBe('haversine');
    expect(result.fallback).toBe(false);
  });
});

describe('getConfiguredRoutingProvider', () => {
  it('defaults to haversine when env is unset', () => {
    expect(getConfiguredRoutingProvider()).toBe('haversine');
  });

  it.each(['osrm', 'mapbox', 'google', 'haversine'] as const)('honors %s', (p) => {
    process.env.DISPATCH_ROUTING_PROVIDER = p;
    expect(getConfiguredRoutingProvider()).toBe(p);
  });

  it('falls back to haversine for an unknown value', () => {
    process.env.DISPATCH_ROUTING_PROVIDER = 'mystery';
    expect(getConfiguredRoutingProvider()).toBe('haversine');
  });
});

describe('geocoders', () => {
  it('nominatim returns the first result lat/lon', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() { return [{ lat: '37.7749', lon: '-122.4194' }]; },
      async text() { return ''; },
    }));
    const point = await nominatimGeocode('San Francisco, CA', {
      baseUrl: 'http://x', userAgent: 'test/1.0', fetchImpl: fetchMock as never,
    });
    expect(point).toEqual({ lat: 37.7749, lon: -122.4194 });
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['User-Agent']).toBe('test/1.0');
  });

  it('nominatim returns null for an empty result set', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() { return []; },
      async text() { return ''; },
    }));
    const point = await nominatimGeocode('nowhere', {
      baseUrl: 'http://x', fetchImpl: fetchMock as never,
    });
    expect(point).toBeNull();
  });

  it('mapbox geocoder maps center [lon, lat] -> {lat, lon}', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() { return { features: [{ center: [-122.4, 37.8] }] }; },
      async text() { return ''; },
    }));
    const point = await mapboxGeocode('SF', { token: 'pk', fetchImpl: fetchMock as never });
    expect(point).toEqual({ lat: 37.8, lon: -122.4 });
  });

  it('google geocoder reads geometry.location', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 2 } } }] };
      },
      async text() { return ''; },
    }));
    const point = await googleGeocode('SF', { apiKey: 'k', fetchImpl: fetchMock as never });
    expect(point).toEqual({ lat: 1, lon: 2 });
  });

  it('geocodeAddress("none") short-circuits to null without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const point = await geocodeAddress('123 Main', 'none');
    expect(point).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('geocodeAddressCached', () => {
  it('caches results within TTL — provider only called once per address', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() { return [{ lat: '10', lon: '20' }]; },
      async text() { return ''; },
    }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.DISPATCH_GEOCODE_PROVIDER = 'nominatim';
    const a = await geocodeAddressCached('tenant-1', '500 Folsom St');
    const b = await geocodeAddressCached('tenant-1', '500 Folsom St');
    expect(a).toEqual({ lat: 10, lon: 20 });
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('negatively caches a thrown geocoder so a downed provider does not get hammered', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('boom'); });
    vi.stubGlobal('fetch', fetchMock);
    process.env.DISPATCH_GEOCODE_PROVIDER = 'nominatim';
    const a = await geocodeAddressCached('tenant-1', 'Mystery Address');
    const b = await geocodeAddressCached('tenant-1', 'Mystery Address');
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null instantly for a blank address (no provider call)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const point = await geocodeAddressCached('t', '   ');
    expect(point).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
