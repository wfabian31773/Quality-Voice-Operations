import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, LayoutDashboard, Bot, PhoneCall, Megaphone, BarChart3,
  MessageSquare, CalendarClock, ClipboardList, Truck, Network, Plug,
  BookOpen, Store, Settings2, Phone, FileText, HelpCircle, Plus, type LucideIcon,
} from 'lucide-react';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  group: 'Navigate' | 'Actions' | 'Help';
  run: () => void;
  keywords?: string[];
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenHelp?: () => void;
  onOpenShortcuts?: () => void;
  onStartTour?: () => void;
}

export default function CommandPalette({
  open, onClose, onOpenHelp, onOpenShortcuts, onStartTour,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const go = (path: string) => () => { navigate(path); onClose(); };

  const commands: Command[] = useMemo(() => [
    { id: 'dashboard', label: 'Go to Dashboard', icon: LayoutDashboard, group: 'Navigate', run: go('/dashboard') },
    { id: 'agents', label: 'Go to Agents', icon: Bot, group: 'Navigate', run: go('/agents') },
    { id: 'calls', label: 'Go to Conversations', icon: PhoneCall, group: 'Navigate', keywords: ['calls'], run: go('/calls') },
    { id: 'campaigns', label: 'Go to Campaigns', icon: Megaphone, group: 'Navigate', run: go('/campaigns') },
    { id: 'analytics', label: 'Go to Analytics', icon: BarChart3, group: 'Navigate', run: go('/analytics') },
    { id: 'sms', label: 'Go to SMS Inbox', icon: MessageSquare, group: 'Navigate', run: go('/sms-inbox') },
    { id: 'scheduling', label: 'Go to Scheduling', icon: CalendarClock, group: 'Navigate', run: go('/scheduling') },
    { id: 'tickets', label: 'Go to Tickets', icon: ClipboardList, group: 'Navigate', run: go('/tickets') },
    { id: 'dispatch', label: 'Go to Dispatch', icon: Truck, group: 'Navigate', run: go('/dispatch') },
    { id: 'workflows', label: 'Go to Workflows', icon: Network, group: 'Navigate', run: go('/workflows') },
    { id: 'integrations', label: 'Go to Integrations', icon: Plug, group: 'Navigate', keywords: ['connectors'], run: go('/connectors') },
    { id: 'knowledge', label: 'Go to Knowledge', icon: BookOpen, group: 'Navigate', run: go('/knowledge-base') },
    { id: 'marketplace', label: 'Go to Marketplace', icon: Store, group: 'Navigate', run: go('/marketplace') },
    { id: 'phones', label: 'Manage Phone Numbers', icon: Phone, group: 'Navigate', run: go('/phone-numbers') },
    { id: 'settings', label: 'Open Settings', icon: Settings2, group: 'Navigate', run: go('/settings') },
    { id: 'new-agent', label: 'Create New Agent', icon: Plus, group: 'Actions', run: go('/agents') },
    { id: 'new-campaign', label: 'Create New Campaign', icon: Plus, group: 'Actions', run: go('/campaigns') },
    { id: 'new-doc', label: 'Add Knowledge Source', icon: FileText, group: 'Actions', run: go('/knowledge-base') },
    ...(onStartTour ? [{ id: 'tour', label: 'Start Product Tour', icon: HelpCircle, group: 'Help' as const, run: () => { onStartTour(); onClose(); } }] : []),
    ...(onOpenShortcuts ? [{ id: 'shortcuts', label: 'View Keyboard Shortcuts', icon: HelpCircle, group: 'Help' as const, run: () => { onOpenShortcuts(); onClose(); } }] : []),
    ...(onOpenHelp ? [{ id: 'help', label: 'Open Help & Support', icon: HelpCircle, group: 'Help' as const, run: () => { onOpenHelp(); onClose(); } }] : []),
  ], [navigate, onClose, onOpenHelp, onOpenShortcuts, onStartTour]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = [c.label, c.group, ...(c.keywords ?? [])].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

  useEffect(() => { setActive(0); }, [query, open]);
  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(filtered.length - 1, i + 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
      if (e.key === 'Enter') { e.preventDefault(); filtered[active]?.run(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, filtered, active, onClose]);

  if (!open) return null;

  const groups = filtered.reduce<Record<string, Command[]>>((acc, cmd) => {
    (acc[cmd.group] ??= []).push(cmd);
    return acc;
  }, {});

  let runningIndex = 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl bg-surface border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Search className="h-4 w-4 text-text-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, pages, actions..."
            className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted"
          />
          <kbd className="text-[10px] font-medium text-text-muted bg-surface-hover border border-border px-1.5 py-0.5 rounded">ESC</kbd>
        </div>

        <div className="max-h-[55vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-8">No matches</p>
          ) : (
            Object.entries(groups).map(([group, items]) => (
              <div key={group} className="py-1">
                <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{group}</p>
                {items.map((cmd) => {
                  const idx = runningIndex++;
                  const Icon = cmd.icon;
                  const isActive = idx === active;
                  return (
                    <button
                      key={cmd.id}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => cmd.run()}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors ${
                        isActive ? 'bg-primary/10 text-primary' : 'text-text-primary hover:bg-surface-hover'
                      }`}
                    >
                      <Icon className={`h-4 w-4 ${isActive ? 'text-primary' : 'text-text-muted'}`} />
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {isActive && <span className="text-[10px] text-text-muted">↵</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="px-3 py-2 border-t border-border bg-surface-secondary text-[11px] text-text-muted flex items-center justify-between">
          <span>Navigate with ↑ ↓</span>
          <span>Open anytime with <kbd className="px-1 py-0.5 bg-surface border border-border rounded">⌘K</kbd> / <kbd className="px-1 py-0.5 bg-surface border border-border rounded">Ctrl K</kbd></span>
        </div>
      </div>
    </div>
  );
}
