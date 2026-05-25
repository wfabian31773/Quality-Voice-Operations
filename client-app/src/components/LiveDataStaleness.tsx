import { useEffect, useState } from 'react';
import { Wifi, WifiOff, RotateCw, AlertTriangle } from 'lucide-react';
import type { SSEStatus } from '../hooks/useReconnectingSSE';

export interface LiveDataStalenessProps {
  status: SSEStatus;
  lastMessageAt: Date | null;
  retryCount: number;
  /**
   * After this many ms with no message the badge flips to "stale" even
   * if the connection is still nominally open. Default 60_000.
   *
   * For Operations.tsx (live calls feed) 60s is conservative — the
   * server pushes heartbeats/lifecycle events much more often when there
   * IS traffic, so anything older means either we're disconnected or
   * the volume has genuinely dropped. The badge errs toward disclosure.
   */
  staleAfterMs?: number;
  /**
   * Manual reconnect handle from useReconnectingSSE. Surfaced as a
   * button when the connection is closed/reconnecting or the data is
   * stale, so the operator can force-retry instead of waiting for the
   * next backoff window.
   */
  onReconnect?: () => void;
  className?: string;
}

/**
 * Visual disclosure of live-data connection health.
 *
 * Before this existed (per docs/CONSOLE_REDESIGN_PLAN.md §3.3), Operations
 * showed a binary "Live" / "Connecting…" pill that lied during reconnect:
 * `activeCalls` held the last snapshot indefinitely, the badge flickered
 * once on error, and there was no indication that the on-screen numbers
 * might be stale.
 *
 * This component pulls the truth from useReconnectingSSE's status +
 * lastMessageAt + retryCount and shows:
 *   - "Live" (green dot)             when status=open and recent
 *   - "Stale (N min ago)" (amber)    when status=open but lastMessageAt is old
 *   - "Reconnecting (attempt N)"     when the backoff loop is running
 *   - "Offline" (red, with retry)    when status=closed
 */
export function LiveDataStaleness({
  status,
  lastMessageAt,
  retryCount,
  staleAfterMs = 60_000,
  onReconnect,
  className,
}: LiveDataStalenessProps) {
  // Re-render every 5s so the "Xs ago" caption stays current without
  // requiring the parent component to tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const ageMs = lastMessageAt ? now - lastMessageAt.getTime() : null;
  const isStale = ageMs !== null && ageMs > staleAfterMs;

  const base = 'inline-flex items-center gap-1.5 text-xs';
  const wrapper = className ? `${base} ${className}` : base;

  if (status === 'open' && !isStale) {
    return (
      <span className={wrapper} aria-label="Live data feed connected" role="status">
        <Wifi className="h-3.5 w-3.5 text-success" aria-hidden="true" />
        <span className="text-success font-medium">Live</span>
      </span>
    );
  }

  if (status === 'open' && isStale) {
    return (
      <span
        className={wrapper}
        aria-label={`Live data feed is connected but stale${
          ageMs !== null ? `; last update ${formatAge(ageMs)} ago` : ''
        }`}
        role="status"
      >
        <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
        <span className="text-warning font-medium">
          Stale{ageMs !== null ? ` · ${formatAge(ageMs)} ago` : ''}
        </span>
        {onReconnect && (
          <button
            type="button"
            onClick={onReconnect}
            className="ml-1 text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
          >
            Retry
          </button>
        )}
      </span>
    );
  }

  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <span
        className={wrapper}
        aria-label={`Live data feed reconnecting${
          retryCount > 0 ? `; attempt ${retryCount}` : ''
        }`}
        role="status"
        aria-live="polite"
      >
        <RotateCw className="h-3.5 w-3.5 text-warning animate-spin" aria-hidden="true" />
        <span className="text-warning font-medium">
          Reconnecting{retryCount > 0 ? ` · attempt ${retryCount}` : '…'}
        </span>
      </span>
    );
  }

  // status === 'closed'
  return (
    <span
      className={wrapper}
      aria-label="Live data feed offline"
      role="status"
      aria-live="polite"
    >
      <WifiOff className="h-3.5 w-3.5 text-danger" aria-hidden="true" />
      <span className="text-danger font-medium">Offline</span>
      {onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="ml-1 text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
        >
          Retry
        </button>
      )}
    </span>
  );
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

export default LiveDataStaleness;
