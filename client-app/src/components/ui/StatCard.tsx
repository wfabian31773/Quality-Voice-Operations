import { type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';
import clsx from 'clsx';

export type StatTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';

export interface StatCardProps {
  icon?: LucideIcon;
  label: ReactNode;
  value: ReactNode;
  trend?: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
  onClick?: () => void;
  loading?: boolean;
  className?: string;
}

const TONE_BG: Record<StatTone, string> = {
  primary: 'bg-primary-light text-primary',
  success: 'bg-success-light text-success',
  warning: 'bg-warning-light text-warning',
  danger: 'bg-danger-light text-danger',
  info: 'bg-info-light text-info',
  accent: 'bg-accent-light text-accent',
  neutral: 'bg-surface-hover text-text-secondary',
};

export default function StatCard({
  icon: Icon,
  label,
  value,
  trend,
  sub,
  tone = 'primary',
  onClick,
  loading,
  className,
}: StatCardProps) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={clsx(
        'bg-surface border border-border rounded-xl p-5 text-left transition-shadow',
        'shadow-[var(--elevation-1)] hover:shadow-[var(--elevation-2)]',
        onClick && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {Icon && (
          <div className={clsx('p-2.5 rounded-lg shrink-0', TONE_BG[tone])}>
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-secondary truncate">{label}</p>
          <div className="flex items-baseline gap-2 mt-0.5">
            {loading ? (
              <span className="h-7 w-16 bg-surface-hover animate-pulse rounded" aria-hidden />
            ) : (
              <p className="text-2xl font-bold text-text-primary tabular-nums">{value}</p>
            )}
            {trend && <span className="text-xs text-text-secondary">{trend}</span>}
          </div>
          {sub && (
            <p className="text-xs text-text-muted mt-1 truncate">{sub}</p>
          )}
        </div>
      </div>
    </Comp>
  );
}
