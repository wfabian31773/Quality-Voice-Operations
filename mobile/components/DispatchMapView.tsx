import { useEffect, useMemo, useRef } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { JobCoordsMap, JobDistanceMap } from '@/hooks/useJobDistances';
import type { DispatchJob } from '@/lib/api';
import {
  estimateDriveMinutes,
  formatDistance,
  formatEta,
  type Coords,
} from '@/lib/maps';

interface DispatchMapViewProps {
  jobs: DispatchJob[];
  coordinates: JobCoordsMap;
  distances: JobDistanceMap;
  origin: Coords | null;
  isResolvingCoords: boolean;
  locationUnavailable: boolean;
  isLocating: boolean;
  onSelectJob: (jobId: string) => void;
}

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

type MapsModule = typeof import('react-native-maps');

let MapsModuleRef: MapsModule | null = null;

if (isNative) {
  try {
    MapsModuleRef = require('react-native-maps') as MapsModule;
  } catch {
    MapsModuleRef = null;
  }
}

interface PinnedJob {
  job: DispatchJob;
  coords: Coords;
  distanceKm: number | null;
  etaMinutes: number | null;
  proximityLabel: string | null;
}

function buildProximityLabel(
  distanceKm: number | null,
  etaMinutes: number | null,
): string | null {
  if (distanceKm == null || etaMinutes == null) return null;
  return `${formatEta(etaMinutes)} away · ${formatDistance(distanceKm)}`;
}

export function DispatchMapView({
  jobs,
  coordinates,
  distances,
  origin,
  isResolvingCoords,
  locationUnavailable,
  isLocating,
  onSelectJob,
}: DispatchMapViewProps) {
  const colors = useColors();

  const pinnedJobs = useMemo<PinnedJob[]>(() => {
    const out: PinnedJob[] = [];
    for (const job of jobs) {
      const coords = coordinates.get(job.id);
      if (!coords) continue;
      const distanceKm = distances.get(job.id) ?? null;
      const etaMinutes =
        distanceKm != null ? estimateDriveMinutes(distanceKm) : null;
      out.push({
        job,
        coords,
        distanceKm,
        etaMinutes,
        proximityLabel: buildProximityLabel(distanceKm, etaMinutes),
      });
    }
    return out;
  }, [jobs, coordinates, distances]);

  const Map = MapsModuleRef?.default;
  const Marker = MapsModuleRef?.Marker;
  const Callout = MapsModuleRef?.Callout;
  const mapRef = useRef<InstanceType<NonNullable<typeof Map>> | null>(null);

  const initialRegion = useMemo(
    () => regionFor(pinnedJobs, origin),
    // initialRegion is only used on first render; stable reference is fine
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!Map || !mapRef.current) return;
    if (pinnedJobs.length === 0 && !origin) return;
    const points: Coords[] = pinnedJobs.map((p) => p.coords);
    if (origin) points.push(origin);
    if (points.length === 0) return;
    if (points.length === 1) {
      const only = points[0];
      mapRef.current.animateToRegion(
        {
          latitude: only.latitude,
          longitude: only.longitude,
          latitudeDelta: 0.04,
          longitudeDelta: 0.04,
        },
        300,
      );
      return;
    }
    mapRef.current.fitToCoordinates(points, {
      edgePadding: { top: 80, right: 60, bottom: 120, left: 60 },
      animated: true,
    });
  }, [pinnedJobs, origin, Map]);

  if (!isNative) {
    return (
      <View
        style={[
          styles.fallbackCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Ionicons name="map-outline" size={28} color={colors.textMuted} />
        <Text style={[styles.fallbackTitle, { color: colors.text }]}>
          Map view is available in the mobile app
        </Text>
        <Text style={[styles.fallbackBody, { color: colors.textMuted }]}>
          Switch back to the list to see distance and ETA for every job.
        </Text>
      </View>
    );
  }

  if (!Map || !Marker) {
    return (
      <View
        style={[
          styles.fallbackCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Ionicons name="map-outline" size={28} color={colors.textMuted} />
        <Text style={[styles.fallbackTitle, { color: colors.text }]}>
          Map preview unavailable
        </Text>
        <Text style={[styles.fallbackBody, { color: colors.textMuted }]}>
          Switch back to the list view to see your jobs.
        </Text>
      </View>
    );
  }

  const banner = pickBanner({
    locationUnavailable,
    isLocating,
    isResolvingCoords,
    pinnedCount: pinnedJobs.length,
    jobCount: jobs.filter((j) => j.address).length,
    hasOrigin: Boolean(origin),
  });

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.mapShell,
          { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
        ]}
      >
        <Map
          ref={(instance) => {
            mapRef.current = instance;
          }}
          style={styles.map}
          initialRegion={initialRegion}
          showsUserLocation={Boolean(origin)}
          showsMyLocationButton={false}
          showsCompass={false}
          showsScale={false}
          toolbarEnabled={false}
          loadingEnabled
        >
          {pinnedJobs.map(({ job, coords, proximityLabel }) => {
            const description =
              proximityLabel ??
              (locationUnavailable
                ? 'Distance unavailable — turn on location'
                : isLocating
                  ? 'Locating you…'
                  : (job.address ?? ''));
            return (
              <Marker
                key={job.id}
                coordinate={coords}
                pinColor={colors.primary}
                title={job.title}
                description={description}
                onCalloutPress={() => onSelectJob(job.id)}
              >
                {Callout ? (
                  <Callout
                    tooltip={false}
                    onPress={() => onSelectJob(job.id)}
                  >
                    <View style={styles.callout}>
                      <Text style={styles.calloutTitle} numberOfLines={2}>
                        {job.title}
                      </Text>
                      {proximityLabel ? (
                        <View style={styles.calloutRow}>
                          <Ionicons
                            name="navigate-outline"
                            size={12}
                            color="#1d4ed8"
                          />
                          <Text style={styles.calloutProximity}>
                            {proximityLabel}
                          </Text>
                        </View>
                      ) : (
                        <Text style={styles.calloutProximityMuted}>
                          {description}
                        </Text>
                      )}
                      {job.address ? (
                        <Text
                          style={styles.calloutAddress}
                          numberOfLines={2}
                        >
                          {job.address}
                        </Text>
                      ) : null}
                      <Text style={styles.calloutHint}>Tap to open job</Text>
                    </View>
                  </Callout>
                ) : null}
              </Marker>
            );
          })}
        </Map>

        {pinnedJobs.length === 0 && !isResolvingCoords ? (
          <View pointerEvents="none" style={styles.emptyOverlay}>
            <View
              style={[
                styles.emptyPill,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                },
              ]}
            >
              <Ionicons
                name="location-outline"
                size={16}
                color={colors.textMuted}
              />
              <Text style={[styles.emptyText, { color: colors.text }]}>
                No job addresses to plot yet.
              </Text>
            </View>
          </View>
        ) : null}
      </View>

      {banner ? (
        <View
          style={[
            styles.banner,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <Ionicons
            name={banner.icon}
            size={14}
            color={colors.textMuted}
          />
          <Text style={[styles.bannerText, { color: colors.textMuted }]}>
            {banner.text}
          </Text>
        </View>
      ) : null}

      <Pressable
        onPress={() => {
          if (!mapRef.current) return;
          if (pinnedJobs.length === 0 && !origin) return;
          const points: Coords[] = pinnedJobs.map((p) => p.coords);
          if (origin) points.push(origin);
          if (points.length === 1) {
            const only = points[0];
            mapRef.current.animateToRegion(
              {
                latitude: only.latitude,
                longitude: only.longitude,
                latitudeDelta: 0.04,
                longitudeDelta: 0.04,
              },
              300,
            );
            return;
          }
          mapRef.current.fitToCoordinates(points, {
            edgePadding: { top: 80, right: 60, bottom: 120, left: 60 },
            animated: true,
          });
        }}
        accessibilityRole="button"
        accessibilityLabel="Re-center map"
        style={({ pressed }) => [
          styles.recenterBtn,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Ionicons name="locate-outline" size={18} color={colors.text} />
      </Pressable>
    </View>
  );
}

interface BannerInput {
  locationUnavailable: boolean;
  isLocating: boolean;
  isResolvingCoords: boolean;
  pinnedCount: number;
  jobCount: number;
  hasOrigin: boolean;
}

function pickBanner(
  input: BannerInput,
): { icon: keyof typeof Ionicons.glyphMap; text: string } | null {
  if (input.locationUnavailable) {
    return {
      icon: 'location-outline',
      text: 'Location is off — pins are shown without distance or ETA.',
    };
  }
  if (input.isLocating && !input.hasOrigin) {
    return {
      icon: 'compass-outline',
      text: 'Locating you — distance and ETA will appear shortly.',
    };
  }
  if (input.isResolvingCoords && input.pinnedCount < input.jobCount) {
    return {
      icon: 'sync-outline',
      text: 'Resolving job addresses…',
    };
  }
  if (
    !input.isResolvingCoords &&
    input.jobCount > 0 &&
    input.pinnedCount === 0
  ) {
    return {
      icon: 'alert-circle-outline',
      text: "We couldn't resolve any job addresses to map pins.",
    };
  }
  if (input.jobCount > input.pinnedCount && input.pinnedCount > 0) {
    const missing = input.jobCount - input.pinnedCount;
    return {
      icon: 'information-circle-outline',
      text: `${missing} job${missing === 1 ? '' : 's'} couldn't be placed on the map.`,
    };
  }
  return null;
}

function regionFor(
  pinnedJobs: PinnedJob[],
  origin: Coords | null,
): {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
} {
  const points: Coords[] = pinnedJobs.map((p) => p.coords);
  if (origin) points.push(origin);
  if (points.length === 0) {
    return {
      latitude: 39.5,
      longitude: -98.35,
      latitudeDelta: 40,
      longitudeDelta: 60,
    };
  }
  if (points.length === 1) {
    const only = points[0];
    return {
      latitude: only.latitude,
      longitude: only.longitude,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    };
  }
  let minLat = points[0].latitude;
  let maxLat = points[0].latitude;
  let minLon = points[0].longitude;
  let maxLon = points[0].longitude;
  for (const p of points) {
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLon) minLon = p.longitude;
    if (p.longitude > maxLon) maxLon = p.longitude;
  }
  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  const latDelta = Math.max((maxLat - minLat) * 1.6, 0.04);
  const lonDelta = Math.max((maxLon - minLon) * 1.6, 0.04);
  return {
    latitude: midLat,
    longitude: midLon,
    latitudeDelta: latDelta,
    longitudeDelta: lonDelta,
  };
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    paddingTop: 4,
    gap: 8,
  },
  mapShell: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  map: {
    flex: 1,
  },
  emptyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  emptyText: {
    fontSize: 13,
    fontWeight: '600',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  bannerText: {
    fontSize: 12,
    flex: 1,
  },
  recenterBtn: {
    position: 'absolute',
    bottom: 28,
    right: 28,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callout: {
    minWidth: 200,
    maxWidth: 240,
    paddingVertical: 6,
    paddingHorizontal: 4,
    gap: 4,
  },
  calloutTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  calloutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  calloutProximity: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1d4ed8',
  },
  calloutProximityMuted: {
    fontSize: 12,
    color: '#475569',
  },
  calloutAddress: {
    fontSize: 12,
    color: '#475569',
  },
  calloutHint: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  fallbackCard: {
    margin: 16,
    marginTop: 4,
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    gap: 8,
  },
  fallbackTitle: {
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  fallbackBody: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
});
