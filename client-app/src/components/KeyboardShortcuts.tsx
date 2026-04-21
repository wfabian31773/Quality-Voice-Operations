import { X } from 'lucide-react';

const SHORTCUTS = [
  { keys: ['⌘', 'K'], desc: 'Open command palette' },
  { keys: ['Ctrl', 'K'], desc: 'Open command palette (Windows / Linux)' },
  { keys: ['?'], desc: 'Show this shortcuts panel' },
  { keys: ['G', 'D'], desc: 'Go to Dashboard' },
  { keys: ['G', 'A'], desc: 'Go to Agents' },
  { keys: ['G', 'C'], desc: 'Go to Conversations' },
  { keys: ['G', 'N'], desc: 'Go to Analytics' },
  { keys: ['G', 'S'], desc: 'Go to Settings' },
  { keys: ['Esc'], desc: 'Close any modal or panel' },
];

export default function KeyboardShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full max-w-md bg-surface border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X className="h-4 w-4" />
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
      </div>
    </div>
  );
}
