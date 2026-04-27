import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Sparkles, AlertTriangle, Lock } from 'lucide-react';

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
  const { data } = useQuery({
    queryKey: ['trial-status'],
    queryFn: () => api.get<TrialStatus>('/tenants/me/trial-status'),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    retry: false,
  });

  if (!data || data.onPaidPlan) return null;
  if (data.expired) {
    return (
      <>
        <div className="hidden">expired-overlay-marker</div>
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
        >
          <div className="max-w-md w-full bg-surface rounded-2xl shadow-xl p-6 text-center border border-border">
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-red-50 text-danger mb-4">
              <Lock className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-bold font-display mb-2">Your trial has ended</h2>
            <p className="text-text-secondary mb-6">
              Pick a plan to keep your agents, data, and integrations running. Your account is preserved — you just need to upgrade to continue.
            </p>
            <Link
              to="/billing"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-white font-medium hover:bg-primary-hover transition-colors w-full"
            >
              <Sparkles className="h-4 w-4" /> Choose a plan
            </Link>
          </div>
        </div>
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
              ? 'Trial expires today'
              : `${days} day${days === 1 ? '' : 's'} left in your trial`}
          </span>
        </div>
        <Link
          to="/billing"
          className="shrink-0 inline-flex items-center gap-1.5 bg-white/20 hover:bg-white/30 px-3 py-1 rounded-md text-xs font-semibold transition-colors"
        >
          Upgrade now
        </Link>
      </div>
    </div>
  );
}
