import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import {
  estimateDriveMinutes,
  formatDistance,
  formatEta,
  haversineKm,
  openDirections,
} from '@/lib/maps';

interface JobMapPreviewProps {
  address: string;
}

interface Coords {
  latitude: number;
  longitude: number;
}

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

type MapsModule = typeof import('react-native-maps');
type LocationModuleType = typeof import('expo-location');

let MapsModuleRef: MapsModule | null = null;
let LocationModule: LocationModuleType | null = null;

if (isNative) {
  try {
    MapsModuleRef = require('react-native-maps') as MapsModule;
  } catch {
    MapsModuleRef = null;
  }
  try {
    LocationModule = require('expo-location') as LocationModuleType;
  } catch {
    LocationModule = null;
  }
}

export function JobMapPreview({ address }: JobMapPreviewProps) {
  const colors = useColors();
  const [destination, setDestination] = useState<Coords | null>(null);
  const [origin, setOrigin] = useState<Coords | null>(null);
  const [geocodeError, setGeocodeError] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(true);
  const [isLocating, setIsLocating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsResolving(true);
    setGeocodeError(null);
    setDestination(null);

    if (!isNative || !LocationModule) {
      setIsResolving(false);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const results = await LocationModule!.geocodeAsync(address);
        if (cancelled) return;
        const first = results[0];
        if (!first) {
          setGeocodeError("We couldn't locate this address on the map.");
        } else {
          setDestination({
            latitude: first.latitude,
            longitude: first.longitude,
          });
        }
      } catch {
        if (!cancelled) {
          setGeocodeError("We couldn't locate this address on the map.");
        }
      } finally {
        if (!cancelled) setIsResolving(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    let cancelled = false;
    if (!destination || !isNative || !LocationModule) return;

    setIsLocating(true);
    setLocationError(null);

    (async () => {
      try {
        const { status } =
          await LocationModule!.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (status !== 'granted') {
          setLocationError(
            'Enable location access to see your distance and ETA to the job.',
          );
          return;
        }
        const position = await LocationModule!.getCurrentPositionAsync({
          accuracy: LocationModule!.Accuracy.Balanced,
        });
        if (cancelled) return;
        setOrigin({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      } catch {
        if (!cancelled) {
          setLocationError(
            "We couldn't read your current location. Check your device settings and try again.",
          );
        }
      } finally {
        if (!cancelled) setIsLocating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [destination]);

  const handleOpenDirections = () => {
    void openDirections(address);
  };

  if (!isNative) {
    return (
      <Pressable
        onPress={handleOpenDirections}
        style={({ pressed }) => [
          styles.webCard,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Ionicons name="navigate-outline" size={18} color={colors.primary} />
        <Text style={[styles.webText, { color: colors.text }]}>
          Open directions to {address}
        </Text>
      </Pressable>
    );
  }

  const Map = MapsModuleRef?.default;
  const Marker = MapsModuleRef?.Marker;

  let distanceKm: number | null = null;
  let etaMinutes: number | null = null;
  if (origin && destination) {
    distanceKm = haversineKm(origin, destination);
    etaMinutes = estimateDriveMinutes(distanceKm);
  }

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.textMuted }]}>
            Directions
          </Text>
          <Text style={[styles.address, { color: colors.text }]}>
            {address}
          </Text>
        </View>
        <Pressable
          onPress={handleOpenDirections}
          accessibilityRole="button"
          accessibilityLabel="Open directions in maps"
          style={({ pressed }) => [
            styles.directionsBtn,
            {
              backgroundColor: colors.primary,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Ionicons name="navigate" size={16} color="#fff" />
          <Text style={styles.directionsText}>Directions</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={handleOpenDirections}
        accessibilityRole="button"
        accessibilityLabel="Open map for directions"
        style={[styles.mapShell, { backgroundColor: colors.surfaceMuted }]}
      >
        {isResolving ? (
          <View style={styles.mapPlaceholder}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.placeholderText, { color: colors.textMuted }]}>
              Locating address…
            </Text>
          </View>
        ) : geocodeError || !destination || !Map || !Marker ? (
          <View style={styles.mapPlaceholder}>
            <Ionicons
              name="map-outline"
              size={28}
              color={colors.textMuted}
            />
            <Text style={[styles.placeholderText, { color: colors.textMuted }]}>
              {geocodeError ?? 'Map preview unavailable.'}
            </Text>
            <Text style={[styles.placeholderHint, { color: colors.textMuted }]}>
              Tap “Directions” to navigate.
            </Text>
          </View>
        ) : (
          <Map
            style={styles.map}
            pointerEvents="none"
            initialRegion={regionFor(destination, origin)}
            region={regionFor(destination, origin)}
            showsUserLocation={Boolean(origin)}
            showsMyLocationButton={false}
            showsCompass={false}
            showsScale={false}
            toolbarEnabled={false}
            loadingEnabled
          >
            <Marker
              coordinate={destination}
              title="Job location"
              description={address}
              pinColor={colors.primary}
            />
          </Map>
        )}
      </Pressable>

      <View style={styles.metricsRow}>
        <View style={styles.metric}>
          <Ionicons
            name="speedometer-outline"
            size={16}
            color={colors.textMuted}
          />
          <Text style={[styles.metricLabel, { color: colors.textMuted }]}>
            ETA
          </Text>
          <Text style={[styles.metricValue, { color: colors.text }]}>
            {isLocating
              ? 'Calculating…'
              : etaMinutes != null
                ? formatEta(etaMinutes)
                : '—'}
          </Text>
        </View>
        <View style={styles.metric}>
          <Ionicons name="trail-sign-outline" size={16} color={colors.textMuted} />
          <Text style={[styles.metricLabel, { color: colors.textMuted }]}>
            Distance
          </Text>
          <Text style={[styles.metricValue, { color: colors.text }]}>
            {distanceKm != null ? formatDistance(distanceKm) : '—'}
          </Text>
        </View>
      </View>

      {locationError ? (
        <Text style={[styles.note, { color: colors.textMuted }]}>
          {locationError}
        </Text>
      ) : !origin && !isLocating && destination ? (
        <Text style={[styles.note, { color: colors.textMuted }]}>
          ETA appears once your location is available.
        </Text>
      ) : etaMinutes != null ? (
        <Text style={[styles.note, { color: colors.textMuted }]}>
          Estimated from straight-line distance — open directions for a
          traffic-aware ETA.
        </Text>
      ) : null}
    </View>
  );
}

function regionFor(
  destination: Coords,
  origin: Coords | null,
): {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
} {
  if (!origin) {
    return {
      latitude: destination.latitude,
      longitude: destination.longitude,
      latitudeDelta: 0.04,
      longitudeDelta: 0.04,
    };
  }
  const midLat = (origin.latitude + destination.latitude) / 2;
  const midLon = (origin.longitude + destination.longitude) / 2;
  const latDelta =
    Math.abs(origin.latitude - destination.latitude) * 2.2 + 0.02;
  const lonDelta =
    Math.abs(origin.longitude - destination.longitude) * 2.2 + 0.02;
  return {
    latitude: midLat,
    longitude: midLon,
    latitudeDelta: Math.max(latDelta, 0.02),
    longitudeDelta: Math.max(lonDelta, 0.02),
  };
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  address: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
  directionsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  directionsText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
  mapShell: {
    height: 180,
    borderRadius: 12,
    overflow: 'hidden',
  },
  map: {
    flex: 1,
  },
  mapPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 12,
  },
  placeholderText: {
    fontSize: 13,
    textAlign: 'center',
  },
  placeholderHint: {
    fontSize: 12,
    textAlign: 'center',
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  metric: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metricLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  metricValue: {
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 'auto',
  },
  note: {
    fontSize: 12,
    lineHeight: 16,
  },
  webCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
  },
  webText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
});
