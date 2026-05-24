import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  HelpCircle, X, Search, BookOpen, MessageCircle,
  Sparkles, Keyboard, Command, ArrowRight, Map, ExternalLink, Globe,
} from 'lucide-react';
import { docArticles, type DocArticle, type DocBlock } from '../data/docs';
import { useSearchDocs, useTranslatedArticles } from '../lib/translateDoc';
import {
  useSearchMarketingPages,
  type TranslatedMarketingPage,
} from '../lib/translateMarketingPage';
import { logEmptyMarketingSearch } from '../lib/logEmptyMarketingSearch';

function extractText(block: DocBlock): string {
  if (block.type === 'p' || block.type === 'h2' || block.type === 'h3') return block.text;
  if (block.type === 'ul' || block.type === 'ol') return block.items.join(' ');
  if (block.type === 'callout') return block.text;
  if (block.type === 'common-issues') return block.items.map((i) => `${i.problem} ${i.fix}`).join(' ');
  return '';
}

function buildSnippet(article: DocArticle, query: string): string {
  const q = query.trim().toLowerCase();
  const paragraphs = article.body
    .map(extractText)
    .filter((t) => t.length > 0);
  if (q) {
    const match = paragraphs.find((t) => t.toLowerCase().includes(q));
    if (match) {
      const idx = match.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 40);
      const end = Math.min(match.length, idx + q.length + 80);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < match.length ? '…' : '';
      return prefix + match.slice(start, end) + suffix;
    }
  }
  return article.description;
}

function highlight(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) {
      parts.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return parts.map((p, n) =>
    p.match ? <mark key={n} className="bg-primary/20 text-primary rounded px-0.5">{p.text}</mark> : <span key={n}>{p.text}</span>
  );
}

interface ChangelogEntry {
  date: string;
  tag: string;
  text: string;
}

interface HelpWidgetProps {
  open: boolean;
  setOpen: (v: boolean) => void;
  onOpenShortcuts?: () => void;
  onStartTour?: () => void;
}

export default function HelpWidget({ open, setOpen, onOpenShortcuts, onStartTour }: HelpWidgetProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('tenant');
  const [tab, setTab] = useState<'home' | 'docs' | 'changelog'>('home');
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

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
  }, [open, setOpen]);

  const searchDocs = useSearchDocs();
  const fallbackArticles = useTranslatedArticles(docArticles.slice(0, 8));
  const results = useMemo<DocArticle[]>(
    () => (query.trim() ? searchDocs(query).slice(0, 8) : fallbackArticles),
    [query, searchDocs, fallbackArticles],
  );

  const searchMarketing = useSearchMarketingPages();
  const marketingResults = useMemo<TranslatedMarketingPage[]>(
    () => (query.trim() ? searchMarketing(query).slice(0, 6) : []),
    [query, searchMarketing],
  );

  const totalResults = results.length + marketingResults.length;

  // Telemetry — log searches that returned zero **marketing** hits so
  // platform admins can see which translated phrases are missing from
  // `client-app/src/locales/<locale>/marketing.json`. We fire whenever
  // the marketing-page index returns zero results, *independent* of
  // whether the docs index also matched something. A query that lands
  // on a help article but fails to surface the relevant marketing page
  // is still a marketing-keyword gap worth tracking. The logger
  // collapses typing into one log per (source + locale) and dedupes
  // the same final phrase within 60 s.
  useEffect(() => {
    if (!open || tab !== 'docs') return;
    if (!query.trim()) return;
    if (marketingResults.length > 0) return;
    logEmptyMarketingSearch({
      query,
      locale: i18n.language,
      source: 'help_widget',
      pagePath:
        typeof window !== 'undefined' ? window.location.pathname : undefined,
    });
  }, [open, tab, query, marketingResults.length, i18n.language]);

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        aria-label={t('help_widget.aria')}
        className="fixed z-drawer bottom-5 right-5 h-12 w-12 rounded-full bg-primary hover:bg-primary-hover text-white shadow-lg flex items-center justify-center transition-transform hover:scale-105"
      >
        {open ? <X className="h-5 w-5" /> : <HelpCircle className="h-5 w-5" />}
      </button>

      {open && (
        <div
          ref={ref}
          className="fixed z-drawer bottom-20 right-5 w-[360px] max-w-[calc(100vw-2rem)] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
        >
          <div className="px-4 py-3 bg-gradient-to-br from-[#123047] to-[#1a4a6b] text-white">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">{t('help_widget.title')}</h3>
              <button onClick={() => setOpen(false)} className="text-white/70 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-white/70 mt-0.5">{t('help_widget.subtitle')}</p>
          </div>

          <div className="flex border-b border-border">
            {(['home', 'docs', 'changelog'] as const).map((tk) => (
              <button
                key={tk}
                onClick={() => setTab(tk)}
                className={`flex-1 px-3 py-2 text-xs font-medium capitalize border-b-2 transition-colors ${
                  tab === tk
                    ? 'border-primary text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {t(`help_widget.tab_${tk}`)}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {tab === 'home' && (
              <div className="p-3 space-y-2">
                <HelpAction icon={Map} label={t('help_widget.action_take_tour')} onClick={() => { onStartTour?.(); setOpen(false); }} />
                <HelpAction icon={BookOpen} label={t('help_widget.action_browse_docs')} onClick={() => { setTab('docs'); }} />
                <HelpAction icon={Sparkles} label={t('help_widget.action_whats_new')} onClick={() => setTab('changelog')} />
                <HelpAction icon={Keyboard} label={t('help_widget.action_shortcuts')} onClick={() => { onOpenShortcuts?.(); setOpen(false); }} />
                <HelpAction
                  icon={Command}
                  label={t('help_widget.action_open_command')}
                  hint="⌘K"
                  onClick={() => {
                    setOpen(false);
                    window.dispatchEvent(new CustomEvent('qvo:open-command-palette'));
                  }}
                />
                <HelpAction icon={MessageCircle} label={t('help_widget.action_contact_support')} onClick={() => { navigate('/settings/general'); setOpen(false); }} />
              </div>
            )}

            {tab === 'docs' && (
              <div className="p-3 space-y-2">
                <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border bg-surface-secondary">
                  <Search className="h-3.5 w-3.5 text-text-muted shrink-0" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('help_widget.search_placeholder')}
                    aria-label={t('help_widget.search_aria')}
                    className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted"
                  />
                </div>
                <div className="space-y-1 mt-2">
                  {query.trim() && (
                    <p className="text-[10px] uppercase tracking-wider text-text-muted px-1 pb-1">
                      {t('help_widget.results', { count: totalResults })}
                    </p>
                  )}
                  {query.trim() && totalResults === 0 && (
                    <p className="text-xs text-text-muted py-3 text-center">{t('help_widget.no_matches', { query })}</p>
                  )}

                  {results.length > 0 && (
                    <>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted px-1 pt-1 pb-0.5 flex items-center gap-1.5">
                        <BookOpen className="h-3 w-3" />
                        {t('help_widget.docs_heading')}
                      </p>
                      {results.map((d) => (
                        <button
                          key={d.slug}
                          onClick={() => {
                            navigate(`/docs/${d.slug}`);
                            setOpen(false);
                          }}
                          className="w-full text-left flex items-start gap-2 px-2.5 py-2 rounded-lg hover:bg-surface-hover transition-colors group"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-primary truncate">
                              {highlight(d.title, query)}
                            </p>
                            <p className="text-xs text-text-muted line-clamp-2 mt-0.5">
                              {highlight(buildSnippet(d, query), query)}
                            </p>
                            <p className="text-[10px] text-text-muted/70 uppercase tracking-wider mt-1">
                              {d.category.replace('-', ' ')} · {d.readTime}
                            </p>
                          </div>
                          <ArrowRight className="h-3.5 w-3.5 text-text-muted shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      ))}
                    </>
                  )}

                  {marketingResults.length > 0 && (
                    <>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted px-1 pt-3 pb-0.5 flex items-center gap-1.5">
                        <Globe className="h-3 w-3" />
                        {t('help_widget.marketing_heading')}
                      </p>
                      {marketingResults.map((m) => {
                        const Icon = m.icon;
                        return (
                          <a
                            key={m.slug}
                            href={m.path}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setOpen(false)}
                            className="w-full text-left flex items-start gap-2 px-2.5 py-2 rounded-lg hover:bg-surface-hover transition-colors group"
                          >
                            <Icon className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-text-primary truncate flex items-center gap-1">
                                {highlight(m.title, query)}
                                <ExternalLink className="h-3 w-3 text-text-muted shrink-0" />
                              </p>
                              <p className="text-xs text-text-muted line-clamp-2 mt-0.5">
                                {highlight(m.description, query)}
                              </p>
                              <p className="text-[10px] text-text-muted/70 uppercase tracking-wider mt-1">
                                {m.categoryLabel} · {t('help_widget.opens_in_new_tab')}
                              </p>
                            </div>
                          </a>
                        );
                      })}
                    </>
                  )}
                </div>
              </div>
            )}

            {tab === 'changelog' && (
              <div className="p-3 space-y-3">
                {(t('help_widget.changelog_entries', { returnObjects: true }) as ChangelogEntry[]).map((c, i) => (
                  <div key={i} className="text-sm">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary uppercase">
                        {c.tag}
                      </span>
                      <span className="text-[11px] text-text-muted">{c.date}</span>
                    </div>
                    <p className="text-sm text-text-primary leading-snug">{c.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function HelpAction({
  icon: Icon, label, onClick, hint,
}: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void; hint?: string }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm text-text-primary hover:bg-surface-hover transition-colors"
    >
      <Icon className="h-4 w-4 text-primary shrink-0" />
      <span className="flex-1">{label}</span>
      {hint && <kbd className="text-[10px] text-text-muted bg-surface-hover border border-border px-1.5 py-0.5 rounded">{hint}</kbd>}
    </button>
  );
}
