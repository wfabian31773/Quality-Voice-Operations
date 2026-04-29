import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AppState,
  type AppStateStatus,
  type NativeEventSubscription,
} from 'react-native';
import type { QueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  OfflineError,
  type ApiClient,
  type BookingAction,
  type DispatchTransition,
  type JobAttachment,
} from './api';
import { loadStoredCredentials } from './auth';
import { markOnline, subscribeConnectivity } from './connectivity';
import {
  deletePersistedAttachment,
  pruneOrphanedAttachments,
} from './attachmentStorage';

// Bumped from v1 because v1 used to persist `baseUrl`/`apiKey` in plaintext.
// Dropping the v1 key on disk avoids replaying any leftover entries that
// still carry credentials.
const STORAGE_KEY = 'voiceai.tech.offlineQueue.v2';
const LEGACY_STORAGE_KEYS = ['voiceai.tech.offlineQueue.v1'];

// Backoff schedule used when the head of the queue keeps hitting transient
// failures. The runner still drains immediately on connectivity changes /
// app foreground / manual retry; this schedule only governs the periodic
// background tick. Values are milliseconds; the actual delay adds ±25%
// jitter to avoid thundering-herd retries when many devices come back
// online together.
const BACKOFF_SCHEDULE_MS = [
  10_000,    // 10s
  30_000,    // 30s
  60_000,    // 1m
  2 * 60_000, // 2m
  5 * 60_000, // 5m
  10 * 60_000, // 10m (cap)
];
const MAX_BACKOFF_JITTER = 0.25;

export type QueuedKind =
  | 'job_transition'
  | 'booking_transition'
  | 'job_attachment';

export type QueuedAttachmentKind = 'photo' | 'note';

export interface QueuedItem {
  id: string;
  kind: QueuedKind;
  targetId: string;
  targetTitle: string | null;
  // job_transition / booking_transition
  jobStatus?: DispatchTransition;
  jobNotes?: string | null;
  bookingAction?: BookingAction;
  bookingExtra?: { cancellation_reason?: string };
  // job_attachment
  attachmentKind?: QueuedAttachmentKind;
  attachmentType?: JobAttachment['attachment_type'];
  attachmentTitle?: string;
  attachmentContent?: string;
  localFileUri?: string;
  mimeType?: string | null;
  fileSizeBytes?: number | null;
  completionTransition?: DispatchTransition | null;
  enqueuedAt: number;
  attempts: number;
  lastError: string | null;
}

export interface ConflictEntry {
  id: string;
  kind: QueuedKind;
  targetId: string;
  targetTitle: string | null;
  attempt: string;
  status: number;
  message: string;
  at: number;
}

type Listener = () => void;

let queue: QueuedItem[] = [];
let conflicts: ConflictEntry[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;
let draining = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSub: NativeEventSubscription | null = null;
let connectivitySub: (() => void) | null = null;
let queryClientRef: QueryClient | null = null;
let runnerStarted = false;
// Number of consecutive transient-failure drains; resets to 0 whenever a
// drain processes at least one item or whenever a fresh enqueue happens.
let consecutiveTransientFailures = 0;

const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l();
}

async function persistQueue() {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // best-effort persistence
  }
}

function sanitizeLoadedItem(raw: unknown): QueuedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (
    kind !== 'job_transition' &&
    kind !== 'booking_transition' &&
    kind !== 'job_attachment'
  ) {
    return null;
  }
  if (typeof r.id !== 'string' || typeof r.targetId !== 'string') return null;
  // Strip any legacy credential fields (`baseUrl`, `apiKey`) that may have
  // been persisted by an older build — never carry them back into memory.
  const item: QueuedItem = {
    id: r.id,
    kind,
    targetId: r.targetId,
    targetTitle: typeof r.targetTitle === 'string' ? r.targetTitle : null,
    jobStatus: r.jobStatus as DispatchTransition | undefined,
    jobNotes: typeof r.jobNotes === 'string' ? r.jobNotes : null,
    bookingAction: r.bookingAction as BookingAction | undefined,
    bookingExtra:
      r.bookingExtra && typeof r.bookingExtra === 'object'
        ? (r.bookingExtra as { cancellation_reason?: string })
        : undefined,
    attachmentKind:
      r.attachmentKind === 'photo' || r.attachmentKind === 'note'
        ? r.attachmentKind
        : undefined,
    attachmentType: r.attachmentType as JobAttachment['attachment_type'] | undefined,
    attachmentTitle:
      typeof r.attachmentTitle === 'string' ? r.attachmentTitle : undefined,
    attachmentContent:
      typeof r.attachmentContent === 'string' ? r.attachmentContent : undefined,
    localFileUri:
      typeof r.localFileUri === 'string' ? r.localFileUri : undefined,
    mimeType: typeof r.mimeType === 'string' ? r.mimeType : null,
    fileSizeBytes:
      typeof r.fileSizeBytes === 'number' ? r.fileSizeBytes : null,
    completionTransition:
      (r.completionTransition as DispatchTransition | null | undefined) ?? null,
    enqueuedAt: typeof r.enqueuedAt === 'number' ? r.enqueuedAt : Date.now(),
    attempts: typeof r.attempts === 'number' ? r.attempts : 0,
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
  };
  return item;
}

function collectLiveAttachmentUris(): Set<string> {
  const live = new Set<string>();
  for (const q of queue) {
    if (q.kind === 'job_attachment' && q.localFileUri) {
      live.add(q.localFileUri);
    }
  }
  return live;
}

export async function loadQueue(): Promise<void> {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            queue = parsed
              .map(sanitizeLoadedItem)
              .filter((x): x is QueuedItem => x !== null);
          }
        }
      } catch {
        queue = [];
      }
      // Best-effort cleanup of any legacy storage keys that may still hold
      // payloads with embedded credentials. We never load from them.
      for (const legacy of LEGACY_STORAGE_KEYS) {
        try {
          await AsyncStorage.removeItem(legacy);
        } catch {
          // best effort
        }
      }
      // Drop any persisted attachment files that no live queue entry
      // references anymore (e.g. interrupted drains or version upgrades).
      void pruneOrphanedAttachments(collectLiveAttachmentUris());
      loaded = true;
      notify();
    })();
  }
  await loadPromise;
}

export function attachQueryClient(qc: QueryClient): void {
  queryClientRef = qc;
}

export function getQueueSnapshot(): QueuedItem[] {
  return queue.slice();
}

export function getConflicts(): ConflictEntry[] {
  return conflicts.slice();
}

export function dismissConflict(id: string): void {
  const before = conflicts.length;
  conflicts = conflicts.filter((c) => c.id !== id);
  if (conflicts.length !== before) notify();
}

export function isJobQueued(jobId: string): boolean {
  return queue.some(
    (q) =>
      (q.kind === 'job_transition' || q.kind === 'job_attachment') &&
      q.targetId === jobId,
  );
}

export function isBookingQueued(bookingId: string): boolean {
  return queue.some(
    (q) => q.kind === 'booking_transition' && q.targetId === bookingId,
  );
}

export function getJobQueueEntry(jobId: string): QueuedItem | null {
  return (
    queue.find(
      (q) => q.kind === 'job_transition' && q.targetId === jobId,
    ) ?? null
  );
}

export function getBookingQueueEntry(bookingId: string): QueuedItem | null {
  return (
    queue.find(
      (q) => q.kind === 'booking_transition' && q.targetId === bookingId,
    ) ?? null
  );
}

export interface JobQueueSummary {
  transition: QueuedItem | null;
  // The DispatchTransition (e.g. 'completed') that the queue will fire
  // once it finishes draining — either from an explicit job_transition
  // queue item, or from a `completion_transition` riding on the last
  // queued attachment. Surfaces in the UI's "Pending sync" card so techs
  // know an offline-saved completion will eventually land.
  pendingCompletionTransition: DispatchTransition | null;
  photoCount: number;
  noteCount: number;
  total: number;
  lastError: string | null;
}

export function getJobQueueSummary(jobId: string): JobQueueSummary {
  let transition: QueuedItem | null = null;
  let pendingCompletionTransition: DispatchTransition | null = null;
  let photoCount = 0;
  let noteCount = 0;
  let total = 0;
  let lastError: string | null = null;
  for (const q of queue) {
    if (q.targetId !== jobId) continue;
    if (q.kind === 'job_transition') {
      transition = q;
      if (q.jobStatus) pendingCompletionTransition = q.jobStatus;
      total += 1;
      if (q.lastError) lastError = q.lastError;
    } else if (q.kind === 'job_attachment') {
      total += 1;
      if (q.attachmentKind === 'photo') photoCount += 1;
      else if (q.attachmentKind === 'note') noteCount += 1;
      if (q.completionTransition) {
        pendingCompletionTransition = q.completionTransition;
      }
      if (q.lastError) lastError = q.lastError;
    }
  }
  return {
    transition,
    pendingCompletionTransition,
    photoCount,
    noteCount,
    total,
    lastError,
  };
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function isDraining(): boolean {
  return draining;
}

function makeId(): string {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function onEnqueue() {
  // Fresh user input — drop any backoff so the next runner tick happens
  // soon rather than minutes from now.
  consecutiveTransientFailures = 0;
  if (runnerStarted) scheduleNextDrain();
}

export async function enqueueJobTransition(args: {
  jobId: string;
  jobTitle?: string | null;
  status: DispatchTransition;
  notes?: string;
}): Promise<QueuedItem> {
  await loadQueue();
  const item: QueuedItem = {
    id: makeId(),
    kind: 'job_transition',
    targetId: args.jobId,
    targetTitle: args.jobTitle ?? null,
    jobStatus: args.status,
    jobNotes: args.notes ?? null,
    enqueuedAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  queue.push(item);
  await persistQueue();
  notify();
  onEnqueue();
  return item;
}

export async function enqueueBookingTransition(args: {
  bookingId: string;
  bookingTitle?: string | null;
  action: BookingAction;
  extra?: { cancellation_reason?: string };
}): Promise<QueuedItem> {
  await loadQueue();
  const item: QueuedItem = {
    id: makeId(),
    kind: 'booking_transition',
    targetId: args.bookingId,
    targetTitle: args.bookingTitle ?? null,
    bookingAction: args.action,
    bookingExtra: args.extra,
    enqueuedAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  queue.push(item);
  await persistQueue();
  notify();
  onEnqueue();
  return item;
}

export async function enqueueJobAttachmentPhoto(args: {
  jobId: string;
  jobTitle?: string | null;
  attachmentType: JobAttachment['attachment_type'];
  title: string;
  localFileUri: string;
  mimeType: string;
  fileSizeBytes?: number | null;
  completionTransition?: DispatchTransition | null;
}): Promise<QueuedItem> {
  await loadQueue();
  const item: QueuedItem = {
    id: makeId(),
    kind: 'job_attachment',
    targetId: args.jobId,
    targetTitle: args.jobTitle ?? null,
    attachmentKind: 'photo',
    attachmentType: args.attachmentType,
    attachmentTitle: args.title,
    localFileUri: args.localFileUri,
    mimeType: args.mimeType,
    fileSizeBytes: args.fileSizeBytes ?? null,
    completionTransition: args.completionTransition ?? null,
    enqueuedAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  queue.push(item);
  await persistQueue();
  notify();
  onEnqueue();
  return item;
}

export async function enqueueJobAttachmentNote(args: {
  jobId: string;
  jobTitle?: string | null;
  title: string;
  content: string;
  completionTransition?: DispatchTransition | null;
}): Promise<QueuedItem> {
  await loadQueue();
  const item: QueuedItem = {
    id: makeId(),
    kind: 'job_attachment',
    targetId: args.jobId,
    targetTitle: args.jobTitle ?? null,
    attachmentKind: 'note',
    attachmentType: 'note',
    attachmentTitle: args.title,
    attachmentContent: args.content,
    completionTransition: args.completionTransition ?? null,
    enqueuedAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  queue.push(item);
  await persistQueue();
  notify();
  onEnqueue();
  return item;
}

function describeAttempt(item: QueuedItem): string {
  if (item.kind === 'job_transition') return item.jobStatus ?? '';
  if (item.kind === 'booking_transition') return item.bookingAction ?? '';
  if (item.kind === 'job_attachment') {
    return item.attachmentKind === 'photo' ? 'photo upload' : 'field note';
  }
  return '';
}

function invalidateForItem(item: QueuedItem) {
  if (!queryClientRef) return;
  if (item.kind === 'job_transition' || item.kind === 'job_attachment') {
    queryClientRef.invalidateQueries({ queryKey: ['job', item.targetId] });
    queryClientRef.invalidateQueries({ queryKey: ['jobs'] });
  } else {
    queryClientRef.invalidateQueries({
      queryKey: ['booking', item.targetId],
    });
    queryClientRef.invalidateQueries({ queryKey: ['bookings'] });
  }
}

type ExecResult =
  | { ok: true }
  | { ok: false; conflict: ConflictEntry }
  | { ok: false; transient: true; message: string };

async function executeItem(item: QueuedItem): Promise<ExecResult> {
  const creds = await loadStoredCredentials();
  if (!creds) {
    // Signed out — leave the queue intact but pause draining. Once the tech
    // signs back in, the next connectivity tick / app-active event will
    // trigger another drain attempt with fresh credentials.
    return {
      ok: false,
      transient: true,
      message: 'Signed out — waiting for sign-in to retry',
    };
  }
  const client: ApiClient = { baseUrl: creds.baseUrl, apiKey: creds.apiKey };
  try {
    if (item.kind === 'job_transition' && item.jobStatus) {
      await api.transitionJob(
        client,
        item.targetId,
        item.jobStatus,
        item.jobNotes ?? undefined,
      );
    } else if (item.kind === 'booking_transition' && item.bookingAction) {
      await api.transitionBooking(
        client,
        item.targetId,
        item.bookingAction,
        item.bookingExtra ?? {},
      );
    } else if (item.kind === 'job_attachment') {
      await executeAttachmentItem(client, item);
    } else {
      // Malformed entry — drop silently.
      return { ok: true };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof OfflineError) {
      return { ok: false, transient: true, message: err.message };
    }
    if (err instanceof ApiError) {
      // 5xx responses look like a transient backend hiccup; everything else
      // (4xx) is a real conflict the technician needs to know about.
      if (err.status >= 500) {
        return { ok: false, transient: true, message: err.message };
      }
      return {
        ok: false,
        conflict: {
          id: item.id,
          kind: item.kind,
          targetId: item.targetId,
          targetTitle: item.targetTitle,
          attempt: describeAttempt(item),
          status: err.status,
          message: err.message,
          at: Date.now(),
        },
      };
    }
    return {
      ok: false,
      transient: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeAttachmentItem(
  client: ApiClient,
  item: QueuedItem,
): Promise<void> {
  if (item.attachmentKind === 'photo') {
    if (!item.localFileUri || !item.attachmentType) {
      // Malformed; treat as success so we drop it.
      return;
    }
    const ticket = await api.requestAttachmentUpload(client, {
      mime_type: item.mimeType ?? undefined,
      size_bytes: item.fileSizeBytes ?? undefined,
    });
    await api.uploadAttachmentBinary(ticket, {
      uri: item.localFileUri,
      mimeType: item.mimeType ?? null,
      sizeBytes: item.fileSizeBytes ?? null,
    });
    await api.addAttachment(client, item.targetId, {
      attachment_type: item.attachmentType,
      title: item.attachmentTitle,
      object_path: ticket.objectPath,
      mime_type: item.mimeType ?? null,
      file_size_bytes: item.fileSizeBytes ?? null,
      completion_transition: item.completionTransition ?? null,
    });
    return;
  }
  if (item.attachmentKind === 'note') {
    if (!item.attachmentContent) return;
    await api.addAttachment(client, item.targetId, {
      attachment_type: item.attachmentType ?? 'note',
      title: item.attachmentTitle,
      content: item.attachmentContent,
      completion_transition: item.completionTransition ?? null,
    });
  }
}

export async function drainQueue(): Promise<{
  processed: number;
  conflicts: number;
  remaining: number;
}> {
  await loadQueue();
  if (draining || queue.length === 0) {
    return { processed: 0, conflicts: 0, remaining: queue.length };
  }
  draining = true;
  notify();
  let processed = 0;
  let newConflicts = 0;
  let hitTransient = false;
  try {
    while (queue.length > 0) {
      const item = queue[0];
      item.attempts += 1;
      const result = await executeItem(item);
      if (result.ok) {
        invalidateForItem(item);
        // Free the on-disk file copy now that the upload landed.
        if (item.kind === 'job_attachment' && item.localFileUri) {
          void deletePersistedAttachment(item.localFileUri);
        }
        queue.shift();
        await persistQueue();
        notify();
        processed += 1;
        continue;
      }
      if ('conflict' in result) {
        invalidateForItem(item);
        if (item.kind === 'job_attachment' && item.localFileUri) {
          void deletePersistedAttachment(item.localFileUri);
        }
        conflicts.push(result.conflict);
        queue.shift();
        await persistQueue();
        notify();
        newConflicts += 1;
        continue;
      }
      // Transient: leave at the head and stop. Persist updated attempt count.
      item.lastError = result.message;
      await persistQueue();
      notify();
      hitTransient = true;
      break;
    }
  } finally {
    draining = false;
    notify();
  }
  // Reset backoff if we made progress; otherwise grow it for next tick.
  if (processed > 0 || newConflicts > 0) {
    consecutiveTransientFailures = 0;
  } else if (hitTransient) {
    consecutiveTransientFailures += 1;
  }
  if (runnerStarted) scheduleNextDrain();
  return {
    processed,
    conflicts: newConflicts,
    remaining: queue.length,
  };
}

function nextBackoffDelayMs(): number {
  const idx = Math.min(
    consecutiveTransientFailures,
    BACKOFF_SCHEDULE_MS.length - 1,
  );
  const base = BACKOFF_SCHEDULE_MS[idx];
  const jitter = base * MAX_BACKOFF_JITTER * (Math.random() * 2 - 1);
  return Math.max(1_000, Math.round(base + jitter));
}

function scheduleNextDrain(): void {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  if (queue.length === 0) return;
  const delay = nextBackoffDelayMs();
  drainTimer = setTimeout(() => {
    drainTimer = null;
    if (queue.length > 0 && !draining) void drainQueue();
  }, delay);
}

export function startOfflineQueueRunner(): void {
  if (runnerStarted) return;
  runnerStarted = true;
  void loadQueue().then(() => {
    if (queue.length > 0) void drainQueue();
  });
  appStateSub = AppState.addEventListener(
    'change',
    (status: AppStateStatus) => {
      if (status === 'active' && queue.length > 0 && !draining) {
        // Coming back to the foreground is a strong signal to retry now.
        consecutiveTransientFailures = 0;
        void drainQueue();
      }
    },
  );
  connectivitySub = subscribeConnectivity((online) => {
    if (online && queue.length > 0 && !draining) {
      // Network just came back — drop any backoff and try immediately.
      consecutiveTransientFailures = 0;
      void drainQueue();
    }
  });
}

export function stopOfflineQueueRunner(): void {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  if (appStateSub) {
    appStateSub.remove();
    appStateSub = null;
  }
  if (connectivitySub) {
    connectivitySub();
    connectivitySub = null;
  }
  runnerStarted = false;
}

export async function manualRetry(): Promise<void> {
  // Optimistically clear the offline flag so apiCall is willing to try again.
  // The next fetch failure will flip it back.
  markOnline();
  consecutiveTransientFailures = 0;
  await drainQueue();
}

// Test-only hook to reset module state between cases.
export function __resetOfflineQueueForTests(): void {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  queue = [];
  conflicts = [];
  loaded = false;
  loadPromise = null;
  draining = false;
  consecutiveTransientFailures = 0;
  runnerStarted = false;
  listeners.clear();
}
