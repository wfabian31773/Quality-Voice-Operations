import { useCallback, useMemo } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useNotificationLog } from '@/hooks/useNotificationLog';
import { EmptyState } from '@/components/EmptyState';
import {
  eventLabel,
  notificationTargetPathFromRecord,
  type NotificationRecord,
} from '../../../shared/notifications/inbox';

function formatRelative(receivedAt: number, now: number): string {
  const diffMs = Math.max(0, now - receivedAt);
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(receivedAt).toLocaleDateString();
}

export default function AlertsScreen() {
  const colors = useColors();
  const router = useRouter();
  const { records, unread, markRead, markAllRead, clear } = useNotificationLog();

  // Mark everything as seen each time the user opens the tab.
  useFocusEffect(
    useCallback(() => {
      if (unread > 0) markAllRead();
    }, [markAllRead, unread]),
  );

  const onRowPress = useCallback(
    (record: NotificationRecord) => {
      markRead(record.id);
      const target = notificationTargetPathFromRecord(record);
      if (target) router.push(target);
    },
    [markRead, router],
  );

  const onClear = useCallback(() => {
    if (records.length === 0) return;
    Alert.alert(
      'Clear alert history?',
      'This removes the in-app history on this device. Future push notifications will continue to appear.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void clear();
          },
        },
      ],
    );
  }, [clear, records.length]);

  const now = useMemo(() => Date.now(), [records]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.subheader}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.greeting, { color: colors.textMuted }]}>
            Recent alerts
          </Text>
          <Text style={[styles.greetingName, { color: colors.text }]}>
            {records.length > 0
              ? `${records.length} ${records.length === 1 ? 'notification' : 'notifications'}`
              : 'No notifications yet'}
          </Text>
        </View>
        {records.length > 0 ? (
          <Pressable
            onPress={onClear}
            style={({ pressed }) => [
              styles.clearBtn,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
            accessibilityLabel="Clear alert history"
          >
            <Ionicons name="trash-outline" size={16} color={colors.text} />
            <Text style={[styles.clearLabel, { color: colors.text }]}>Clear</Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        data={records}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        ListEmptyComponent={
          <EmptyState
            title="No push alerts yet"
            description="When dispatch sends you a job assignment, status update, or appointment change, it will show up here."
          />
        }
        renderItem={({ item }) => (
          <AlertRow
            record={item}
            now={now}
            onPress={() => onRowPress(item)}
          />
        )}
      />
    </View>
  );
}

interface AlertRowProps {
  record: NotificationRecord;
  now: number;
  onPress: () => void;
}

function AlertRow({ record, now, onPress }: AlertRowProps) {
  const colors = useColors();
  const tag = eventLabel(record.event);
  const target = notificationTargetPathFromRecord(record);
  const tappable = target !== null;
  return (
    <Pressable
      onPress={onPress}
      disabled={!tappable}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: record.read ? colors.border : colors.primary,
          opacity: pressed && tappable ? 0.92 : 1,
        },
      ]}
      accessibilityRole={tappable ? 'button' : undefined}
    >
      <View style={styles.cardHeader}>
        {tag ? (
          <View
            style={[
              styles.tag,
              {
                backgroundColor: colors.primaryMuted,
                borderColor: colors.primary,
              },
            ]}
          >
            <Text style={[styles.tagText, { color: colors.primary }]}>{tag}</Text>
          </View>
        ) : (
          <View />
        )}
        <Text style={[styles.timestamp, { color: colors.textMuted }]}>
          {formatRelative(record.receivedAt, now)}
        </Text>
      </View>

      {record.title ? (
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {record.title}
        </Text>
      ) : null}

      {record.body ? (
        <Text
          style={[styles.body, { color: colors.textMuted }]}
          numberOfLines={4}
        >
          {record.body}
        </Text>
      ) : null}

      {tappable ? (
        <View style={styles.linkRow}>
          <Ionicons
            name={record.jobId ? 'briefcase-outline' : 'calendar-outline'}
            size={14}
            color={colors.primary}
          />
          <Text style={[styles.linkText, { color: colors.primary }]}>
            {record.jobId ? 'Open job' : 'Open appointment'}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  subheader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 12,
  },
  greeting: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  greetingName: { fontSize: 18, fontWeight: '700', marginTop: 2 },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
  },
  clearLabel: { fontSize: 13, fontWeight: '600' },
  list: {
    padding: 16,
    paddingTop: 4,
    paddingBottom: 32,
    flexGrow: 1,
  },
  card: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  tag: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  tagText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  timestamp: { fontSize: 12 },
  title: { fontSize: 15, fontWeight: '700', marginTop: 2 },
  body: { fontSize: 13, lineHeight: 18 },
  linkRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  linkText: { fontSize: 13, fontWeight: '600' },
});
