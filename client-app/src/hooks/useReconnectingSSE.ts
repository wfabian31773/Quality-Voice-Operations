import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Exponential backoff schedule used after onerror. Mirrors the one in
 * useDemoSSE.ts — we cap at 30s because beyond that the user is better
 * off seeing an "Offline" badge and reconnecting manually than waiting
 * silently for another doubling.
 *
 * The browser's native EventSource also auto-reconnects, but at a fixed
 * ~3s interval with no exposed retry counter. Explicit backoff via close
 * + reopen lets us:
 *   - surface a "reconnecting (attempt N)" state to the UI
 *   - stop hammering the server during a prolonged outage
 *   - expose a manual reconnect handle so the operator can force-retry
 */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export type SSEStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseReconnectingSSEOptions {
  /**
   * The SSE URL to connect to. Pass `null` to pause/disconnect — useful
   * when the consumer hasn't selected a target yet (e.g. no callId).
   * Changing the URL closes the existing connection and opens a new one.
   */
  url: string | null;
  withCredentials?: boolean;
  /**
   * Event listeners keyed by event name. The hook wraps each invocation
   * in a try/catch and logs failures via console.error — no more silent
   * `catch {}` swallows like the old useCallSSE.
   *
   * The hook stores the latest listener map in a ref so changes don't
   * re-establish the EventSource. Consumers should still memoize listener
   * objects to avoid unnecessary re-renders of LiveDataStaleness, but
   * forgetting to do so won't tear down the stream.
   */
  listeners: Record<string, (event: MessageEvent) => void>;
  /**
   * Identity label used in console.error messages so operators can tell
   * which SSE feed is failing when multiple are mounted (Operations has
   * both an active-calls feed and a per-call feed).
   */
  label?: string;
}

export interface UseReconnectingSSEResult {
  status: SSEStatus;
  /** Date of the most recent message of any kind (including onopen). */
  lastMessageAt: Date | null;
  /** Attempt counter — 0 while connected, increments on each reconnect. */
  retryCount: number;
  /** Force-close and re-open the connection. Resets retryCount to 0. */
  reconnect: () => void;
}

export function useReconnectingSSE({
  url,
  withCredentials = true,
  listeners,
  label = 'SSE',
}: UseReconnectingSSEOptions): UseReconnectingSSEResult {
  const [status, setStatus] = useState<SSEStatus>(url ? 'connecting' : 'closed');
  const [lastMessageAt, setLastMessageAt] = useState<Date | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest listener map. Stored in a ref so consumers can pass an object
  // literal without thrashing the EventSource lifecycle on every render.
  const listenersRef = useRef(listeners);
  listenersRef.current = listeners;
  // Manual reconnect trigger. Bumping this resets retryCount and forces
  // the connect effect to tear down and re-establish.
  const [manualKick, setManualKick] = useState(0);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearReconnectTimer();

    if (!url) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setStatus('closed');
      return;
    }

    // Local mutable attempt counter for THIS effect run. We can't rely
    // on `retryCount` state inside the closure because the effect would
    // re-run on every retry, which is the opposite of what we want
    // (each effect run owns one EventSource; reconnects happen inside).
    let attempt = 0;
    let cancelled = false;

    const open = () => {
      if (cancelled) return;

      const es = new EventSource(url, { withCredentials });
      esRef.current = es;
      setStatus('connecting');

      // Register a single proxy handler that fans out to the
      // consumer's listener map. We can't use `Object.entries(listeners)
      // .forEach(addEventListener)` because the map identity may change
      // between renders — the ref read keeps listeners current without
      // re-binding.
      const handle = (eventName: string) => (event: MessageEvent) => {
        setLastMessageAt(new Date());
        const fn = listenersRef.current[eventName];
        if (!fn) return;
        try {
          fn(event);
        } catch (err) {
          // Loud catch on purpose — the old useCallSSE silently swallowed
          // every parse error per the audit (plan §3.4). If a handler
          // throws, we want to see it in the console so we can debug.
          console.error(`[${label}] listener for "${eventName}" threw`, err);
        }
      };

      // Bind every event name from the listener map at the time of
      // (re)connect. Future changes to the map (between connect cycles)
      // are read via listenersRef — but newly-added EVENT NAMES require
      // a reconnect to be observed, because addEventListener is called
      // exactly once per name per connection. In practice consumers
      // declare the event-name set up front, so this is fine.
      for (const eventName of Object.keys(listenersRef.current)) {
        es.addEventListener(eventName, handle(eventName));
      }

      es.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setRetryCount(0);
        setStatus('open');
        setLastMessageAt(new Date());
      };

      es.onerror = () => {
        if (cancelled) return;

        // EventSource also fires onerror as part of its native reconnect
        // dance. We only treat this as a real failure if the socket is
        // closed (readyState 2) or stuck in CONNECTING long enough for
        // our backoff to kick in.
        if (es.readyState === EventSource.CLOSED) {
          // Server closed us out — give up native retry and schedule
          // our own with backoff.
          scheduleReconnect();
        } else if (es.readyState === EventSource.CONNECTING) {
          // Mid native retry. Surface it so the badge can show
          // "Reconnecting" but don't tear down — native retry may
          // succeed shortly. If it doesn't, the next onerror with
          // CLOSED will trigger the backoff.
          setStatus('reconnecting');
        }
      };
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimerRef.current) return;

      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      setStatus('reconnecting');
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt += 1;
      setRetryCount(attempt);

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!cancelled) open();
      }, delay);
    };

    open();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
    // `manualKick` is a dependency so reconnect() can force a fresh effect run.
    // listeners is intentionally NOT a dependency — see listenersRef comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, withCredentials, label, manualKick, clearReconnectTimer]);

  const reconnect = useCallback(() => {
    setRetryCount(0);
    setManualKick((k) => k + 1);
  }, []);

  return { status, lastMessageAt, retryCount, reconnect };
}
