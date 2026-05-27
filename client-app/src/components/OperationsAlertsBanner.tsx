import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  tone: BannerTone;
  icon: LucideIcon;
}

// Curated set surfaced on the dashboard; order here is the rendered order.
// Anything not listed still shows up in the Operations alerts panel itself.
const ALERT_CATEGORIES: AlertCategory[] = [
  { type: 'error_rate_spike', tone: 'critical', icon: AlertOctagon },
  { type: 'billing_backfill_cross_day_skipped', tone: 'critical', icon: Wallet },
  { type: 'support_email_delivery_failed', tone: 'high', icon: Mail },
  { type: 'support_reply_delivery_failed', tone: 'high', icon: Mail },
  { type: 'support_recipient_first_bounce', tone: 'high', icon: Mail },
  { type: 'escalation_spike', tone: 'warning', icon: PhoneOff },
  { type: 'booking_rate_drop', tone: 'warning', icon: TrendingDown },
  { type: 'billing_backfill_cross_day', tone: 'info', icon: CalendarClock },
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
      'border-danger bg-danger-light dark:bg-danger dark:border-danger hover:bg-danger-light dark:hover:bg-danger',
    iconWrap: 'bg-danger-light dark:bg-danger text-danger dark:text-danger',
    title: 'text-danger dark:text-danger',
    subtle: 'text-danger dark:text-danger',
    cta: 'text-danger dark:text-danger',
    ringFocus: 'focus-visible:ring-danger',
  },
  high: {
    wrapper:
      'border-danger bg-danger-light dark:bg-danger dark:border-danger hover:bg-danger-light dark:hover:bg-danger',
    iconWrap: 'bg-danger-light dark:bg-danger text-danger dark:text-danger',
    title: 'text-danger dark:text-danger',
    subtle: 'text-danger dark:text-danger',
    cta: 'text-danger dark:text-danger',
    ringFocus: 'focus-visible:ring-danger',
  },
  warning: {
    wrapper:
      'border-warning bg-warning-light dark:bg-warning dark:border-warning hover:bg-warning-light dark:hover:bg-warning',
    iconWrap: 'bg-warning-light dark:bg-warning text-warning dark:text-warning',
    title: 'text-warning dark:text-warning',
    subtle: 'text-warning dark:text-warning',
    cta: 'text-warning dark:text-warning',
    ringFocus: 'focus-visible:ring-warning',
  },
  info: {
    wrapper:
      'border-info bg-info-light dark:bg-info dark:border-info hover:bg-info-light dark:hover:bg-info',
    iconWrap: 'bg-info-light dark:bg-info text-info dark:text-info',
    title: 'text-info dark:text-info',
    subtle: 'text-info dark:text-info',
    cta: 'text-info dark:text-info',
    ringFocus: 'focus-visible:ring-info',
  },
};

function BannerRow({ category, count }: { category: AlertCategory; count: number }) {
  const { t } = useTranslation('tenant');
  const tone = TONE_STYLES[category.tone];
  const Icon = category.icon;
  const noun = t(`operations_alerts_banner.categories.${category.type}.noun`, { count });
  const label = t('operations_alerts_banner.unack', { count, noun });
  const title = t(`operations_alerts_banner.categories.${category.type}.title`);
  const description = t(`operations_alerts_banner.categories.${category.type}.description`);
  return (
    <Link
      to={`/ops/monitor?alertType=${category.type}#alerts-panel`}
      className={`block rounded-xl focus:outline-none focus-visible:ring-2 ${tone.ringFocus}`}
      aria-label={t('operations_alerts_banner.alert_aria', { title, label })}
      data-alert-type={category.type}
    >
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${tone.wrapper}`}>
        <div className={`shrink-0 p-2 rounded-lg ${tone.iconWrap}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${tone.title}`}>{title}</p>
          <p className={`text-xs mt-0.5 ${tone.subtle}`}>
            {label}. {description}
          </p>
        </div>
        <div className={`shrink-0 hidden sm:flex items-center gap-1.5 text-xs font-medium ${tone.cta}`}>
          {t('operations_alerts_banner.review_in_operations')}
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
