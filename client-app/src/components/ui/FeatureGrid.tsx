import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { type LucideIcon } from 'lucide-react';
import clsx from 'clsx';

export interface FeatureItem {
  icon?: LucideIcon;
  title: ReactNode;
  description: ReactNode;
  /** External href — renders an `<a>`. */
  href?: string;
  /** Internal route — renders a React Router `<Link>`. */
  to?: string;
}

export interface FeatureGridProps {
  features: FeatureItem[];
  /** Number of columns at `lg+`. Mobile is always 1, sm/md is half. */
  columns?: 2 | 3 | 4;
  className?: string;
  /** Compact swaps the icon block for an inline pill. */
  variant?: 'default' | 'compact';
}

const COL_CLASS: Record<NonNullable<FeatureGridProps['columns']>, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
};

export default function FeatureGrid({
  features,
  columns = 3,
  className,
  variant = 'default',
}: FeatureGridProps) {
  return (
    <div className={clsx('grid gap-5', COL_CLASS[columns], className)}>
      {features.map((feature, i) => {
        const Icon = feature.icon;
        const isLink = !!feature.href || !!feature.to;
        const cardClass = clsx(
          'bg-surface border border-border rounded-xl p-5 text-text-primary',
          'shadow-[var(--elevation-1)]',
          isLink &&
            'motion-hover-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        );
        const inner = (
          <>
            {Icon && variant === 'default' && (
              <div className="h-10 w-10 rounded-lg bg-primary-light text-primary flex items-center justify-center mb-4">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
            )}
            <h3 className="font-display text-lg font-semibold tracking-tight mb-1.5 flex items-center gap-2">
              {Icon && variant === 'compact' && (
                <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
              )}
              {feature.title}
            </h3>
            <p className="text-sm text-text-secondary leading-relaxed">{feature.description}</p>
          </>
        );

        if (feature.to) {
          return (
            <Link key={i} to={feature.to} className={cardClass}>
              {inner}
            </Link>
          );
        }
        if (feature.href) {
          return (
            <a key={i} href={feature.href} className={cardClass}>
              {inner}
            </a>
          );
        }
        return (
          <div key={i} className={cardClass}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
