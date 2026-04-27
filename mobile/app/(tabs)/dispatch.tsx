import { useCallback, useState } from 'react';
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
import { api, type DispatchJob } from '@/lib/api';
import { JobCard } from '@/components/JobCard';
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

export default function DispatchScreen() {
  const colors = useColors();
  const router = useRouter();
  const { client, resourceId, resourceName } = useAuth();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(
    undefined,
  );

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

  const jobs: DispatchJob[] = (query.data?.jobs ?? []).filter((job) => {
    if (statusFilter) return true;
    return ACTIVE_STATUSES.has(job.status);
  });

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
      ) : (
        <FlatList
          data={jobs}
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
