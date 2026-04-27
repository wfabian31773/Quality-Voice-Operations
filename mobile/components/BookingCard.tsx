import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { StatusPill } from './StatusPill';
import type { SchedulingBooking } from '@/lib/api';
import { formatTimeRange } from '@/lib/formatters';

interface BookingCardProps {
  booking: SchedulingBooking;
  onPress: () => void;
}

export function BookingCard({ booking, onPress }: BookingCardProps) {
  const colors = useColors();
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
        <StatusPill status={booking.status} size="sm" />
        {booking.appointment_type_name ? (
          <Text
            style={[styles.type, { color: colors.textMuted }]}
            numberOfLines={1}
          >
            {booking.appointment_type_name}
          </Text>
        ) : null}
      </View>

      <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
        {booking.title}
      </Text>

      <View style={styles.row}>
        <Ionicons name="time-outline" size={14} color={colors.textMuted} />
        <Text
          style={[styles.rowText, { color: colors.textMuted }]}
          numberOfLines={1}
        >
          {formatTimeRange(booking.start_time, booking.end_time)}
        </Text>
      </View>

      {booking.contact_name ? (
        <View style={styles.row}>
          <Ionicons name="person-outline" size={14} color={colors.textMuted} />
          <Text
            style={[styles.rowText, { color: colors.textMuted }]}
            numberOfLines={1}
          >
            {booking.contact_name}
          </Text>
        </View>
      ) : null}

      {booking.location ? (
        <View style={styles.row}>
          <Ionicons name="location-outline" size={14} color={colors.textMuted} />
          <Text
            style={[styles.rowText, { color: colors.textMuted }]}
            numberOfLines={2}
          >
            {booking.location}
          </Text>
        </View>
      ) : null}
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
  type: {
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
});
