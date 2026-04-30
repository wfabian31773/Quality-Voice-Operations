import { type ReactNode } from 'react';
import clsx from 'clsx';

export interface StatStripItem {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
}

export interface StatStripProps {
  stats: StatStripItem[];
  /** Sit on top of dark surfaces (e.g. inverse hero / CTA band). */
  inverse?: boolean;
  /** Show the strip framed inside a card instead of inline. */
  framed?: boolean;
  /** Number of columns at `sm+` (mobile is always 2). */
  columns?: 2 | 3 | 4;
  className?: string;
}

const COL_CLASS: Record<NonNullable<StatStripProps['columns']>, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
};

/** Horizontal strip of metric values with tabular numerals. */
export default function StatStrip({
  stats,
  inverse = false,
  framed = false,
  columns = 4,
  className,
}: StatStripProps) {
  return (
    <div
      className={clsx(
        'grid grid-cols-2 gap-y-6 gap-x-4',
        COL_CLASS[columns],
        framed &&
          (inverse
            ? 'bg-sidebar-bg border border-on-sidebar/10 rounded-xl p-6'
            : 'bg-surface border border-border rounded-xl p-6 shadow-[var(--elevation-1)]'),
        className,
      )}
    >
      {stats.map((stat, i) => (
        <div key={i} className="flex flex-col text-left">
          <span
            className={clsx(
              'font-display text-3xl sm:text-4xl font-bold tabular-nums tracking-tight',
              inverse ? 'text-on-sidebar' : 'text-text-primary',
            )}
          >
            {stat.value}
          </span>
          <span
            className={clsx(
              'mt-1 text-sm font-medium',
              inverse ? 'text-on-sidebar opacity-80' : 'text-text-secondary',
            )}
          >
            {stat.label}
          </span>
          {stat.sub && (
            <span
              className={clsx(
                'mt-0.5 text-xs',
                inverse ? 'text-on-sidebar opacity-60' : 'text-text-muted',
              )}
            >
              {stat.sub}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
