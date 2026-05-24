import { useEffect, useRef, useState } from 'react';
import { reducedMotion } from '../../hooks/useScrollReveal';

export interface StatItem {
  /** Numeric value to count up to (e.g. 2400000). For string values, pass `display` instead. */
  value?: number;
  /** Pre-formatted string value when the metric isn't a count (e.g. "99.9%"). Takes precedence over `value`. */
  display?: string;
  /** Suffix appended after the number (e.g. "+", "%") */
  suffix?: string;
  /** Label below the value */
  label: string;
}

export interface StatsStripProps {
  /** Stats to render — typically 3 or 4 */
  stats: StatItem[];
  /**
   * If true, render as a standalone section with bg + padding.
   * If false, render as bare grid (useful when nested inside Pillars `children`).
   */
  standalone?: boolean;
}

function AnimatedCounter({
  end,
  suffix = '',
  duration = 2000,
}: {
  end: number;
  suffix?: string;
  duration?: number;
}) {
  const [count, setCount] = useState(reducedMotion ? end : 0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const startTime = performance.now();
          const animate = (now: number) => {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setCount(Math.round(eased * end));
            if (progress < 1) requestAnimationFrame(animate);
          };
          requestAnimationFrame(animate);
          observer.unobserve(el);
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [end, duration]);

  return (
    <span ref={ref}>
      {count.toLocaleString()}
      {suffix}
    </span>
  );
}

/**
 * Numbers row used as social proof in marketing pages.
 *
 * Pass `standalone={false}` (the default false-equivalent when wrapped) when
 * nesting under Pillars; pass `standalone={true}` to render as its own section
 * with background + border.
 */
export default function StatsStrip({ stats, standalone = false }: StatsStripProps) {
  const grid = (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
      {stats.map((s) => (
        <div key={s.label} className="text-center">
          <p className="font-display text-3xl lg:text-4xl font-bold text-text-primary tabular-nums">
            {s.display !== undefined ? (
              <>
                {s.display}
                {s.suffix ?? ''}
              </>
            ) : (
              <AnimatedCounter end={s.value ?? 0} suffix={s.suffix ?? ''} />
            )}
          </p>
          <p className="text-xs lg:text-sm text-text-secondary font-body mt-2 uppercase tracking-wider">
            {s.label}
          </p>
        </div>
      ))}
    </div>
  );

  if (!standalone) {
    return grid;
  }

  return (
    <section className="bg-surface py-14 border-b border-border/60">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">{grid}</div>
    </section>
  );
}
