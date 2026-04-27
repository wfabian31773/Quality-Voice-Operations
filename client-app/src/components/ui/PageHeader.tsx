import { type ReactNode } from 'react';
import clsx from 'clsx';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  icon?: ReactNode;
  className?: string;
  size?: 'default' | 'compact';
}

export default function PageHeader({
  title,
  description,
  status,
  actions,
  breadcrumbs,
  icon,
  className,
  size = 'default',
}: PageHeaderProps) {
  const titleClass = size === 'compact'
    ? 'text-xl font-semibold tracking-tight font-display'
    : 'text-2xl font-bold tracking-tight font-display';

  return (
    <header
      className={clsx(
        'flex flex-col gap-3 mb-6 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {icon && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary">
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {breadcrumbs && (
            <div className="mb-2 text-xs text-text-muted">{breadcrumbs}</div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <h1 className={clsx(titleClass, 'text-text-primary')}>{title}</h1>
            {status}
          </div>
          {description && (
            <p className="mt-1 text-sm text-text-secondary max-w-3xl">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>
      )}
    </header>
  );
}
