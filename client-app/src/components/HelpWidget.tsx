import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HelpCircle, X, Search, BookOpen, MessageCircle,
  Sparkles, Keyboard, Command, ExternalLink, Map,
} from 'lucide-react';

interface DocLink {
  title: string;
  href: string;
  keywords: string[];
}

const DOCS: DocLink[] = [
  { title: 'Getting started', href: '/docs', keywords: ['quickstart', 'setup', 'onboarding'] },
  { title: 'Create your first agent', href: '/docs#agents', keywords: ['agent', 'voice', 'create'] },
  { title: 'Connect a phone number', href: '/docs#numbers', keywords: ['phone', 'twilio', 'number'] },
  { title: 'Build a workflow', href: '/docs#workflows', keywords: ['workflow', 'tool', 'flow'] },
  { title: 'Knowledge base & RAG', href: '/docs#kb', keywords: ['knowledge', 'rag', 'docs', 'pdf'] },
  { title: 'Outbound campaigns', href: '/docs#campaigns', keywords: ['campaign', 'outbound', 'dialer'] },
  { title: 'Scheduling integration', href: '/docs#scheduling', keywords: ['booking', 'calendar', 'schedule'] },
  { title: 'Tickets & escalations', href: '/docs#tickets', keywords: ['ticket', 'escalate', 'queue'] },
  { title: 'Billing & usage', href: '/docs#billing', keywords: ['billing', 'invoice', 'plan'] },
  { title: 'API & webhooks', href: '/docs#api', keywords: ['api', 'webhook', 'integration'] },
];

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
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, setOpen]);

  const filteredDocs = query
    ? DOCS.filter((d) => {
        const q = query.toLowerCase();
        return d.title.toLowerCase().includes(q) || d.keywords.some((k) => k.includes(q));
      })
    : DOCS;

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
                    placeholder="Search docs..."
                    className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted"
                  />
                </div>
                <div className="space-y-1 mt-2">
                  {filteredDocs.length === 0 && (
                    <p className="text-xs text-text-muted py-3 text-center">No matches.</p>
                  )}
                  {filteredDocs.map((d) => (
                    <a
                      key={d.title}
                      href={d.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between px-2.5 py-2 rounded-lg text-sm text-text-primary hover:bg-surface-hover transition-colors"
                    >
                      <span className="truncate">{d.title}</span>
                      <ExternalLink className="h-3.5 w-3.5 text-text-muted shrink-0" />
                    </a>
                  ))}
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
