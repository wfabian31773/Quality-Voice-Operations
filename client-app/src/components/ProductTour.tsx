import { useCallback, useEffect, useState, useRef, type CSSProperties } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { X, ChevronRight, ChevronLeft } from 'lucide-react';

export interface TourStep {
  selector: string;
  title: string;
  description: string;
  path?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

const STORAGE_PREFIX = 'qvo_tour_completed.';
const LEGACY_DASHBOARD_KEY = 'qvo_product_tour_v1';

function storageKeyFor(tourId: string): string {
  // Back-compat: the original dashboard tour shipped with this fixed key.
  // Preserve it so users who already completed it stay completed after the
  // refactor.
  if (tourId === 'dashboard') return LEGACY_DASHBOARD_KEY;
  return `${STORAGE_PREFIX}${tourId}`;
}

interface ProductTourProps {
  active: boolean;
  onClose: () => void;
  steps: TourStep[];
  tourId: string;
}

export default function ProductTour({ active, onClose, steps, tourId }: ProductTourProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation('tenant');
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const rafRef = useRef<number>(0);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Reset to first step whenever the tour is (re)opened so replays start clean.
  useEffect(() => {
    if (active) setStep(0);
  }, [active]);

  const current = steps[step];

  useEffect(() => {
    if (!active) return;
    if (current?.path && location.pathname !== current.path) {
      navigate(current.path);
    }
  }, [active, step, current, location.pathname, navigate]);

  useEffect(() => {
    if (!active || !current) return;
    let cancelled = false;
    const measure = () => {
      const el = document.querySelector(current.selector) as HTMLElement | null;
      if (el) {
        const r = el.getBoundingClientRect();
        setRect(r);
      } else {
        setRect(null);
      }
      if (!cancelled) rafRef.current = requestAnimationFrame(measure);
    };
    rafRef.current = requestAnimationFrame(measure);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
    };
  }, [active, step, current, location.pathname]);

  const finish = useCallback(() => {
    try { localStorage.setItem(storageKeyFor(tourId), 'completed'); } catch {}
    setStep(0);
    onClose();
  }, [tourId, onClose]);

  // Keyboard accessibility: ESC closes the tour. The tour overlay deliberately
  // leaves the highlighted UI clickable, so we don't trap focus or lock scroll
  // — but we still move initial focus to the tooltip and restore the previous
  // focus on close so keyboard users land somewhere sensible.
  useEffect(() => {
    if (!active) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusId = window.setTimeout(() => {
      tooltipRef.current?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
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
  }, [active, finish]);

  if (!active || !current) return null;

  const PADDING = 8;
  const cutoutStyle = rect
    ? {
        top: rect.top - PADDING,
        left: rect.left - PADDING,
        width: rect.width + PADDING * 2,
        height: rect.height + PADDING * 2,
      }
    : null;

  const tooltipPos = computeTooltipPosition(rect, current.placement ?? 'bottom');

  return (
    <div className="fixed inset-0 z-[110] pointer-events-none">
      <svg className="absolute inset-0 w-full h-full pointer-events-auto" onClick={finish}>
        <defs>
          <mask id="qvo-tour-mask">
            <rect width="100%" height="100%" fill="white" />
            {cutoutStyle && (
              <rect
                x={cutoutStyle.left}
                y={cutoutStyle.top}
                width={cutoutStyle.width}
                height={cutoutStyle.height}
                rx={10}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.65)" mask="url(#qvo-tour-mask)" />
      </svg>

      {cutoutStyle && (
        <div
          className="absolute border-2 border-primary rounded-[10px] pointer-events-none animate-pulse"
          style={cutoutStyle}
        />
      )}

      <div
        ref={tooltipRef}
        role="dialog"
        aria-modal="false"
        aria-label={current.title}
        tabIndex={-1}
        className="absolute pointer-events-auto bg-surface border border-border rounded-xl shadow-2xl p-4 w-[320px] max-w-[calc(100vw-2rem)] focus:outline-none"
        style={tooltipPos}
        data-testid={`product-tour-${tourId}`}
      >
        <div className="flex items-start justify-between mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
            {t('product_tour.step_progress', { current: step + 1, total: steps.length })}
          </span>
          <button
            onClick={finish}
            className="text-text-muted hover:text-text-primary"
            aria-label={t('product_tour.close_aria')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <h3 className="text-sm font-semibold text-text-primary">{current.title}</h3>
        <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">{current.description}</p>
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40 inline-flex items-center gap-1"
          >
            <ChevronLeft className="h-3 w-3" /> {t('product_tour.back')}
          </button>
          <div className="flex gap-1">
            {steps.map((_, i) => (
              <span
                key={i}
                className={`h-1 w-4 rounded-full transition-colors ${i === step ? 'bg-primary' : 'bg-border'}`}
              />
            ))}
          </div>
          {step < steps.length - 1 ? (
            <button
              onClick={() => setStep((s) => Math.min(steps.length - 1, s + 1))}
              className="text-xs font-medium text-primary hover:text-primary-hover inline-flex items-center gap-1"
            >
              {t('product_tour.next')} <ChevronRight className="h-3 w-3" />
            </button>
          ) : (
            <button
              onClick={finish}
              className="text-xs font-medium bg-primary hover:bg-primary-hover text-white px-3 py-1.5 rounded-lg"
            >
              {t('product_tour.finish')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function computeTooltipPosition(rect: DOMRect | null, placement: 'top' | 'bottom' | 'left' | 'right'): CSSProperties {
  if (!rect) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
  const W = 320;
  const GAP = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = 0, left = 0;
  switch (placement) {
    case 'right':
      top = rect.top + rect.height / 2 - 60;
      left = rect.right + GAP;
      break;
    case 'left':
      top = rect.top + rect.height / 2 - 60;
      left = rect.left - GAP - W;
      break;
    case 'top':
      top = rect.top - GAP - 160;
      left = rect.left + rect.width / 2 - W / 2;
      break;
    case 'bottom':
    default:
      top = rect.bottom + GAP;
      left = rect.left + rect.width / 2 - W / 2;
  }
  left = Math.max(12, Math.min(vw - W - 12, left));
  top = Math.max(12, Math.min(vh - 200, top));
  return { top, left };
}

export function getTourCompleted(tourId: string = 'dashboard'): boolean {
  try { return localStorage.getItem(storageKeyFor(tourId)) === 'completed'; } catch { return false; }
}

export function resetTour(tourId: string = 'dashboard') {
  try { localStorage.removeItem(storageKeyFor(tourId)); } catch {}
}
