import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { Sparkles, CheckCheck } from 'lucide-react';
import { PageHeader } from '../components/ui';
import { EmptyState, Skeleton } from '../components/state';

interface Entry {
  id: string;
  title: string;
  body: string;
  tags: string[];
  published_at: string;
  read: boolean;
}

export default function Changelog() {
  const qc = useQueryClient();
  const { t, i18n } = useTranslation('tenant');
  const { data, isLoading } = useQuery({
    queryKey: ['changelog'],
    queryFn: () => api.get<{ entries: Entry[] }>('/platform/changelog'),
  });

  const readAll = useMutation({
    mutationFn: () => api.post('/platform/changelog/read-all'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['changelog'] });
      qc.invalidateQueries({ queryKey: ['changelog-unread'] });
    },
  });

  const entries = data?.entries ?? [];

  useEffect(() => {
    if (entries.some((e) => !e.read)) {
      readAll.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length]);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader
        title={t('changelog.title')}
        description={t('changelog.description')}
        icon={<Sparkles className="h-5 w-5" />}
        actions={
          <button
            onClick={() => readAll.mutate()}
            disabled={readAll.isPending || entries.length === 0}
            className="hidden sm:inline-flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <CheckCheck className="h-4 w-4" /> {t('changelog.mark_all_read')}
          </button>
        }
      />

      {isLoading && (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      )}
      {!isLoading && entries.length === 0 && (
        <EmptyState
          icon={Sparkles}
          title={t('changelog.empty_title')}
          description={t('changelog.empty_description')}
        />
      )}

      <div className="space-y-4">
        {entries.map((e) => (
          <article
            key={e.id}
            className="bg-surface rounded-xl border border-border p-5 sm:p-6 shadow-[var(--elevation-1)]"
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <time className="text-xs text-text-muted uppercase tracking-wider font-semibold">
                {new Date(e.published_at).toLocaleDateString(i18n.language, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </time>
              {!e.read && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary text-on-primary">
                  {t('changelog.new_badge')}
                </span>
              )}
            </div>
            <h2 className="text-lg font-semibold font-display text-text-primary mb-2">{e.title}</h2>
            <p className="text-sm text-text-secondary whitespace-pre-line leading-relaxed">{e.body}</p>
            {e.tags?.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {e.tags.map((t) => (
                  <span
                    key={t}
                    className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-surface-hover text-text-secondary"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
