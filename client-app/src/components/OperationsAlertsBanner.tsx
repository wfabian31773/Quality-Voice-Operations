import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertOctagon,
  ArrowRight,
  Mail,
  PhoneOff,
  TrendingDown,
  CalendarClock,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';

type BannerTone = 'critical' | 'high' | 'warning' | 'info';

interface AlertCategory {
  type: string;
  title: string;
  description: string;
  tone: BannerTone;
  icon: LucideIcon;
  /** Singular noun used in the count line — pluralized with a trailing `s`. */
  noun: string;
}

// Curated set surfaced on the dashboard; order here is the rendered order.
// Anything not listed still shows up in the Operations alerts panel itself.
const ALERT_CATEGORIES: AlertCategory[] = [
  {
    type: 'error_rate_spike',
    title: 'Call failure rate spike',
    description:
      'A meaningful share of calls in the last hour failed compared to the 7-day baseline.',
    tone: 'critical',
    icon: AlertOctagon,
    noun: 'failure-rate alert',
  },
  {
    type: 'billing_backfill_cross_day_skipped',
    title: 'Manual billing rebalance required',
    description:
      "A cross-day backfill couldn't be auto-rebalanced because old-day rollup rows were missing.",
    tone: 'critical',
    icon: Wallet,
    noun: 'manual rebalance',
  },
  {
    type: 'support_email_delivery_failed',
    title: 'Support email delivery failed',
    description:
      "An inbound support ticket couldn't be routed to its destination inbox after retries.",
    tone: 'high',
    icon: Mail,
    noun: 'undelivered support email',
  },
  {
    type: 'support_reply_delivery_failed',
    title: 'Support replies failing',
    description:
      'Outbound replies to a support ticket are failing to deliver after multiple attempts.',
    tone: 'high',
    icon: Mail,
    noun: 'failed reply',
  },
  {
    type: 'support_recipient_first_bounce',
    title: 'Support recipient bouncing',
    description:
      'A support ticket recipient bounced for the first time — verify the contact address.',
    tone: 'high',
    icon: Mail,
    noun: 'bouncing recipient',
  },
  {
    type: 'escalation_spike',
    title: 'Escalation spike detected',
    description:
      'Calls are escalating to a human at a much higher rate than the 7-day baseline.',
    tone: 'warning',
    icon: PhoneOff,
    noun: 'escalation alert',
  },
  {
    type: 'booking_rate_drop',
    title: 'Completion rate drop',
    description:
      'Calls in the last hour are completing at a much lower rate than the 7-day baseline.',
    tone: 'warning',
    icon: TrendingDown,
    noun: 'completion-rate alert',
  },
  {
    type: 'billing_backfill_cross_day',
    title: 'Billing needs verification',
    description:
      'A cross-day backfill auto-rebalanced usage between days. Verify the rebalance landed.',
    tone: 'info',
    icon: CalendarClock,
    noun: 'cross-day backfill alert',
  },
];

interface AlertSummaryResponse {
  counts: Record<string, number>;
}

const TONE_STYLES: Record<
  BannerTone,
  { wrapper: string; iconWrap: string; title: string; subtle: string; cta: string; ringFocus: string }
> = {
  critical: {
    wrapper:
      'border-red-400/50 bg-red-50 dark:bg-red-500/10 dark:border-red-500/40 hover:bg-red-100 dark:hover:bg-red-500/20',
    iconWrap: 'bg-red-200/70 dark:bg-red-500/20 text-red-700 dark:text-red-300',
    title: 'text-red-900 dark:text-red-100',
    subtle: 'text-red-800/90 dark:text-red-200/80',
    cta: 'text-red-900 dark:text-red-100',
    ringFocus: 'focus-visible:ring-red-400',
  },
  high: {
    wrapper:
      'border-red-300/50 bg-red-50/70 dark:bg-red-500/10 dark:border-red-500/30 hover:bg-red-100/70 dark:hover:bg-red-500/20',
    iconWrap: 'bg-red-200/60 dark:bg-red-500/20 text-red-700 dark:text-red-300',
    title: 'text-red-900 dark:text-red-100',
    subtle: 'text-red-800/90 dark:text-red-200/80',
    cta: 'text-red-900 dark:text-red-100',
    ringFocus: 'focus-visible:ring-red-400',
  },
  warning: {
    wrapper:
      'border-amber-400/40 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/40 hover:bg-amber-100 dark:hover:bg-amber-500/20',
    iconWrap: 'bg-amber-200/70 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300',
    title: 'text-amber-900 dark:text-amber-100',
    subtle: 'text-amber-800/90 dark:text-amber-200/80',
    cta: 'text-amber-900 dark:text-amber-100',
    ringFocus: 'focus-visible:ring-amber-400',
  },
  info: {
    wrapper:
      'border-blue-400/40 bg-blue-50 dark:bg-blue-500/10 dark:border-blue-500/40 hover:bg-blue-100 dark:hover:bg-blue-500/20',
    iconWrap: 'bg-blue-200/70 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300',
    title: 'text-blue-900 dark:text-blue-100',
    subtle: 'text-blue-800/90 dark:text-blue-200/80',
    cta: 'text-blue-900 dark:text-blue-100',
    ringFocus: 'focus-visible:ring-blue-400',
  },
};

function countLabel(count: number, noun: string): string {
  return count === 1 ? `1 unacknowledged ${noun}` : `${count} unacknowledged ${noun}s`;
}

function BannerRow({ category, count }: { category: AlertCategory; count: number }) {
  const tone = TONE_STYLES[category.tone];
  const Icon = category.icon;
  const label = countLabel(count, category.noun);
  return (
    <Link
      to={`/ops/monitor?alertType=${category.type}#alerts-panel`}
      className={`block rounded-xl focus:outline-none focus-visible:ring-2 ${tone.ringFocus}`}
      aria-label={`${category.title}: ${label}. Open Operations alerts.`}
      data-alert-type={category.type}
    >
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${tone.wrapper}`}>
        <div className={`shrink-0 p-2 rounded-lg ${tone.iconWrap}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${tone.title}`}>{category.title}</p>
          <p className={`text-xs mt-0.5 ${tone.subtle}`}>
            {label}. {category.description}
          </p>
        </div>
        <div className={`shrink-0 hidden sm:flex items-center gap-1.5 text-xs font-medium ${tone.cta}`}>
          Review in Operations
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </div>
      </div>
    </Link>
  );
}

export default function OperationsAlertsBanner() {
  const typesParam = ALERT_CATEGORIES.map((c) => c.type).join(',');
  const { data } = useQuery({
    queryKey: ['operations-alerts-summary', typesParam],
    queryFn: () =>
      api.get<AlertSummaryResponse>(
        `/operations/alerts/summary?types=${encodeURIComponent(typesParam)}`,
      ),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const counts = data?.counts ?? {};
  const visible = ALERT_CATEGORIES.filter((c) => (counts[c.type] ?? 0) > 0);

  if (visible.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="operations-alerts-banner">
      {visible.map((category) => (
        <BannerRow key={category.type} category={category} count={counts[category.type] ?? 0} />
      ))}
    </div>
  );
}

export const OPERATIONS_ALERT_CATEGORIES = ALERT_CATEGORIES;
