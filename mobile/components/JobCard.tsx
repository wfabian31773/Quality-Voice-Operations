import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useTechnicianLocation } from '@/hooks/useTechnicianLocation';
import { StatusPill } from './StatusPill';
import type { DispatchJob } from '@/lib/api';
import { formatDateTime } from '@/lib/formatters';
import {
  estimateDriveMinutes,
  formatDistance,
  formatEta,
  geocodeAddress,
  haversineKm,
  type Coords,
} from '@/lib/maps';

interface JobCardProps {
  job: DispatchJob;
  onPress: () => void;
}

const PRIORITY_LABELS: Record<DispatchJob['priority'], string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export function JobCard({ job, onPress }: JobCardProps) {
  const colors = useColors();
  const { origin, status: locationStatus } = useTechnicianLocation();
  const [destination, setDestination] = useState<Coords | null>(null);
  const [geocoding, setGeocoding] = useState(false);

  const priorityFg =
    job.priority === 'urgent' || job.priority === 'high'
      ? colors.danger
      : colors.textMuted;

  useEffect(() => {
    let cancelled = false;
    if (!job.address) {
      setDestination(null);
      setGeocoding(false);
      return;
    }
    setGeocoding(true);
    void geocodeAddress(job.address).then((coords) => {
      if (cancelled) return;
      setDestination(coords);
      setGeocoding(false);
    });
    return () => {
      cancelled = true;
    };
  }, [job.address]);

  let proximityLabel: string | null = null;
  if (job.address && origin && destination) {
    const km = haversineKm(origin, destination);
    proximityLabel = `${formatEta(estimateDriveMinutes(km))} away · ${formatDistance(km)}`;
  } else if (
    job.address &&
    locationStatus === 'requesting' &&
    !origin
  ) {
    proximityLabel = 'Locating you…';
  } else if (job.address && geocoding && origin) {
    proximityLabel = 'Calculating distance…';
  }

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          opacity: pressed ? 0.92 : 1,
        },
      ]}
    >
      <View style={styles.header}>
        <StatusPill status={job.status} size="sm" />
        <Text
          style={[styles.priority, { color: priorityFg }]}
          numberOfLines={1}
        >
          {PRIORITY_LABELS[job.priority] ?? job.priority}
        </Text>
      </View>

      <Text
        style={[styles.title, { color: colors.text }]}
        numberOfLines={2}
      >
        {job.title}
      </Text>

      {job.contact_name ? (
        <View style={styles.row}>
          <Ionicons name="person-outline" size={14} color={colors.textMuted} />
          <Text
            style={[styles.rowText, { color: colors.textMuted }]}
            numberOfLines={1}
          >
            {job.contact_name}
          </Text>
        </View>
      ) : null}

      {job.address ? (
        <View style={styles.row}>
          <Ionicons name="location-outline" size={14} color={colors.textMuted} />
          <Text
            style={[styles.rowText, { color: colors.textMuted }]}
            numberOfLines={2}
          >
            {job.address}
          </Text>
        </View>
      ) : null}

      {proximityLabel ? (
        <View style={styles.row}>
          <Ionicons
            name="navigate-outline"
            size={14}
            color={colors.primary}
          />
          <Text
            style={[styles.proximityText, { color: colors.primary }]}
            numberOfLines={1}
          >
            {proximityLabel}
          </Text>
        </View>
      ) : null}

      <View style={styles.row}>
        <Ionicons name="time-outline" size={14} color={colors.textMuted} />
        <Text style={[styles.rowText, { color: colors.textMuted }]}>
          {formatDateTime(job.scheduled_at ?? job.eta_start ?? job.created_at)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  priority: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowText: {
    fontSize: 13,
    flexShrink: 1,
  },
  proximityText: {
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
  },
});
