import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  count: number;
  disconnectedProviders: string[];
  subjectSingular: string;
  subjectPlural: string;
  storageKey: string;
}

export default function SchedulingDriftBanner({
  count,
  disconnectedProviders,
  subjectSingular,
  subjectPlural,
  storageKey,
}: SchedulingDriftBannerProps) {
  const { t } = useTranslation('tenant');
  const navigate = useNavigate();

  const dismissKey = useMemo(() => {
    if (count === 0) return '';
    const sortedProviders = [...disconnectedProviders].sort().join(',');
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

  const providerNames = disconnectedProviders.map(formatProvider);
  let providerSummary = '';
  if (providerNames.length === 1) {
    providerSummary = providerNames[0];
  } else if (providerNames.length === 2) {
    providerSummary = t('scheduling_drift_banner.provider_join_two', {
      a: providerNames[0],
      b: providerNames[1],
    });
  } else if (providerNames.length > 2) {
    providerSummary = t('scheduling_drift_banner.provider_join_many', {
      list: providerNames.slice(0, -1).join(', '),
      last: providerNames[providerNames.length - 1],
    });
  }

  return (
    <div
      role="alert"
      className="rounded-xl border border-warning bg-warning-light dark:border-warning dark:bg-warning shadow-sm"
    >
      <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
        <div className="p-1.5 rounded-lg bg-warning-light dark:bg-warning shrink-0">
          <AlertTriangle className="h-4 w-4 text-warning dark:text-warning" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-warning dark:text-warning">
            {t('scheduling_drift_banner.title', { count, subject })}
          </p>
          {providerSummary && (
            <p className="text-xs text-warning dark:text-warning mt-0.5">
              {t('scheduling_drift_banner.reconnect_summary', { providers: providerSummary })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleReconnect}
          className="hidden sm:inline-flex items-center gap-1 text-xs font-medium text-warning dark:text-warning bg-warning-light hover:bg-warning-light dark:bg-warning dark:hover:bg-warning px-3 py-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-warning"
        >
          {t('scheduling_drift_banner.reconnect')} <ArrowRight className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('scheduling_drift_banner.dismiss')}
          className="p-1 text-warning hover:text-warning dark:text-warning dark:hover:text-warning transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-warning rounded"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="px-4 pb-3 sm:hidden">
        <button
          type="button"
          onClick={handleReconnect}
          className="inline-flex items-center gap-1 text-xs font-medium text-warning dark:text-warning bg-warning-light hover:bg-warning-light dark:bg-warning dark:hover:bg-warning px-3 py-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-warning"
        >
          {t('scheduling_drift_banner.reconnect')} <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
