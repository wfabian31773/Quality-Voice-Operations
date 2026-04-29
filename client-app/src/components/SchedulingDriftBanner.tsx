import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, X } from 'lucide-react';

const SCHEDULING_PROVIDER_LABELS: Record<string, string> = {
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook Calendar',
};

function formatProvider(provider: string): string {
  return SCHEDULING_PROVIDER_LABELS[provider] ?? provider;
}

const DISMISS_KEY_PREFIX = 'qvo_scheduling_drift_banner_dismissed:';

export interface SchedulingDriftBannerProps {
  /** Number of rows (agents or phone numbers) routed to a disconnected calendar. */
  count: number;
  /** Unique list of disconnected provider identifiers across the rows. */
  disconnectedProviders: string[];
  /** Singular label for an affected row (e.g. 'agent', 'phone number'). */
  subjectSingular: string;
  /** Plural label for affected rows (e.g. 'agents', 'phone numbers'). */
  subjectPlural: string;
  /** Stable key for the dismissal storage entry (page-scoped). */
  storageKey: string;
}

export default function SchedulingDriftBanner({
  count,
  disconnectedProviders,
  subjectSingular,
  subjectPlural,
  storageKey,
}: SchedulingDriftBannerProps) {
  const navigate = useNavigate();

  const dismissKey = useMemo(() => {
    if (count === 0) return '';
    const sortedProviders = [...disconnectedProviders].sort().join(',');
    // Include the count so the banner re-surfaces when the impact grows
    // (e.g. an additional agent gets pointed at the same broken calendar).
    return `${DISMISS_KEY_PREFIX}${storageKey}:${count}:${sortedProviders}`;
  }, [count, disconnectedProviders, storageKey]);

  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!dismissKey) {
      setDismissed(false);
      return;
    }
    try {
      setDismissed(sessionStorage.getItem(dismissKey) === '1');
    } catch {
      setDismissed(false);
    }
  }, [dismissKey]);

  if (count === 0 || dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      if (dismissKey) sessionStorage.setItem(dismissKey, '1');
    } catch {
      // Ignore storage errors; the banner just reappears next page load.
    }
  };

  const handleReconnect = () => {
    if (disconnectedProviders.length === 1) {
      navigate(`/connectors?provider=${encodeURIComponent(disconnectedProviders[0])}`);
    } else {
      navigate('/connectors');
    }
  };

  const subject = count === 1 ? subjectSingular : subjectPlural;
  const verb = count === 1 ? 'is' : 'are';

  const providerNames = disconnectedProviders.map(formatProvider);
  let providerSummary = '';
  if (providerNames.length === 1) {
    providerSummary = providerNames[0];
  } else if (providerNames.length === 2) {
    providerSummary = `${providerNames[0]} and ${providerNames[1]}`;
  } else if (providerNames.length > 2) {
    providerSummary = `${providerNames.slice(0, -1).join(', ')}, and ${providerNames[providerNames.length - 1]}`;
  }

  return (
    <div
      role="alert"
      className="rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-900/20 shadow-sm"
    >
      <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
        <div className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-900/40 shrink-0">
          <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
            {count} {subject} {verb} configured to book into a disconnected calendar
          </p>
          {providerSummary && (
            <p className="text-xs text-amber-800/90 dark:text-amber-200/80 mt-0.5">
              Reconnect {providerSummary} so appointments keep syncing.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleReconnect}
          className="hidden sm:inline-flex items-center gap-1 text-xs font-medium text-amber-900 dark:text-amber-100 bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/40 dark:hover:bg-amber-900/60 px-3 py-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          Reconnect <ArrowRight className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="p-1 text-amber-700/70 hover:text-amber-900 dark:text-amber-200/70 dark:hover:text-amber-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="px-4 pb-3 sm:hidden">
        <button
          type="button"
          onClick={handleReconnect}
          className="inline-flex items-center gap-1 text-xs font-medium text-amber-900 dark:text-amber-100 bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/40 dark:hover:bg-amber-900/60 px-3 py-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          Reconnect <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
