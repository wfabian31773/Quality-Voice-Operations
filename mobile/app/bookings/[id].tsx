import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/hooks/useAuth';
import {
  api,
  ApiError,
  OfflineError,
  type BookingAction,
  type SchedulingBooking,
} from '@/lib/api';
import { isOffline } from '@/lib/connectivity';
import {
  enqueueBookingTransition,
  getBookingQueueEntry,
  subscribe as subscribeQueue,
  type QueuedItem,
} from '@/lib/offlineQueue';
import { StatusPill } from '@/components/StatusPill';
import { ContactRow } from '@/components/ContactRow';
import { PrimaryButton } from '@/components/PrimaryButton';
import { EmptyState } from '@/components/EmptyState';
import { formatStatus, formatTimeRange } from '@/lib/formatters';

const NEXT_ACTIONS: Record<
  SchedulingBooking['status'],
  Array<{
    label: string;
    action: BookingAction;
    variant: 'primary' | 'secondary' | 'success' | 'danger';
    confirm?: boolean;
  }>
> = {
  pending: [
    { label: 'Confirm', action: 'confirm', variant: 'primary' },
    { label: 'Cancel', action: 'cancel', variant: 'danger', confirm: true },
  ],
  confirmed: [
    { label: 'Check in', action: 'check_in', variant: 'primary' },
    { label: 'Mark no-show', action: 'no_show', variant: 'secondary', confirm: true },
    { label: 'Cancel', action: 'cancel', variant: 'danger', confirm: true },
  ],
  checked_in: [
    { label: 'Complete', action: 'complete', variant: 'success' },
    { label: 'Cancel', action: 'cancel', variant: 'danger', confirm: true },
  ],
  no_show: [
    { label: 'Reopen', action: 'reopen', variant: 'secondary' },
  ],
  cancelled: [
    { label: 'Reopen', action: 'reopen', variant: 'secondary' },
  ],
  completed: [],
  rescheduled: [],
};

export default function BookingDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const id = params.id;
  const { client } = useAuth();
  const qc = useQueryClient();
  const [pendingAction, setPendingAction] = useState<BookingAction | null>(
    null,
  );

  const query = useQuery({
    queryKey: ['booking', id],
    enabled: client !== null && Boolean(id),
    queryFn: () => api.getBooking(client!, id!),
  });

  const booking = query.data?.booking;

  const [queuedEntry, setQueuedEntry] = useState<QueuedItem | null>(
    id ? getBookingQueueEntry(id) : null,
  );

  useEffect(() => {
    if (!id) return;
    setQueuedEntry(getBookingQueueEntry(id));
    return subscribeQueue(() => {
      setQueuedEntry(getBookingQueueEntry(id));
    });
  }, [id]);

  type TransitionResult =
    | { queued: true; action: BookingAction }
    | { queued: false };

  const transition = useMutation<TransitionResult, Error, BookingAction>({
    mutationFn: async (action) => {
      if (isOffline()) {
        await enqueueBookingTransition({
          bookingId: id!,
          bookingTitle: booking?.title,
          action,
        });
        return { queued: true, action };
      }
      try {
        await api.transitionBooking(client!, id!, action);
        return { queued: false };
      } catch (err) {
        if (err instanceof OfflineError) {
          await enqueueBookingTransition({
            bookingId: id!,
            bookingTitle: booking?.title,
            action,
          });
          return { queued: true, action };
        }
        throw err;
      }
    },
    onMutate: (action) => {
      setPendingAction(action);
    },
    onSettled: () => {
      setPendingAction(null);
    },
    onSuccess: (result) => {
      if (result.queued) {
        Alert.alert(
          'Queued offline',
          `“${formatStatus(result.action)}” will sync as soon as you’re back online.`,
        );
        return;
      }
      qc.invalidateQueries({ queryKey: ['booking', id] });
      qc.invalidateQueries({ queryKey: ['bookings'] });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Could not update the appointment.';
      Alert.alert('Update failed', message);
    },
  });
  const actions = useMemo(
    () => (booking ? NEXT_ACTIONS[booking.status] ?? [] : []),
    [booking],
  );

  const runAction = (action: BookingAction, confirm?: boolean) => {
    const go = () => transition.mutate(action);
    if (confirm) {
      Alert.alert(
        'Confirm action',
        'This will update the appointment for the team.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue', style: 'destructive', onPress: go },
        ],
      );
    } else {
      go();
    }
  };

  if (query.isLoading || !id) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (query.isError || !booking) {
    return (
      <View style={[styles.flex, { backgroundColor: colors.background }]}>
        <EmptyState
          title="Appointment not found"
          description={
            query.error instanceof ApiError
              ? query.error.message
              : 'It may have been rescheduled or removed.'
          }
        />
        <PrimaryButton
          label="Back"
          variant="secondary"
          onPress={() => router.back()}
          style={{ margin: 16 }}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.container}
    >
      <View style={styles.titleRow}>
        <StatusPill status={booking.status} />
        {booking.appointment_type_name ? (
          <Text style={[styles.type, { color: colors.textMuted }]}>
            {booking.appointment_type_name}
          </Text>
        ) : null}
      </View>

      <Text style={[styles.title, { color: colors.text }]}>
        {booking.title}
      </Text>
      {booking.description ? (
        <Text style={[styles.description, { color: colors.textMuted }]}>
          {booking.description}
        </Text>
      ) : null}

      {queuedEntry ? (
        <View
          style={[
            styles.queuedCard,
            {
              backgroundColor: colors.warningMuted,
              borderColor: colors.warning,
            },
          ]}
        >
          <Ionicons
            name="cloud-upload-outline"
            size={16}
            color={colors.warning}
          />
          <View style={{ flex: 1 }}>
            <Text style={[styles.queuedTitle, { color: colors.text }]}>
              Queued offline:{' '}
              {formatStatus(queuedEntry.bookingAction ?? '')}
            </Text>
            <Text style={[styles.queuedHint, { color: colors.textMuted }]}>
              {queuedEntry.lastError
                ? `Last try failed: ${queuedEntry.lastError}`
                : 'Will sync as soon as you’re back online.'}
            </Text>
          </View>
        </View>
      ) : null}

      <View
        style={[
          styles.metaCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <MetaRow
          icon="time-outline"
          label="When"
          value={formatTimeRange(booking.start_time, booking.end_time)}
        />
        {booking.location ? (
          <MetaRow
            icon="location-outline"
            label="Location"
            value={booking.location}
          />
        ) : null}
        {booking.provider_name ? (
          <MetaRow
            icon="briefcase-outline"
            label="Provider"
            value={booking.provider_name}
          />
        ) : null}
        {booking.resource_name ? (
          <MetaRow
            icon="person-outline"
            label="Resource"
            value={booking.resource_name}
          />
        ) : null}
      </View>

      <ContactRow
        name={booking.contact_name}
        phone={booking.contact_phone}
        email={booking.contact_email}
      />

      {booking.notes ? (
        <View
          style={[
            styles.notes,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
            Notes
          </Text>
          <Text style={[styles.notesText, { color: colors.text }]}>
            {booking.notes}
          </Text>
        </View>
      ) : null}

      {actions.length > 0 ? (
        <View style={{ gap: 10 }}>
          <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
            Actions
          </Text>
          {actions.map((a) => (
            <PrimaryButton
              key={a.action}
              label={a.label}
              variant={a.variant}
              loading={transition.isPending && pendingAction === a.action}
              disabled={transition.isPending}
              onPress={() => runAction(a.action, a.confirm)}
            />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function MetaRow({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.metaRow}>
      <Ionicons name={icon} size={16} color={colors.textMuted} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.metaLabel, { color: colors.textMuted }]}>
          {label}
        </Text>
        <Text style={[styles.metaValue, { color: colors.text }]}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 16, gap: 16, paddingBottom: 32 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  type: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  title: { fontSize: 22, fontWeight: '800', lineHeight: 28 },
  description: { fontSize: 15, lineHeight: 21 },
  metaCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
  },
  metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  metaLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  metaValue: { fontSize: 14, fontWeight: '600', marginTop: 2 },
  notes: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  notesText: { fontSize: 14, lineHeight: 20 },
  queuedCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  queuedTitle: { fontSize: 13, fontWeight: '700' },
  queuedHint: { fontSize: 12, marginTop: 2 },
});
