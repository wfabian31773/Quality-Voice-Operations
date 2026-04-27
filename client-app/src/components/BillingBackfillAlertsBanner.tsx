import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { api } from '../lib/api';

interface OperationsAlertsResponse {
  alerts: Array<{ id: string; type: string; acknowledged: boolean }>;
  // Server-side count, scoped to the same `type=` filter as the request, so
  // we can trust it as a true total rather than counting client-side rows
  // (which would be capped by the listing `limit`).
  unacknowledgedCount: number;
}

const BILLING_BACKFILL_TYPE = 'billing_backfill_cross_day';

export default function BillingBackfillAlertsBanner() {
  const { data } = useQuery({
    queryKey: ['billing-backfill-alerts-banner'],
    queryFn: () =>
      api.get<OperationsAlertsResponse>(
        `/operations/alerts?acknowledged=false&type=${BILLING_BACKFILL_TYPE}&limit=1`,
      ),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const count = data?.unacknowledgedCount ?? 0;

  if (count === 0) return null;

  const label =
    count === 1
      ? '1 unacknowledged cross-day backfill alert'
      : `${count} unacknowledged cross-day backfill alerts`;

  return (
    <Link
      to={`/ops/monitor?alertType=${BILLING_BACKFILL_TYPE}#alerts-panel`}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded-xl"
      aria-label={`Billing needs attention: ${label}. Open Operations alerts.`}
    >
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-400/40 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/40 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors">
        <div className="shrink-0 p-2 rounded-lg bg-amber-200/70 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            Billing needs attention
          </p>
          <p className="text-xs text-amber-800/90 dark:text-amber-200/80 mt-0.5">
            {label}. Cross-day backfills can shift charges to a different billing day.
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-100">
          Review in Operations
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </div>
      </div>
    </Link>
  );
}
