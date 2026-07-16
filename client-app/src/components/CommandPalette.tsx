import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Search, LayoutDashboard, Bot, PhoneCall, Megaphone, BarChart3,
  MessageSquare, CalendarClock, ClipboardList, Truck, Network, Plug,
  BookOpen, Store, Settings2, Phone, FileText, HelpCircle, Plus, Zap, type LucideIcon,
} from 'lucide-react';
import Modal from './Modal';
import { useAuth } from '../lib/auth';
import { isQvoStaff } from '../lib/surfacePolicy';

type CommandGroup = 'navigate' | 'actions' | 'help';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  group: CommandGroup;
  run: () => void;
  keywords?: string[];
  internalOnly?: boolean;
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
  const { user } = useAuth();
  const isStaff = isQvoStaff(user);
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const go = (path: string) => () => { navigate(path); onClose(); };

  const groupLabel = (g: CommandGroup): string => {
    if (g === 'navigate') return t('command_palette.group_navigate');
    if (g === 'actions') return t('command_palette.group_actions');
    return t('command_palette.group_help');
  };

  const commands: Command[] = useMemo(() => [
    { id: 'dashboard', label: t('command_palette.go_dashboard'), icon: LayoutDashboard, group: 'navigate', run: go('/dashboard') },
    { id: 'agents', label: t('command_palette.go_agents'), icon: Bot, group: 'navigate', run: go('/agents'), internalOnly: true },
    { id: 'calls', label: t('command_palette.go_calls'), icon: PhoneCall, group: 'navigate', keywords: ['calls'], run: go('/calls') },
    { id: 'campaigns', label: t('command_palette.go_campaigns'), icon: Megaphone, group: 'navigate', run: go('/campaigns'), internalOnly: true },
    { id: 'analytics', label: t('command_palette.go_analytics'), icon: BarChart3, group: 'navigate', run: go('/analytics'), internalOnly: true },
    { id: 'sms', label: t('command_palette.go_sms'), icon: MessageSquare, group: 'navigate', run: go('/sms-inbox'), internalOnly: true },
    { id: 'scheduling', label: t('command_palette.go_scheduling'), icon: CalendarClock, group: 'navigate', run: go('/scheduling'), internalOnly: true },
    { id: 'tickets', label: t('command_palette.go_tickets'), icon: ClipboardList, group: 'navigate', run: go('/tickets') },
    { id: 'dispatch', label: t('command_palette.go_dispatch'), icon: Truck, group: 'navigate', run: go('/dispatch'), internalOnly: true },
    { id: 'autopilot', label: t('command_palette.go_autopilot'), icon: Zap, group: 'navigate', keywords: ['ai', 'business', 'recommendations'], run: go('/autopilot'), internalOnly: true },
    { id: 'workflows', label: t('command_palette.go_workflows'), icon: Network, group: 'navigate', run: go('/workflows'), internalOnly: true },
    { id: 'integrations', label: t('command_palette.go_integrations'), icon: Plug, group: 'navigate', keywords: ['connectors'], run: go('/connectors'), internalOnly: true },
    { id: 'knowledge', label: t('command_palette.go_knowledge'), icon: BookOpen, group: 'navigate', run: go('/knowledge-base') },
    { id: 'marketplace', label: t('command_palette.go_marketplace'), icon: Store, group: 'navigate', run: go('/marketplace'), internalOnly: true },
    { id: 'phones', label: t('command_palette.go_phones'), icon: Phone, group: 'navigate', run: go('/phone-numbers') },
    { id: 'settings', label: t('command_palette.open_settings'), icon: Settings2, group: 'navigate', run: go('/settings') },
    { id: 'new-agent', label: t('command_palette.new_agent'), icon: Plus, group: 'actions', run: go('/agents'), internalOnly: true },
    { id: 'new-campaign', label: t('command_palette.new_campaign'), icon: Plus, group: 'actions', run: go('/campaigns'), internalOnly: true },
    { id: 'new-doc', label: t('command_palette.new_doc'), icon: FileText, group: 'actions', run: go('/knowledge-base') },
    ...(onStartTour ? [{ id: 'tour', label: t('command_palette.start_tour'), icon: HelpCircle, group: 'help' as const, run: () => { onStartTour(); onClose(); } }] : []),
    ...(onOpenShortcuts ? [{ id: 'shortcuts', label: t('command_palette.view_shortcuts'), icon: HelpCircle, group: 'help' as const, run: () => { onOpenShortcuts(); onClose(); } }] : []),
    ...(onOpenHelp ? [{ id: 'help', label: t('command_palette.open_help'), icon: HelpCircle, group: 'help' as const, run: () => { onOpenHelp(); onClose(); } }] : []),
  ], [navigate, onClose, onOpenHelp, onOpenShortcuts, onStartTour, t]);

  const visibleCommands = useMemo(
    () => commands.filter((command) => isStaff || !command.internalOnly),
    [commands, isStaff],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visibleCommands;
    return visibleCommands.filter((c) => {
      const hay = [c.label, c.group, ...(c.keywords ?? [])].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [query, visibleCommands]);

  useEffect(() => { setActive(0); }, [query, open]);
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(filtered.length - 1, i + 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
      if (e.key === 'Enter') { e.preventDefault(); filtered[active]?.run(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, filtered, active]);

  const groups = filtered.reduce<Record<CommandGroup, Command[]>>((acc, cmd) => {
    (acc[cmd.group] ??= []).push(cmd);
    return acc;
  }, {} as Record<CommandGroup, Command[]>);

  let runningIndex = 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={t('command_palette.aria')}
      initialFocusRef={inputRef}
      containerClassName="fixed inset-0 z-palette flex items-start justify-center pt-[10vh] px-4"
      panelClassName="relative w-full max-w-xl bg-surface border border-border rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <Search className="h-4 w-4 text-text-muted shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('command_palette.search_placeholder')}
          aria-label={t('command_palette.search_aria')}
          className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted"
        />
        <kbd className="text-[10px] font-medium text-text-muted bg-surface-hover border border-border px-1.5 py-0.5 rounded">{t('command_palette.esc')}</kbd>
      </div>

      <div className="max-h-[55vh] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-8">{t('command_palette.no_matches')}</p>
        ) : (
          (Object.entries(groups) as Array<[CommandGroup, Command[]]>).map(([group, items]) => (
            <div key={group} className="py-1">
              <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{groupLabel(group)}</p>
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
                    <Icon className={`h-4 w-4 ${isActive ? 'text-primary' : 'text-text-muted'}`} aria-hidden="true" />
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
        <span>{t('command_palette.navigate_hint')}</span>
        <span>{t('command_palette.open_anytime')} <kbd className="px-1 py-0.5 bg-surface border border-border rounded">⌘K</kbd> / <kbd className="px-1 py-0.5 bg-surface border border-border rounded">Ctrl K</kbd></span>
      </div>
    </Modal>
  );
}
