import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HelpCircle, X, Search, BookOpen, MessageCircle,
  Sparkles, Keyboard, Command, ArrowRight, Map, ExternalLink, Globe,
} from 'lucide-react';
import { docArticles, searchDocs, type DocArticle, type DocBlock } from '../data/docs';
import { searchMarketingPages, type MarketingPage } from '../data/marketingPages';
import { useArticleMetaTranslator, useTranslatedArticles } from '../lib/translateDoc';

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

const CHANGELOG = [
  { date: 'Apr 21', tag: 'New', text: 'Command palette (⌘K) and in-app help widget.' },
  { date: 'Apr 19', tag: 'New', text: 'Guided product tour for first-time users.' },
  { date: 'Apr 17', tag: 'Improved', text: 'Dashboard now shows live bookings and revenue.' },
  { date: 'Apr 15', tag: 'Improved', text: 'Dark-mode polish across analytics charts.' },
];

interface HelpWidgetProps {
  open: boolean;
  setOpen: (v: boolean) => void;
  onOpenShortcuts?: () => void;
  onStartTour?: () => void;
}

export default function HelpWidget({ open, setOpen, onOpenShortcuts, onStartTour }: HelpWidgetProps) {
  const navigate = useNavigate();
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

  const rawResults = useMemo<DocArticle[]>(
    () => (query.trim() ? searchDocs(query).slice(0, 8) : docArticles.slice(0, 8)),
    [query],
  );
  const results = useTranslatedArticles(rawResults);
  const translateMeta = useArticleMetaTranslator();

  const marketingResults = useMemo<MarketingPage[]>(
    () => (query.trim() ? searchMarketingPages(query).slice(0, 6) : []),
    [query],
  );

  const totalResults = results.length + marketingResults.length;

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        aria-label="Help"
        className="fixed z-40 bottom-5 right-5 h-12 w-12 rounded-full bg-primary hover:bg-primary-hover text-white shadow-lg flex items-center justify-center transition-transform hover:scale-105"
      >
        {open ? <X className="h-5 w-5" /> : <HelpCircle className="h-5 w-5" />}
      </button>

      {open && (
        <div
          ref={ref}
          className="fixed z-40 bottom-20 right-5 w-[360px] max-w-[calc(100vw-2rem)] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
        >
          <div className="px-4 py-3 bg-gradient-to-br from-[#123047] to-[#1a4a6b] text-white">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">Help & resources</h3>
              <button onClick={() => setOpen(false)} className="text-white/70 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-white/70 mt-0.5">Search docs, get support, see what's new.</p>
          </div>

          <div className="flex border-b border-border">
            {(['home', 'docs', 'changelog'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 px-3 py-2 text-xs font-medium capitalize border-b-2 transition-colors ${
                  tab === t
                    ? 'border-primary text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {tab === 'home' && (
              <div className="p-3 space-y-2">
                <HelpAction icon={Map} label="Take the product tour" onClick={() => { onStartTour?.(); setOpen(false); }} />
                <HelpAction icon={BookOpen} label="Browse docs" onClick={() => { setTab('docs'); }} />
                <HelpAction icon={Sparkles} label="What's new" onClick={() => setTab('changelog')} />
                <HelpAction icon={Keyboard} label="Keyboard shortcuts" onClick={() => { onOpenShortcuts?.(); setOpen(false); }} />
                <HelpAction
                  icon={Command}
                  label="Open command palette"
                  hint="⌘K"
                  onClick={() => {
                    setOpen(false);
                    window.dispatchEvent(new CustomEvent('qvo:open-command-palette'));
                  }}
                />
                <HelpAction icon={MessageCircle} label="Contact support" onClick={() => { navigate('/settings/general'); setOpen(false); }} />
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
                    placeholder="Search docs and pages..."
                    aria-label="Search docs and marketing pages"
                    className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted"
                  />
                </div>
                <div className="space-y-1 mt-2">
                  {query.trim() && (
                    <p className="text-[10px] uppercase tracking-wider text-text-muted px-1 pb-1">
                      {totalResults} {totalResults === 1 ? 'result' : 'results'}
                    </p>
                  )}
                  {query.trim() && totalResults === 0 && (
                    <p className="text-xs text-text-muted py-3 text-center">No matches for "{query}".</p>
                  )}

                  {results.length > 0 && (
                    <>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted px-1 pt-1 pb-0.5 flex items-center gap-1.5">
                        <BookOpen className="h-3 w-3" />
                        Docs
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
                        Marketing pages
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
                                {m.category} · opens in new tab
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
                {CHANGELOG.map((c, i) => (
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
