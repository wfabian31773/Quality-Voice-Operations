import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { StatusPill } from './StatusPill';
import type { DispatchJob } from '@/lib/api';
import { formatDateTime } from '@/lib/formatters';

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
  const priorityFg =
    job.priority === 'urgent' || job.priority === 'high'
      ? colors.danger
      : colors.textMuted;

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
});
