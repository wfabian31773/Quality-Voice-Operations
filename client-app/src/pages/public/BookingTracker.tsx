import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

interface TrackerJob {
  title: string | null;
  status: string;
  address: string | null;
  scheduled_at: string | null;
  eta_start: string | null;
  eta_end: string | null;
  completed_at: string | null;
  resource_name: string | null;
}

interface TrackerLiveEta {
  minutes: number;
  arrival_at: string;
}

interface TrackerResponse {
  job: TrackerJob;
  live_eta: TrackerLiveEta | null;
  poll_interval_ms: number;
  now: string;
}

const DEFAULT_POLL_MS = 30_000;

const STATUS_LABELS: Record<string, { headline: string; subline: string }> = {
  pending: {
    headline: 'Your appointment is booked',
    subline: "We'll text you again as soon as your tech is on the way.",
  },
  assigned: {
    headline: 'Your tech is assigned',
    subline: "We'll let you know when they're heading your way.",
  },
  scheduled: {
    headline: 'Your visit is scheduled',
    subline: 'You can come back to this page on the day of your visit for a live ETA.',
  },
  en_route: {
    headline: 'Your tech is on the way',
    subline: 'This page updates automatically while they drive to you.',
  },
  on_site: {
    headline: 'Your tech has arrived',
    subline: 'They should be at your door now.',
  },
  in_progress: {
    headline: 'Visit in progress',
    subline: "We'll update this page when the visit wraps up.",
  },
  completed: {
    headline: 'Visit complete',
    subline: 'Thanks for choosing us. A receipt or summary may follow by email.',
  },
  done: {
    headline: 'Visit complete',
    subline: 'Thanks for choosing us. A receipt or summary may follow by email.',
  },
  cancelled: {
    headline: 'This visit was cancelled',
    subline: 'If this is unexpected, please reply to your last text from us.',
  },
};

function formatScheduled(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function BookingTracker() {
  const { token } = useParams<{ token: string }>();
  // Tracks whether we have *ever* loaded the page successfully so we
  // can hide the spinner once we have data, even if a later poll
  // briefly fails. This is what keeps the UI from flickering between
  // "loading" and "loaded" while polling.
  const [data, setData] = useState<TrackerResponse | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const pollMsRef = useRef<number>(DEFAULT_POLL_MS);
  // Mirror the latest payload into a ref so the polling loop (which
  // closes over the initial render's `data`) can read the current
  // status to decide whether to stop polling on a terminal state.
  const latestRef = useRef<TrackerResponse | null>(null);

  useEffect(() => {
    if (!token) {
      setNotFound(true);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      try {
        const res = await fetch(`/api/public/dispatch/track/${encodeURIComponent(token!)}`, {
          credentials: 'omit',
        });
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) {
          // For non-fatal failures while polling, hold the previous
          // payload on screen rather than swapping in an error toast.
          // The customer is staring at this page on a phone — flicker
          // is more confusing than a slightly stale ETA.
          if (latestRef.current === null) {
            setInitialError(`We couldn't load your tracking page (status ${res.status}).`);
          }
        } else {
          const body = (await res.json()) as TrackerResponse;
          if (cancelled) return;
          latestRef.current = body;
          setData(body);
          setInitialError(null);
          // Honor the server-suggested cadence so we can dial it up or
          // down centrally without shipping a new client.
          if (Number.isFinite(body.poll_interval_ms) && body.poll_interval_ms >= 5_000) {
            pollMsRef.current = body.poll_interval_ms;
          }
        }
      } catch {
        if (!cancelled && latestRef.current === null) {
          setInitialError("We couldn't reach the tracking service. Trying again shortly…");
        }
      } finally {
        if (!cancelled) {
          // Only keep polling while the job is in a state that can
          // change soon. Once it's terminal (completed/cancelled),
          // stop hitting the server.
          const status = latestRef.current?.job.status ?? '';
          const terminal = status === 'completed' || status === 'done' || status === 'cancelled';
          if (!terminal) {
            timer = setTimeout(load, pollMsRef.current);
          }
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // We intentionally do NOT depend on `data` here — re-running the
    // effect on every poll would cancel the in-flight timer and double
    // the request rate. Using a ref-driven loop keeps the cadence
    // stable for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (notFound) {
    return (
      <TrackerShell>
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
            Tracking link not found
          </h1>
          <p className="text-gray-600 dark:text-gray-300">
            This link may have expired. Please check the latest text message from your service
            provider.
          </p>
        </div>
      </TrackerShell>
    );
  }

  if (!data) {
    return (
      <TrackerShell>
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-300">
            {initialError ?? 'Loading your visit details…'}
          </p>
        </div>
      </TrackerShell>
    );
  }

  const { job, live_eta } = data;
  const labels = STATUS_LABELS[job.status] ?? STATUS_LABELS.scheduled;
  const scheduledLabel = formatScheduled(job.scheduled_at);
  const isEnRoute = job.status === 'en_route';

  return (
    <TrackerShell>
      <div className="space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">
            Live status
          </p>
          <h1 className="text-2xl sm:text-3xl font-semibold text-gray-900 dark:text-white">
            {labels.headline}
          </h1>
          <p className="text-gray-600 dark:text-gray-300 mt-2">{labels.subline}</p>
        </div>

        {isEnRoute && (
          <div
            data-testid="live-eta"
            className="rounded-2xl border border-primary/20 bg-primary/5 p-5"
          >
            {live_eta ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  Your tech is{' '}
                  <span className="font-semibold text-gray-900 dark:text-white">
                    ~{live_eta.minutes} min
                  </span>{' '}
                  away
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Arriving around{' '}
                  <span className="font-semibold text-gray-900 dark:text-white">
                    {formatTimeOfDay(live_eta.arrival_at)}
                  </span>
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-200" data-testid="live-eta-pending">
                Your tech is on the way. We'll show a live ETA here as soon as their truck
                checks in.
              </p>
            )}
          </div>
        )}

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          {job.title && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Visit
              </dt>
              <dd className="mt-1 text-gray-900 dark:text-white">{job.title}</dd>
            </div>
          )}
          {scheduledLabel && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Scheduled
              </dt>
              <dd className="mt-1 text-gray-900 dark:text-white">{scheduledLabel}</dd>
            </div>
          )}
          {job.address && (
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Address
              </dt>
              <dd className="mt-1 text-gray-900 dark:text-white">{job.address}</dd>
            </div>
          )}
          {job.resource_name && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Tech
              </dt>
              <dd className="mt-1 text-gray-900 dark:text-white">{job.resource_name}</dd>
            </div>
          )}
        </dl>
      </div>
    </TrackerShell>
  );
}

function TrackerShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4 py-10">
      <div className="max-w-lg w-full bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6 sm:p-8">
        {children}
      </div>
    </div>
  );
}
