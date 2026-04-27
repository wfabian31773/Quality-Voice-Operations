import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
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
  type DispatchJob,
  type DispatchTransition,
  type JobAttachment,
} from '@/lib/api';
import { isOffline } from '@/lib/connectivity';
import {
  enqueueJobTransition,
  getJobQueueEntry,
  subscribe as subscribeQueue,
  type QueuedItem,
} from '@/lib/offlineQueue';
import { StatusPill } from '@/components/StatusPill';
import { ContactRow } from '@/components/ContactRow';
import { JobMapPreview } from '@/components/JobMapPreview';
import { PrimaryButton } from '@/components/PrimaryButton';
import { EmptyState } from '@/components/EmptyState';
import { CompletionSheet } from '@/components/CompletionSheet';
import { formatDateTime, formatStatus } from '@/lib/formatters';
import { openDirections } from '@/lib/maps';

const NEXT_STEPS: Record<
  DispatchJob['status'],
  Array<{
    label: string;
    next: DispatchTransition;
    variant: 'primary' | 'secondary' | 'success' | 'danger';
    confirm?: boolean;
  }>
> = {
  pending: [
    { label: 'Accept', next: 'assigned', variant: 'primary' },
    { label: 'Decline', next: 'cancelled', variant: 'danger', confirm: true },
  ],
  assigned: [
    { label: 'Start travel (En route)', next: 'en_route', variant: 'primary' },
    { label: 'Decline', next: 'pending', variant: 'secondary', confirm: true },
    { label: 'Cancel job', next: 'cancelled', variant: 'danger', confirm: true },
  ],
  scheduled: [
    { label: 'Start travel (En route)', next: 'en_route', variant: 'primary' },
    { label: 'Cancel job', next: 'cancelled', variant: 'danger', confirm: true },
  ],
  en_route: [
    { label: 'Mark On site', next: 'on_site', variant: 'primary' },
    { label: 'Cancel job', next: 'cancelled', variant: 'danger', confirm: true },
  ],
  on_site: [
    { label: 'Start work', next: 'in_progress', variant: 'primary' },
    { label: 'Cancel job', next: 'cancelled', variant: 'danger', confirm: true },
  ],
  in_progress: [
    { label: 'Complete', next: 'completed', variant: 'success' },
    { label: 'Mark incomplete', next: 'incomplete', variant: 'secondary', confirm: true },
    { label: 'Cancel job', next: 'cancelled', variant: 'danger', confirm: true },
  ],
  completed: [],
  incomplete: [],
  cancelled: [],
  done: [],
};

export default function JobDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const id = params.id;
  const { client, resourceId } = useAuth();
  const qc = useQueryClient();
  const [pendingTransition, setPendingTransition] =
    useState<DispatchTransition | null>(null);
  const [completionSheetOpen, setCompletionSheetOpen] = useState(false);

  const query = useQuery({
    queryKey: ['job', id],
    enabled: client !== null && Boolean(id),
    queryFn: () => api.getJob(client!, id!),
  });

  const job = query.data?.job;
  const events = query.data?.events ?? [];
  const attachments = query.data?.attachments ?? [];

  const [queuedEntry, setQueuedEntry] = useState<QueuedItem | null>(
    id ? getJobQueueEntry(id) : null,
  );

  useEffect(() => {
    if (!id) return;
    setQueuedEntry(getJobQueueEntry(id));
    return subscribeQueue(() => {
      setQueuedEntry(getJobQueueEntry(id));
    });
  }, [id]);

  type TransitionResult =
    | { queued: true; status: DispatchTransition }
    | { queued: false };

  const transition = useMutation<
    TransitionResult,
    Error,
    DispatchTransition
  >({
    mutationFn: async (next) => {
      // Short-circuit when we already know the device is offline so the tech
      // doesn't have to wait for a 15s timeout before the queue picks it up.
      if (isOffline()) {
        await enqueueJobTransition({
          jobId: id!,
          jobTitle: job?.title,
          status: next,
        });
        return { queued: true, status: next };
      }
      try {
        await api.transitionJob(client!, id!, next);
        return { queued: false };
      } catch (err) {
        if (err instanceof OfflineError) {
          await enqueueJobTransition({
            jobId: id!,
            jobTitle: job?.title,
            status: next,
          });
          return { queued: true, status: next };
        }
        throw err;
      }
    },
    onMutate: (next) => {
      setPendingTransition(next);
    },
    onSettled: () => {
      setPendingTransition(null);
    },
    onSuccess: (result) => {
      if (result.queued) {
        Alert.alert(
          'Queued offline',
          `“${formatStatus(result.status)}” will sync as soon as you’re back online.`,
        );
        return;
      }
      qc.invalidateQueries({ queryKey: ['job', id] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError ? err.message : 'Could not update the job.';
      Alert.alert('Update failed', message);
    },
  });

  const attachmentById = useMemo(() => {
    const map = new Map<string, JobAttachment>();
    for (const a of attachments) map.set(a.id, a);
    return map;
  }, [attachments]);

  const photoAttachments = useMemo(
    () =>
      attachments.filter(
        (a) =>
          (a.attachment_type === 'photo' ||
            a.attachment_type === 'proof_of_completion' ||
            a.attachment_type === 'proof_of_service' ||
            a.attachment_type === 'signature') &&
          (a.mime_type ?? '').startsWith('image/'),
      ),
    [attachments],
  );

  const noteAttachments = useMemo(
    () =>
      attachments.filter(
        (a) =>
          a.attachment_type === 'note' || (!a.object_path && a.content),
      ),
    [attachments],
  );

  const actions = useMemo(() => (job ? NEXT_STEPS[job.status] ?? [] : []), [job]);
  const completionEnabledStatuses = new Set([
    'assigned',
    'scheduled',
    'en_route',
    'on_site',
    'in_progress',
  ]);
  const showCompletionButton = job
    ? completionEnabledStatuses.has(job.status)
    : false;

  const runTransition = (next: DispatchTransition, confirm?: boolean) => {
    const go = () => transition.mutate(next);
    if (confirm) {
      Alert.alert(
        `${formatStatus(next)}?`,
        'This action will update the job for everyone on the team.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Confirm', style: 'destructive', onPress: go },
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

  if (query.isError || !job) {
    return (
      <View style={[styles.flex, { backgroundColor: colors.background }]}>
        <EmptyState
          title="Job not found"
          description={
            query.error instanceof ApiError
              ? query.error.message
              : 'The job may have been reassigned or removed.'
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
        <StatusPill status={job.status} />
        <Text style={[styles.priority, { color: colors.textMuted }]}>
          {formatStatus(job.priority)} priority
        </Text>
      </View>

      <Text style={[styles.title, { color: colors.text }]}>{job.title}</Text>
      {job.description ? (
        <Text style={[styles.description, { color: colors.textMuted }]}>
          {job.description}
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
              {formatStatus(queuedEntry.jobStatus ?? '')}
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
        <MetaRow icon="time-outline" label="Scheduled" value={formatDateTime(job.scheduled_at)} />
        {job.eta_start ? (
          <MetaRow
            icon="speedometer-outline"
            label="ETA"
            value={`${formatDateTime(job.eta_start)}${job.eta_end ? ` – ${formatDateTime(job.eta_end)}` : ''}`}
          />
        ) : null}
        {job.address ? (
          <MetaRow
            icon="location-outline"
            label="Address"
            value={job.address}
            onPress={() => {
              void openDirections(job.address!);
            }}
            actionHint="Tap for directions"
          />
        ) : null}
        {job.job_type ? (
          <MetaRow icon="construct-outline" label="Type" value={job.job_type} />
        ) : null}
        {job.resource_name ? (
          <MetaRow icon="person-outline" label="Technician" value={job.resource_name} />
        ) : null}
        {job.estimated_duration_minutes ? (
          <MetaRow
            icon="hourglass-outline"
            label="Est. duration"
            value={`${job.estimated_duration_minutes} min`}
          />
        ) : null}
      </View>

      {job.address ? <JobMapPreview address={job.address} /> : null}

      <ContactRow
        name={job.contact_name}
        phone={job.contact_phone}
        email={job.contact_email}
      />

      {job.notes ? (
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
            {job.notes}
          </Text>
        </View>
      ) : null}

      {actions.length > 0 || showCompletionButton ? (
        <View style={{ gap: 10 }}>
          <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
            Actions
          </Text>
          {showCompletionButton ? (
            <PrimaryButton
              label={
                job.status === 'in_progress'
                  ? 'Complete with photos & notes'
                  : 'Add photos & notes'
              }
              variant={job.status === 'in_progress' ? 'success' : 'primary'}
              onPress={() => setCompletionSheetOpen(true)}
              disabled={transition.isPending}
            />
          ) : null}
          {actions.map((a) => (
            <PrimaryButton
              key={a.next}
              label={a.label}
              variant={a.variant}
              loading={
                transition.isPending && pendingTransition === a.next
              }
              disabled={transition.isPending}
              onPress={() => runTransition(a.next, a.confirm)}
            />
          ))}
        </View>
      ) : null}

      {photoAttachments.length > 0 ? (
        <View
          style={[
            styles.notes,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
            Photos
          </Text>
          <View style={styles.photoStrip}>
            {photoAttachments.map((a) => (
              <Image
                key={a.id}
                source={{
                  uri: api.buildAttachmentFileUrl(client!, a.id),
                  headers: { Authorization: `Bearer ${client!.apiKey}` },
                }}
                style={[styles.photoThumb, { borderColor: colors.border }]}
              />
            ))}
          </View>
        </View>
      ) : null}

      {noteAttachments.length > 0 ? (
        <View
          style={[
            styles.notes,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
            Field notes
          </Text>
          {noteAttachments.map((a) => (
            <View key={a.id} style={{ gap: 4 }}>
              {a.title ? (
                <Text
                  style={{
                    color: colors.text,
                    fontWeight: '600',
                    fontSize: 13,
                  }}
                >
                  {a.title}
                </Text>
              ) : null}
              {a.content ? (
                <Text style={[styles.notesText, { color: colors.text }]}>
                  {a.content}
                </Text>
              ) : null}
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                {formatDateTime(a.created_at)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {events.length > 0 ? (
        <View
          style={[
            styles.timeline,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
            Activity
          </Text>
          {events.map((evt) => {
            const meta = (evt.metadata ?? {}) as Record<string, unknown>;
            const attachmentId =
              evt.event_type === 'attachment_added' &&
              typeof meta.attachment_id === 'string'
                ? meta.attachment_id
                : null;
            const inlineAttachment = attachmentId
              ? attachmentById.get(attachmentId)
              : null;
            const showInlinePhoto =
              inlineAttachment &&
              (inlineAttachment.mime_type ?? '').startsWith('image/');
            return (
              <View key={evt.id} style={styles.event}>
                <View
                  style={[
                    styles.eventDot,
                    { backgroundColor: colors.primary },
                  ]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.eventTitle, { color: colors.text }]}>
                    {evt.from_status && evt.to_status
                      ? `${formatStatus(evt.from_status)} → ${formatStatus(evt.to_status)}`
                      : formatStatus(evt.event_type)}
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                    {formatDateTime(evt.created_at)}
                  </Text>
                  {evt.notes ? (
                    <Text style={{ color: colors.textMuted, marginTop: 4 }}>
                      {evt.notes}
                    </Text>
                  ) : null}
                  {showInlinePhoto ? (
                    <Image
                      source={{
                        uri: api.buildAttachmentFileUrl(
                          client!,
                          inlineAttachment!.id,
                        ),
                        headers: {
                          Authorization: `Bearer ${client!.apiKey}`,
                        },
                      }}
                      style={[
                        styles.eventPhoto,
                        { borderColor: colors.border },
                      ]}
                    />
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {job ? (
        <CompletionSheet
          visible={completionSheetOpen}
          jobId={job.id}
          jobStatus={job.status}
          onClose={() => setCompletionSheetOpen(false)}
          onCompleted={() => {
            qc.invalidateQueries({ queryKey: ['job', id] });
            qc.invalidateQueries({ queryKey: ['jobs'] });
          }}
        />
      ) : null}
    </ScrollView>
  );
}

function MetaRow({
  icon,
  label,
  value,
  onPress,
  actionHint,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onPress?: () => void;
  actionHint?: string;
}) {
  const colors = useColors();
  const content = (
    <>
      <Ionicons name={icon} size={16} color={colors.textMuted} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.metaLabel, { color: colors.textMuted }]}>
          {label}
        </Text>
        <Text
          style={[
            styles.metaValue,
            { color: onPress ? colors.primary : colors.text },
          ]}
        >
          {value}
        </Text>
        {onPress && actionHint ? (
          <Text style={[styles.metaHint, { color: colors.textMuted }]}>
            {actionHint}
          </Text>
        ) : null}
      </View>
      {onPress ? (
        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      ) : null}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="link"
        accessibilityLabel={`${label}: ${value}. ${actionHint ?? ''}`.trim()}
        style={({ pressed }) => [styles.metaRow, { opacity: pressed ? 0.6 : 1 }]}
      >
        {content}
      </Pressable>
    );
  }

  return <View style={styles.metaRow}>{content}</View>;
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
  priority: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
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
  metaHint: { fontSize: 11, marginTop: 2 },
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
  photoStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  photoThumb: {
    width: 92,
    height: 92,
    borderRadius: 12,
    borderWidth: 1,
  },
  eventPhoto: {
    marginTop: 8,
    width: 160,
    height: 160,
    borderRadius: 10,
    borderWidth: 1,
  },
  timeline: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
  },
  event: { flexDirection: 'row', gap: 10 },
  eventDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 6,
  },
  eventTitle: { fontWeight: '600', fontSize: 14 },
});
