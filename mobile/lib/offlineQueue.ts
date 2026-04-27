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
} from './api';
import { loadStoredCredentials } from './auth';
import { markOnline, subscribeConnectivity } from './connectivity';

// Bumped from v1 because v1 used to persist `baseUrl`/`apiKey` in plaintext.
// Dropping the v1 key on disk avoids replaying any leftover entries that
// still carry credentials.
const STORAGE_KEY = 'voiceai.tech.offlineQueue.v2';
const LEGACY_STORAGE_KEYS = ['voiceai.tech.offlineQueue.v1'];
const RETRY_INTERVAL_MS = 30_000;

export type QueuedKind = 'job_transition' | 'booking_transition';

export interface QueuedItem {
  id: string;
  kind: QueuedKind;
  targetId: string;
  targetTitle: string | null;
  jobStatus?: DispatchTransition;
  jobNotes?: string | null;
  bookingAction?: BookingAction;
  bookingExtra?: { cancellation_reason?: string };
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
let drainTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: NativeEventSubscription | null = null;
let connectivitySub: (() => void) | null = null;
let queryClientRef: QueryClient | null = null;
let runnerStarted = false;

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
  if (kind !== 'job_transition' && kind !== 'booking_transition') return null;
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
    enqueuedAt: typeof r.enqueuedAt === 'number' ? r.enqueuedAt : Date.now(),
    attempts: typeof r.attempts === 'number' ? r.attempts : 0,
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
  };
  return item;
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
    (q) => q.kind === 'job_transition' && q.targetId === jobId,
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
  return item;
}

function describeAttempt(item: QueuedItem): string {
  if (item.kind === 'job_transition') return item.jobStatus ?? '';
  return item.bookingAction ?? '';
}

function invalidateForItem(item: QueuedItem) {
  if (!queryClientRef) return;
  if (item.kind === 'job_transition') {
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
  try {
    while (queue.length > 0) {
      const item = queue[0];
      item.attempts += 1;
      const result = await executeItem(item);
      if (result.ok) {
        invalidateForItem(item);
        queue.shift();
        await persistQueue();
        notify();
        processed += 1;
        continue;
      }
      if ('conflict' in result) {
        invalidateForItem(item);
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
      break;
    }
  } finally {
    draining = false;
    notify();
  }
  return {
    processed,
    conflicts: newConflicts,
    remaining: queue.length,
  };
}

export function startOfflineQueueRunner(): void {
  if (runnerStarted) return;
  runnerStarted = true;
  void loadQueue().then(() => {
    if (queue.length > 0) void drainQueue();
  });
  drainTimer = setInterval(() => {
    if (queue.length > 0 && !draining) void drainQueue();
  }, RETRY_INTERVAL_MS);
  appStateSub = AppState.addEventListener(
    'change',
    (status: AppStateStatus) => {
      if (status === 'active' && queue.length > 0 && !draining) {
        void drainQueue();
      }
    },
  );
  connectivitySub = subscribeConnectivity((online) => {
    if (online && queue.length > 0 && !draining) void drainQueue();
  });
}

export function stopOfflineQueueRunner(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
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
  await drainQueue();
}
