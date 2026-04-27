import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import {
  dismissConflict,
  getConflicts,
  getQueueSnapshot,
  isDraining,
  manualRetry,
  subscribe,
  type ConflictEntry,
  type QueuedItem,
} from '@/lib/offlineQueue';
import { isOffline, subscribeConnectivity } from '@/lib/connectivity';
import { formatStatus } from '@/lib/formatters';

export function OfflineBanner() {
  const colors = useColors();
  const [items, setItems] = useState<QueuedItem[]>(getQueueSnapshot());
  const [conflicts, setConflicts] = useState<ConflictEntry[]>(getConflicts());
  const [offline, setOffline] = useState<boolean>(isOffline());
  const [draining, setDraining] = useState<boolean>(isDraining());
  const seenConflicts = useRef<Set<string>>(new Set());

  useEffect(() => {
    return subscribe(() => {
      setItems(getQueueSnapshot());
      setConflicts(getConflicts());
      setDraining(isDraining());
    });
  }, []);

  useEffect(() => {
    return subscribeConnectivity((online) => setOffline(!online));
  }, []);

  // Surface each new conflict to the technician via a one-time alert. The
  // entry stays in the conflict list until they tap "Got it" (which dismisses
  // it). If they background the app, the alert will reappear on the next
  // render because `seenConflicts` resets — but only for items that are still
  // present in the conflict list.
  useEffect(() => {
    for (const c of conflicts) {
      if (seenConflicts.current.has(c.id)) continue;
      seenConflicts.current.add(c.id);
      const verb = c.kind === 'job_transition' ? 'Job' : 'Appointment';
      const subject = c.targetTitle ? `“${c.targetTitle}”` : '';
      const action = formatStatus(c.attempt) || 'update';
      Alert.alert(
        `${verb} update could not sync`,
        [
          `${verb} ${subject}`.trim(),
          `Your “${action}” update was rejected by the server (${c.message}).`,
          'It may have already been changed by dispatch. Pull to refresh and try again if needed.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        [{ text: 'Got it', onPress: () => dismissConflict(c.id) }],
        { cancelable: false },
      );
    }
    // Forget conflicts that have been dismissed so we re-alert if they ever
    // come back with the same id (shouldn't happen, but defensive).
    const liveIds = new Set(conflicts.map((c) => c.id));
    for (const id of Array.from(seenConflicts.current)) {
      if (!liveIds.has(id)) seenConflicts.current.delete(id);
    }
  }, [conflicts]);

  if (items.length === 0) return null;

  const count = items.length;
  const noun = count === 1 ? 'update' : 'updates';
  const message = draining
    ? `Syncing ${count} pending ${noun}…`
    : offline
      ? `Working offline — ${count} pending ${noun}`
      : `${count} pending ${noun} queued`;

  const bg = offline ? colors.danger : colors.warning;

  return (
    <View
      style={[styles.banner, { backgroundColor: bg }]}
      accessibilityRole="alert"
      accessibilityLabel={message}
    >
      <Ionicons
        name={offline ? 'cloud-offline-outline' : 'cloud-upload-outline'}
        size={16}
        color="#fff"
      />
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
      <Pressable
        onPress={() => void manualRetry()}
        disabled={draining}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Retry pending updates"
        style={({ pressed }) => [
          styles.retryBtn,
          { opacity: draining ? 0.5 : pressed ? 0.7 : 1 },
        ]}
      >
        <Text style={styles.retryLabel}>
          {draining ? 'Syncing…' : 'Retry'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  text: {
    flex: 1,
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  retryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  retryLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
