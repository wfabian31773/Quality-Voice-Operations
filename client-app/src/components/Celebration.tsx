import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PartyPopper, X } from 'lucide-react';

interface CelebrationProps {
  show: boolean;
  title?: string;
  message?: string;
  onClose: () => void;
}

const COLORS = ['#2E8C83', '#4C9B6B', '#C98A2E', '#3b82f6', '#8b5cf6', '#ef4444'];

export default function Celebration({ show, title, message, onClose }: CelebrationProps) {
  const { t } = useTranslation('tenant');
  const [exiting, setExiting] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const dismiss = useCallback(() => {
    setExiting(true);
    setTimeout(onClose, 400);
  }, [onClose]);

  useEffect(() => {
    if (!show) return;
    setExiting(false);
    const t = setTimeout(() => {
      setExiting(true);
      setTimeout(onClose, 400);
    }, 6000);
    return () => clearTimeout(t);
  }, [show, onClose]);

  // Keyboard accessibility: ESC dismisses the celebration. The popup is not
  // modal (the rest of the app stays interactive and the confetti is purely
  // decorative), so we don't trap focus or lock scroll — we just give
  // keyboard users a way out and restore focus when it disappears.
  useEffect(() => {
    if (!show) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusId = window.setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(focusId);
      document.removeEventListener('keydown', onKey);
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch { /* element may have unmounted */ }
      }
    };
  }, [show, dismiss]);

  const pieces = useMemo(
    () =>
      Array.from({ length: 80 }).map((_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.5,
        duration: 2 + Math.random() * 2,
        rotate: Math.random() * 360,
        color: COLORS[i % COLORS.length],
        size: 6 + Math.random() * 6,
      })),
    [show],
  );

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[120] pointer-events-none overflow-hidden">
      <style>{`
        @keyframes qvo-confetti-fall {
          0% { transform: translateY(-10vh) rotate(0deg); opacity: 1; }
          100% { transform: translateY(110vh) rotate(720deg); opacity: 0.6; }
        }
        @keyframes qvo-pop-in {
          0% { transform: scale(0.85); opacity: 0; }
          60% { transform: scale(1.05); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes qvo-pop-out {
          0% { transform: scale(1); opacity: 1; }
          100% { transform: scale(0.9); opacity: 0; }
        }
      `}</style>

      {pieces.map((p) => (
        <span
          key={p.id}
          className="absolute block rounded-sm"
          style={{
            left: `${p.left}%`,
            top: '-10vh',
            width: p.size,
            height: p.size * 0.4,
            background: p.color,
            transform: `rotate(${p.rotate}deg)`,
            animation: `qvo-confetti-fall ${p.duration}s linear ${p.delay}s forwards`,
          }}
        />
      ))}

      <div
        role="dialog"
        aria-label={title ?? t('celebration.default_aria')}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-auto"
        style={{ animation: `${exiting ? 'qvo-pop-out' : 'qvo-pop-in'} 0.4s ease forwards` }}
      >
        <div className="bg-surface border border-border rounded-2xl shadow-2xl px-8 py-6 max-w-sm text-center relative">
          <button
            ref={closeButtonRef}
            onClick={dismiss}
            aria-label={t('celebration.dismiss_aria')}
            className="absolute top-2 right-2 text-text-muted hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-3">
            <PartyPopper className="h-7 w-7 text-primary" />
          </div>
          <h3 className="text-lg font-bold text-text-primary">{title ?? t('celebration.default_title')}</h3>
          <p className="text-sm text-text-secondary mt-1">
            {message ?? t('celebration.default_message')}
          </p>
        </div>
      </div>
    </div>
  );
}
