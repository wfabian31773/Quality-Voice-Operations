import { useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/hooks/useAuth';
import { api, type SchedulingBooking } from '@/lib/api';
import { BookingCard } from '@/components/BookingCard';
import { EmptyState } from '@/components/EmptyState';

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfNextWeek(): Date {
  const d = startOfToday();
  d.setDate(d.getDate() + 7);
  d.setHours(23, 59, 59, 999);
  return d;
}

function dayKey(input: string): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return 'Other';
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

interface Section {
  key: string;
  bookings: SchedulingBooking[];
}

export default function ScheduleScreen() {
  const colors = useColors();
  const router = useRouter();
  const { client, resourceId } = useAuth();

  const range = useMemo(
    () => ({
      start: startOfToday().toISOString(),
      end: endOfNextWeek().toISOString(),
    }),
    [],
  );

  const query = useQuery({
    queryKey: ['bookings', resourceId, range.start, range.end],
    enabled: client !== null,
    queryFn: () =>
      api.listBookings(client!, {
        start: range.start,
        end: range.end,
        resourceId,
      }),
  });

  useFocusEffect(
    useCallback(() => {
      query.refetch();
    }, [query]),
  );

  const sections: Section[] = useMemo(() => {
    const list = query.data?.bookings ?? [];
    const sorted = [...list].sort(
      (a, b) =>
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );
    const map = new Map<string, SchedulingBooking[]>();
    for (const b of sorted) {
      const key = dayKey(b.start_time);
      const existing = map.get(key) ?? [];
      existing.push(b);
      map.set(key, existing);
    }
    return Array.from(map.entries()).map(([key, bookings]) => ({
      key,
      bookings,
    }));
  }, [query.data]);

  if (query.isLoading) {
    return (
      <View
        style={[
          styles.center,
          { backgroundColor: colors.background },
        ]}
      >
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (query.isError) {
    return (
      <View style={[styles.flex, { backgroundColor: colors.background }]}>
        <EmptyState
          title="Could not load schedule"
          description={
            query.error instanceof Error
              ? query.error.message
              : 'Pull down to retry.'
          }
        />
      </View>
    );
  }

  return (
    <FlatList
      style={[styles.flex, { backgroundColor: colors.background }]}
      data={sections}
      keyExtractor={(s) => s.key}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching}
          onRefresh={() => query.refetch()}
          tintColor={colors.primary}
        />
      }
      ListEmptyComponent={
        <EmptyState
          title="Nothing scheduled"
          description="No appointments in the next 7 days."
        />
      }
      renderItem={({ item }) => (
        <View style={styles.section}>
          <Text style={[styles.sectionHeader, { color: colors.textMuted }]}>
            {item.key}
          </Text>
          <View style={{ gap: 12 }}>
            {item.bookings.map((b) => (
              <BookingCard
                key={b.id}
                booking={b}
                onPress={() => router.push(`/bookings/${b.id}`)}
              />
            ))}
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16, paddingBottom: 32 },
  section: { marginBottom: 24 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
});
