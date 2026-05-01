import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/hooks/useAuth';
import { useTechnicianLocation } from '@/hooks/useTechnicianLocation';
import { useJobDistances } from '@/hooks/useJobDistances';
import { api, type DispatchJob } from '@/lib/api';
import { JobCard } from '@/components/JobCard';
import { DispatchMapView } from '@/components/DispatchMapView';
import { EmptyState } from '@/components/EmptyState';

const STATUS_FILTERS: Array<{ label: string; value: string | undefined }> = [
  { label: 'Active', value: undefined },
  { label: 'Assigned', value: 'assigned' },
  { label: 'En route', value: 'en_route' },
  { label: 'On site', value: 'on_site' },
  { label: 'In progress', value: 'in_progress' },
];

const ACTIVE_STATUSES = new Set([
  'assigned',
  'scheduled',
  'en_route',
  'on_site',
  'in_progress',
]);

type SortMode = 'scheduled' | 'distance';
type ViewMode = 'list' | 'map';

const SORT_MODES: Array<{ label: string; value: SortMode; icon: keyof typeof Ionicons.glyphMap }> = [
  { label: 'Time', value: 'scheduled', icon: 'time-outline' },
  { label: 'Closest', value: 'distance', icon: 'navigate-outline' },
];

const VIEW_MODES: Array<{ label: string; value: ViewMode; icon: keyof typeof Ionicons.glyphMap }> = [
  { label: 'List', value: 'list', icon: 'list-outline' },
  { label: 'Map', value: 'map', icon: 'map-outline' },
];

export default function DispatchScreen() {
  const colors = useColors();
  const router = useRouter();
  const { client, resourceId, resourceName } = useAuth();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(
    undefined,
  );
  const [sortMode, setSortMode] = useState<SortMode>('scheduled');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const { origin, status: locationStatus } = useTechnicianLocation();

  const query = useQuery({
    queryKey: ['jobs', resourceId, statusFilter],
    enabled: client !== null,
    queryFn: () =>
      api.listJobs(client!, {
        resourceId: resourceId,
        status: statusFilter,
        limit: 50,
      }),
  });

  useFocusEffect(
    useCallback(() => {
      query.refetch();
    }, [query]),
  );

  const jobs: DispatchJob[] = useMemo(
    () =>
      (query.data?.jobs ?? []).filter((job) => {
        if (statusFilter) return true;
        return ACTIVE_STATUSES.has(job.status);
      }),
    [query.data?.jobs, statusFilter],
  );

  const distanceSortActive = sortMode === 'distance' && origin !== null;
  const distancesEnabled = distanceSortActive || viewMode === 'map';
  const {
    distances,
    coordinates,
    isComputing: distancesComputing,
  } = useJobDistances(distancesEnabled ? jobs : [], origin);

  const sortedJobs = useMemo(() => {
    if (!distanceSortActive) return jobs;
    if (distances.size === 0) return jobs;
    const withDistance: DispatchJob[] = [];
    const withoutDistance: DispatchJob[] = [];
    for (const job of jobs) {
      if (distances.has(job.id)) {
        withDistance.push(job);
      } else {
        withoutDistance.push(job);
      }
    }
    withDistance.sort(
      (a, b) => (distances.get(a.id) ?? 0) - (distances.get(b.id) ?? 0),
    );
    return [...withDistance, ...withoutDistance];
  }, [jobs, distances, distanceSortActive]);

  const distanceUnavailable =
    sortMode === 'distance' &&
    (locationStatus === 'denied' ||
      locationStatus === 'unsupported' ||
      locationStatus === 'error');

  let sortHint: string | null = null;
  if (sortMode === 'distance') {
    if (distanceUnavailable) {
      sortHint =
        locationStatus === 'unsupported'
          ? 'Location is unavailable on this device — showing scheduled order.'
          : 'Location permission is off — showing scheduled order.';
    } else if (!origin && locationStatus === 'requesting') {
      sortHint = 'Locating you — order will update when ready.';
    } else if (
      origin &&
      jobs.length > 0 &&
      distances.size === 0 &&
      distancesComputing
    ) {
      sortHint = 'Calculating distances — order will update shortly.';
    } else if (
      origin &&
      jobs.length > 0 &&
      distances.size === 0 &&
      !distancesComputing
    ) {
      sortHint =
        "We couldn't resolve any job addresses — showing scheduled order.";
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.subheader}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.greeting, { color: colors.textMuted }]}>
            Assigned to
          </Text>
          <Text
            style={[styles.greetingName, { color: colors.text }]}
            numberOfLines={1}
          >
            {resourceName ?? 'All technicians'}
          </Text>
        </View>
        <Pressable
          onPress={() => query.refetch()}
          style={({ pressed }) => [
            styles.refreshBtn,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Ionicons name="refresh" size={18} color={colors.text} />
        </Pressable>
      </View>

      <View style={styles.filters}>
        {STATUS_FILTERS.map((opt) => {
          const active = opt.value === statusFilter;
          return (
            <Pressable
              key={opt.label}
              onPress={() => setStatusFilter(opt.value)}
              style={({ pressed }) => [
                styles.filterChip,
                {
                  backgroundColor: active
                    ? colors.primary
                    : colors.surface,
                  borderColor: active ? colors.primary : colors.border,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text
                style={{
                  color: active ? colors.textInverse : colors.text,
                  fontWeight: '600',
                  fontSize: 13,
                }}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.sortRow}>
        <Text style={[styles.sortLabel, { color: colors.textMuted }]}>
          Sort by
        </Text>
        <View
          style={[
            styles.segmented,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          {SORT_MODES.map((opt) => {
            const active = opt.value === sortMode;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setSortMode(opt.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Sort by ${opt.label}`}
                style={({ pressed }) => [
                  styles.segmentedItem,
                  {
                    backgroundColor: active ? colors.primary : 'transparent',
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Ionicons
                  name={opt.icon}
                  size={14}
                  color={active ? colors.textInverse : colors.text}
                />
                <Text
                  style={{
                    color: active ? colors.textInverse : colors.text,
                    fontWeight: '600',
                    fontSize: 13,
                  }}
                >
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.viewModeSpacer} />

        <View
          style={[
            styles.segmented,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          {VIEW_MODES.map((opt) => {
            const active = opt.value === viewMode;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setViewMode(opt.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Show ${opt.label} view`}
                style={({ pressed }) => [
                  styles.segmentedItem,
                  {
                    backgroundColor: active ? colors.primary : 'transparent',
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Ionicons
                  name={opt.icon}
                  size={14}
                  color={active ? colors.textInverse : colors.text}
                />
                <Text
                  style={{
                    color: active ? colors.textInverse : colors.text,
                    fontWeight: '600',
                    fontSize: 13,
                  }}
                >
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {viewMode === 'list' && sortHint ? (
        <Text style={[styles.sortHint, { color: colors.textMuted }]}>
          {sortHint}
        </Text>
      ) : null}

      {query.isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : query.isError ? (
        <EmptyState
          title="Could not load jobs"
          description={
            query.error instanceof Error
              ? query.error.message
              : 'Pull down to retry.'
          }
        />
      ) : viewMode === 'map' ? (
        <DispatchMapView
          jobs={sortedJobs}
          coordinates={coordinates}
          distances={distances}
          origin={origin}
          isResolvingCoords={distancesComputing}
          isLocating={locationStatus === 'requesting' && !origin}
          locationUnavailable={
            locationStatus === 'denied' ||
            locationStatus === 'unsupported' ||
            locationStatus === 'error'
          }
          onSelectJob={(jobId) => router.push(`/jobs/${jobId}`)}
        />
      ) : (
        <FlatList
          data={sortedJobs}
          keyExtractor={(j) => j.id}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <EmptyState
              title="No jobs"
              description={
                statusFilter
                  ? 'No jobs match this filter.'
                  : 'You have no active jobs assigned.'
              }
            />
          }
          renderItem={({ item }) => (
            <JobCard
              job={item}
              onPress={() => router.push(`/jobs/${item.id}`)}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  subheader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 12,
  },
  greeting: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  greetingName: { fontSize: 18, fontWeight: '700', marginTop: 2 },
  refreshBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  filterChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  sortLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: 999,
    borderWidth: 1,
    padding: 2,
  },
  viewModeSpacer: {
    flex: 1,
  },
  segmentedItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  sortHint: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  list: {
    padding: 16,
    paddingTop: 4,
    paddingBottom: 32,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
