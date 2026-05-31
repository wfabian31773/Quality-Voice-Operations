import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { Sparkles, AlertTriangle, Lock } from 'lucide-react';
import Modal from './Modal';

interface TrialStatus {
  onTrial: boolean;
  onPaidPlan: boolean;
  expired: boolean;
  daysRemaining: number | null;
  trialExpiresAt: string | null;
  plan: string;
  status: string;
}

export default function TrialBanner() {
  const { t } = useTranslation('tenant');
  // Trial status changes on the order of days (countdown decrements once per
  // day, expiration is a single transition). There is no useful signal in
  // re-fetching this every few minutes, and TrialBanner is mounted on every
  // tenant page so any extra refetch fans out across the whole portal. Keep
  // the data fresh for 30 minutes and disable every implicit refetch — the
  // billing flow explicitly invalidates ['trial-status'] when the tenant
  // upgrades or their plan changes.
  const { data } = useQuery({
    queryKey: ['trial-status'],
    queryFn: () => api.get<TrialStatus>('/tenants/me/trial-status'),
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    retry: false,
  });

  if (!data || data.onPaidPlan) return null;
  if (data.expired) {
    // The trial-expired modal is a hard block: the only path forward is to
    // upgrade. ESC and backdrop clicks intentionally do nothing so the user
    // cannot dismiss it, but Modal still gives us focus trapping, focus
    // restoration, scroll lock, and ARIA dialog semantics for keyboard and
    // screen-reader users.
    return (
      <>
        <div className="hidden">expired-overlay-marker</div>
        <Modal
          open
          onClose={() => {}}
          ariaLabel={t('trial_banner.expired_aria')}
          closeOnBackdrop={false}
          containerClassName="fixed inset-0 z-paywall flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          panelClassName="relative max-w-md w-full bg-surface rounded-2xl shadow-xl p-6 text-center border border-border"
        >
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-danger-light text-danger mb-4">
            <Lock className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-bold font-display mb-2">{t('trial_banner.expired_title')}</h2>
          <p className="text-text-secondary mb-6">
            {t('trial_banner.expired_description')}
          </p>
          <Link
            to="/billing"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-white font-medium hover:bg-primary-hover transition-colors w-full"
          >
            <Sparkles className="h-4 w-4" /> {t('trial_banner.choose_plan')}
          </Link>
        </Modal>
      </>
    );
  }

  if (!data.onTrial) return null;

  const days = data.daysRemaining ?? 0;
  const urgent = days <= 7;
  const veryUrgent = days <= 3;

  const bg = veryUrgent
    ? 'bg-danger text-white'
    : urgent
    ? 'bg-warning text-white'
    : 'bg-primary text-white';

  return (
    <div className={`${bg} print:hidden`}>
      <div className="px-4 lg:px-8 py-2 flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          {urgent ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <Sparkles className="h-4 w-4 shrink-0" />}
          <span className="truncate font-medium">
            {days === 0
              ? t('trial_banner.expires_today')
              : t('trial_banner.days_left', { count: days })}
          </span>
        </div>
        <Link
          to="/billing"
          className="shrink-0 inline-flex items-center gap-1.5 bg-white/20 dark:bg-white/20 hover:bg-white/30 dark:hover:bg-white/30 px-3 py-1 rounded-md text-xs font-semibold transition-colors"
        >
          {t('trial_banner.upgrade_now')}
        </Link>
      </div>
    </div>
  );
}
