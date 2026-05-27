import { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X, ArrowRight } from 'lucide-react';
import { api } from '../lib/api';

interface Connector {
  integrationId: string;
  provider: string;
  name: string;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

const AUTH_ERROR_REGEX = /\b(401|403|unauthorized|forbidden|invalid[_ -]?(grant|token|credential|auth)|expired|refresh.*(failed|token)|token.*expired|auth(entication)?[ _-]?(failed|error)|missing.*(token|credential)|not_authed|token_revoked|account_inactive)\b/i;

function isAuthError(message: string | null | undefined): boolean {
  if (!message) return false;
  return AUTH_ERROR_REGEX.test(message);
}

const DISMISS_KEY_PREFIX = 'qvo_connector_auth_banner_dismissed:';

export default function ConnectorAuthBanner() {
  const { t } = useTranslation('tenant');
  const { data } = useQuery({
    queryKey: ['connectors', 'auth-banner'],
    queryFn: () => api.get<{ connectors: Connector[]; total: number }>('/connectors?limit=100'),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });

  const failing = useMemo(() => {
    const list = data?.connectors ?? [];
    return list.filter((c) => {
      if (c.lastSyncStatus === 'needs_reconnect') return true;
      if (c.lastSyncStatus === 'error' && isAuthError(c.lastSyncError)) return true;
      return false;
    });
  }, [data]);

  const dismissKey = useMemo(() => {
    if (failing.length === 0) return '';
    const ids = failing.map((c) => c.integrationId).sort().join(',');
    return `${DISMISS_KEY_PREFIX}${ids}`;
  }, [failing]);

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

  if (failing.length === 0 || dismissed) return null;

  const names = failing.map((c) => c.name || c.provider);
  let nameSummary: string;
  if (names.length === 1) nameSummary = names[0];
  else if (names.length === 2) nameSummary = t('connector_auth_banner.join_two', { a: names[0], b: names[1] });
  else nameSummary = t('connector_auth_banner.join_many', { list: names.slice(0, -1).join(', '), last: names[names.length - 1] });

  const handleDismiss = () => {
    setDismissed(true);
    try {
      if (dismissKey) sessionStorage.setItem(dismissKey, '1');
    } catch {}
  };

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
            {t('connector_auth_banner.needs_reconnect', { count: failing.length })}
          </p>
          <p className="text-xs text-warning dark:text-warning mt-0.5">
            {t('connector_auth_banner.description', { names: nameSummary })}
          </p>
        </div>
        <Link
          to="/connectors"
          className="hidden sm:inline-flex items-center gap-1 text-xs font-medium text-warning dark:text-warning bg-warning-light hover:bg-warning-light dark:bg-warning dark:hover:bg-warning px-3 py-1.5 rounded-lg transition-colors"
        >
          {t('connector_auth_banner.fix_now')} <ArrowRight className="h-3 w-3" />
        </Link>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('connector_auth_banner.dismiss')}
          className="p-1 text-warning hover:text-warning dark:text-warning dark:hover:text-warning transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="px-4 pb-3 sm:hidden">
        <Link
          to="/connectors"
          className="inline-flex items-center gap-1 text-xs font-medium text-warning dark:text-warning bg-warning-light hover:bg-warning-light dark:bg-warning dark:hover:bg-warning px-3 py-1.5 rounded-lg transition-colors"
        >
          {t('connector_auth_banner.fix_now')} <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
