import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, X, Check, Trash2, AlertCircle, CreditCard, MessageSquare, PhoneCall, Megaphone, Wrench, Settings as SettingsIcon, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { Link } from 'react-router-dom';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown> & { link?: string };
  read: boolean;
  created_at: string;
}

interface TypeMeta {
  icon: typeof Bell;
  color: string;
  labelKey: string;
}

const TYPE_META: Record<string, TypeMeta> = {
  escalation: { icon: AlertCircle, color: 'text-danger bg-red-50 dark:bg-red-500/15', labelKey: 'label_escalations' },
  billing: { icon: CreditCard, color: 'text-warning bg-amber-50 dark:bg-amber-500/15', labelKey: 'label_billing' },
  call: { icon: PhoneCall, color: 'text-primary bg-primary-light', labelKey: 'label_calls' },
  sms: { icon: MessageSquare, color: 'text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-500/15', labelKey: 'label_sms' },
  campaign: { icon: Megaphone, color: 'text-purple-600 dark:text-purple-300 bg-purple-50 dark:bg-purple-500/15', labelKey: 'label_campaigns' },
  integration: { icon: Wrench, color: 'text-orange-600 dark:text-orange-300 bg-orange-50 dark:bg-orange-500/15', labelKey: 'label_integrations' },
  integration_sms: { icon: Wrench, color: 'text-orange-600 dark:text-orange-300 bg-orange-50 dark:bg-orange-500/15', labelKey: 'label_integrations' },
  integration_recovery: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/15', labelKey: 'label_integrations' },
};

const FILTERS = ['all', 'escalation', 'billing', 'integration'] as const;
type Filter = typeof FILTERS[number];

function metaFor(type: string): TypeMeta {
  return TYPE_META[type] ?? { icon: Bell, color: 'text-text-secondary bg-surface-hover', labelKey: 'label_updates' };
}

export default function NotificationsCenter() {
  const { t } = useTranslation('tenant');
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const timeAgo = (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return t('notifications_center.time_just_now');
    if (m < 60) return t('notifications_center.time_minutes_ago', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('notifications_center.time_hours_ago', { n: h });
    const d = Math.floor(h / 24);
    return t('notifications_center.time_days_ago', { n: d });
  };

  const { data: countData } = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: () => api.get<{ count: number }>('/platform/notifications/unread-count'),
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: listData, isLoading } = useQuery({
    queryKey: ['notifications-list', open],
    queryFn: () => api.get<{ notifications: Notification[] }>('/platform/notifications'),
    enabled: open,
    retry: false,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.patch(`/platform/notifications/${id}/read`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications-unread'] });
      qc.invalidateQueries({ queryKey: ['notifications-list'] });
    },
  });

  const readAll = useMutation({
    mutationFn: () => api.post('/platform/notifications/read-all'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications-unread'] });
      qc.invalidateQueries({ queryKey: ['notifications-list'] });
    },
  });

  const clearAll = useMutation({
    mutationFn: () => api.delete('/platform/notifications'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications-unread'] });
      qc.invalidateQueries({ queryKey: ['notifications-list'] });
    },
  });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [open]);

  const count = countData?.count ?? 0;
  const all = listData?.notifications ?? [];
  const filtered =
    filter === 'all'
      ? all
      : all.filter((n) =>
          filter === 'integration'
            ? n.type === 'integration' || n.type.startsWith('integration_')
            : n.type === filter,
        );

  return (
    <div className="relative print:hidden" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 rounded-lg hover:bg-surface-hover transition-colors text-text-secondary"
        aria-label={
          count > 0
            ? t('notifications_center.aria_unread_count', { count })
            : t('notifications_center.aria_no_unread')
        }
        title={
          count > 0
            ? t('notifications_center.tooltip_unread', { count })
            : t('notifications_center.tooltip_no_unread')
        }
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {count > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center"
            aria-hidden="true"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[360px] max-w-[calc(100vw-2rem)] bg-surface border border-border rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h3 className="font-semibold text-sm">{t('notifications_center.title')}</h3>
            <div className="flex items-center gap-1">
              <Link
                to="/settings/notifications"
                onClick={() => setOpen(false)}
                className="text-text-muted hover:text-text-primary p-1 rounded"
                aria-label={t('notifications_center.preferences_aria')}
                title={t('notifications_center.preferences_aria')}
              >
                <SettingsIcon className="h-4 w-4" />
              </Link>
              <button
                onClick={() => setOpen(false)}
                className="text-text-muted hover:text-text-primary p-1 rounded"
                aria-label={t('notifications_center.close_aria')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="px-3 py-2 border-b border-border flex items-center gap-1 overflow-x-auto">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  filter === f
                    ? 'bg-primary text-white'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                {f === 'all' ? t('notifications_center.filter_all') : t(`notifications_center.${metaFor(f).labelKey}`)}
              </button>
            ))}
          </div>

          <div className="max-h-[400px] overflow-y-auto">
            {isLoading && (
              <div className="p-6 text-center text-sm text-text-muted">{t('notifications_center.loading')}</div>
            )}
            {!isLoading && filtered.length === 0 && (
              <div className="p-8 text-center">
                <Bell className="h-8 w-8 mx-auto text-text-muted mb-2" />
                <p className="text-sm text-text-secondary">{t('notifications_center.all_caught_up')}</p>
              </div>
            )}
            {filtered.map((n) => {
              const m = metaFor(n.type);
              const Icon = m.icon;
              const link = (n.metadata?.link as string | undefined) ?? null;
              const inner = (
                <div
                  className={`flex items-start gap-3 px-4 py-3 border-b border-border last:border-b-0 hover:bg-surface-hover transition-colors ${
                    n.read ? '' : 'bg-primary-light/40'
                  }`}
                >
                  <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${m.color}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-text-primary">{n.title}</p>
                      <span className="text-[10px] text-text-muted shrink-0">{timeAgo(n.created_at)}</span>
                    </div>
                    <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{n.message}</p>
                  </div>
                  {!n.read && (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        markRead.mutate(n.id);
                      }}
                      className="text-text-muted hover:text-primary p-1"
                      aria-label={t('notifications_center.mark_as_read_aria')}
                      title={t('notifications_center.mark_as_read_aria')}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
              return link ? (
                <Link
                  key={n.id}
                  to={link}
                  onClick={() => {
                    if (!n.read) markRead.mutate(n.id);
                    setOpen(false);
                  }}
                >
                  {inner}
                </Link>
              ) : (
                <div key={n.id}>{inner}</div>
              );
            })}
          </div>

          <div className="px-3 py-2 border-t border-border flex items-center justify-between text-xs">
            <button
              onClick={() => readAll.mutate()}
              disabled={count === 0 || readAll.isPending}
              className="text-text-secondary hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              {t('notifications_center.mark_all_read')}
            </button>
            <button
              onClick={() => clearAll.mutate()}
              disabled={all.length === 0 || clearAll.isPending}
              className="inline-flex items-center gap-1 text-text-secondary hover:text-danger disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              <Trash2 className="h-3 w-3" /> {t('notifications_center.clear_all')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
