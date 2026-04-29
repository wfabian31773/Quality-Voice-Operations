import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as Notifications from 'expo-notifications';
import {
  markAllRead as markAllReadFn,
  markRead as markReadFn,
  notificationFromExpo,
  shouldResetOnAuthChange,
  unreadCount,
  upsertNotification,
  type NotificationRecord,
} from '../../shared/notifications/inbox';
import {
  clearStoredNotifications,
  loadStoredNotifications,
  saveStoredNotifications,
} from '@/lib/notificationLog';
import { useAuth } from '@/hooks/useAuth';

interface NotificationLogState {
  ready: boolean;
  records: NotificationRecord[];
  unread: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => Promise<void>;
  reset: () => Promise<void>;
}

const NotificationLogContext = createContext<NotificationLogState | null>(null);

export function NotificationLogProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<NotificationRecord[]>([]);
  const [ready, setReady] = useState(false);
  const recordsRef = useRef<NotificationRecord[]>([]);
  recordsRef.current = records;

  const persist = useCallback((next: NotificationRecord[]) => {
    void saveStoredNotifications(next);
  }, []);

  const apply = useCallback(
    (next: NotificationRecord[]) => {
      recordsRef.current = next;
      setRecords(next);
      persist(next);
    },
    [persist],
  );

  // Tracks the latest auth state without re-binding the listeners every time
  // it changes. Pushes that arrive while signed out are dropped on the floor
  // so the next user signing in on this device can never see them, closing
  // the post-logout / pre-token-revocation ingestion window.
  const signedInRef = useRef(true);

  const ingest = useCallback(
    (notification: Notifications.Notification | null | undefined) => {
      if (!signedInRef.current) return;
      const record = notificationFromExpo(notification ?? undefined);
      if (!record) return;
      apply(upsertNotification(recordsRef.current, record));
    },
    [apply],
  );

  // Load persisted log on mount.
  useEffect(() => {
    let cancelled = false;
    loadStoredNotifications()
      .then((stored) => {
        if (cancelled) return;
        recordsRef.current = stored;
        setRecords(stored);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Capture every notification that arrives while the app is foregrounded
  // (banners are still shown by the global handler in `lib/push.ts`), and
  // also capture taps on background notifications so they always land in
  // the inbox even if the user never sees the foreground delivery event.
  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener(
      (notification) => ingest(notification),
    );
    const responded = Notifications.addNotificationResponseReceivedListener(
      (resp) => ingest(resp.notification),
    );
    // Drain the cold-start notification (if any) into the log so a tap that
    // launched the app from a killed state still appears in history.
    Notifications.getLastNotificationResponseAsync()
      .then((resp) => {
        if (resp) ingest(resp.notification);
      })
      .catch(() => {});
    return () => {
      received.remove();
      responded.remove();
    };
  }, [ingest]);

  const markRead = useCallback(
    (id: string) => {
      apply(markReadFn(recordsRef.current, id));
    },
    [apply],
  );

  const markAllRead = useCallback(() => {
    apply(markAllReadFn(recordsRef.current));
  }, [apply]);

  const clear = useCallback(async () => {
    apply([]);
    await clearStoredNotifications();
  }, [apply]);

  const reset = useCallback(async () => {
    // Wipe both in-memory state and persisted storage so a different user
    // signing in on the same device cannot see the previous user's alerts.
    recordsRef.current = [];
    setRecords([]);
    await clearStoredNotifications();
  }, []);

  // Reset whenever auth transitions to signed-out so a subsequent sign-in
  // (potentially as a different tenant on the same device) starts fresh.
  // Mounting `NotificationLogProvider` as a child of `AuthProvider` makes
  // `useAuth()` safe to call here. Trigger logic is in
  // `shouldResetOnAuthChange` so it can be unit tested in isolation.
  const { signedIn } = useAuth();
  const prevSignedInRef = useRef(signedIn);
  useEffect(() => {
    signedInRef.current = signedIn;
    const wasSignedIn = prevSignedInRef.current;
    prevSignedInRef.current = signedIn;
    if (shouldResetOnAuthChange(wasSignedIn, signedIn)) {
      void reset();
    }
  }, [signedIn, reset]);

  const value = useMemo<NotificationLogState>(
    () => ({
      ready,
      records,
      unread: unreadCount(records),
      markRead,
      markAllRead,
      clear,
      reset,
    }),
    [ready, records, markRead, markAllRead, clear, reset],
  );

  return (
    <NotificationLogContext.Provider value={value}>
      {children}
    </NotificationLogContext.Provider>
  );
}

export function useNotificationLog(): NotificationLogState {
  const ctx = useContext(NotificationLogContext);
  if (!ctx) {
    throw new Error(
      'useNotificationLog must be used inside NotificationLogProvider',
    );
  }
  return ctx;
}
