import { type LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  primaryAction?: { label: string; onClick: () => void; icon?: LucideIcon };
  secondaryAction?: { label: string; onClick: () => void };
  variant?: 'default' | 'compact';
}

export default function EmptyState({
  icon: Icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  variant = 'default',
}: EmptyStateProps) {
  const padY = variant === 'compact' ? 'py-8' : 'py-14';
  const PrimaryIcon = primaryAction?.icon;
  return (
    <div className={`flex flex-col items-center justify-center text-center px-6 ${padY}`}>
      <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
        <Icon className="h-7 w-7 text-primary" />
      </div>
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      {description && (
        <p className="mt-1.5 text-sm text-text-secondary max-w-sm">{description}</p>
      )}
      {(primaryAction || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {primaryAction && (
            <button
              onClick={primaryAction.onClick}
              className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {PrimaryIcon && <PrimaryIcon className="h-4 w-4" />}
              {primaryAction.label}
            </button>
          )}
          {secondaryAction && (
            <button
              onClick={secondaryAction.onClick}
              className="inline-flex items-center text-sm font-medium text-text-secondary hover:text-text-primary px-3 py-2 rounded-lg border border-border hover:bg-surface-hover transition-colors"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
