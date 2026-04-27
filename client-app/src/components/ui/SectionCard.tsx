import { type ReactNode } from 'react';
import clsx from 'clsx';

export interface SectionCardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  padded?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export default function SectionCard({
  title,
  description,
  actions,
  footer,
  padded = true,
  className,
  bodyClassName,
  children,
}: SectionCardProps) {
  return (
    <section
      className={clsx(
        'bg-surface border border-border rounded-xl shadow-[var(--elevation-1)] overflow-hidden',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            )}
            {description && (
              <p className="text-xs text-text-secondary mt-0.5">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded ? 'p-5' : '', bodyClassName)}>{children}</div>
      {footer && (
        <footer className="px-5 py-3 border-t border-border bg-surface-secondary text-xs text-text-secondary">
          {footer}
        </footer>
      )}
    </section>
  );
}
