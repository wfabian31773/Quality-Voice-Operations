import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';

export default function KeyboardShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const SHORTCUTS = [
    { keys: ['⌘', 'K'], desc: t('keyboard_shortcuts.command_palette') },
    { keys: ['Ctrl', 'K'], desc: t('keyboard_shortcuts.command_palette_win') },
    { keys: ['?'], desc: t('keyboard_shortcuts.show_panel') },
    { keys: ['G', 'D'], desc: t('keyboard_shortcuts.go_dashboard') },
    { keys: ['G', 'A'], desc: t('keyboard_shortcuts.go_agents') },
    { keys: ['G', 'C'], desc: t('keyboard_shortcuts.go_conversations') },
    { keys: ['G', 'N'], desc: t('keyboard_shortcuts.go_analytics') },
    { keys: ['G', 'S'], desc: t('keyboard_shortcuts.go_settings') },
    { keys: ['Esc'], desc: t('keyboard_shortcuts.close_modal') },
  ];

  return (
    <Modal open={open} onClose={onClose} labelledBy="keyboard-shortcuts-title">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <h2 id="keyboard-shortcuts-title" className="text-base font-semibold text-text-primary">
          {t('keyboard_shortcuts.title')}
        </h2>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text-primary"
          aria-label={t('keyboard_shortcuts.close')}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="p-5 space-y-2">
        {SHORTCUTS.map((s, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">{s.desc}</span>
            <span className="flex items-center gap-1">
              {s.keys.map((k, j) => (
                <kbd
                  key={j}
                  className="text-[11px] font-medium text-text-primary bg-surface-hover border border-border px-1.5 py-0.5 rounded"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
