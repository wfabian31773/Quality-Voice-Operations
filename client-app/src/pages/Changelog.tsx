import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { Sparkles, CheckCheck } from 'lucide-react';

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
    <div className="max-w-3xl mx-auto">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold font-display flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            What's new
          </h1>
          <p className="text-text-secondary mt-1">Recent platform updates, fixes, and improvements.</p>
        </div>
        <button
          onClick={() => readAll.mutate()}
          disabled={readAll.isPending}
          className="hidden sm:inline-flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-lg hover:bg-surface-hover"
        >
          <CheckCheck className="h-4 w-4" /> Mark all read
        </button>
      </div>

      {isLoading && <p className="text-text-muted">Loading…</p>}
      {!isLoading && entries.length === 0 && (
        <div className="text-center py-12 bg-surface rounded-xl border border-border">
          <p className="text-text-secondary">No changelog entries yet.</p>
        </div>
      )}

      <div className="space-y-4">
        {entries.map((e) => (
          <article
            key={e.id}
            className="bg-surface rounded-xl border border-border p-5 sm:p-6"
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <time className="text-xs text-text-muted uppercase tracking-wider font-semibold">
                {new Date(e.published_at).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </time>
              {!e.read && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary text-white">
                  New
                </span>
              )}
            </div>
            <h2 className="text-lg font-semibold font-display mb-2">{e.title}</h2>
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
