import { type ReactNode } from 'react';
import { type LucideIcon, Info, AlertTriangle, CheckCircle2, AlertCircle } from 'lucide-react';
import clsx from 'clsx';

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export interface CalloutProps {
  tone?: CalloutTone;
  title?: ReactNode;
  /** Override the default icon for the chosen tone. */
  icon?: LucideIcon;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}

const TONE_CLASS: Record<CalloutTone, string> = {
  info: 'bg-info-light/60 border border-info/30 text-text-primary',
  success: 'bg-success-light/60 border border-success/30 text-text-primary',
  warning: 'bg-warning-light/60 border border-warning/30 text-text-primary',
  danger: 'bg-danger-light/60 border border-danger/30 text-text-primary',
  neutral: 'bg-surface-secondary border border-border text-text-primary',
};

const TONE_ICON_CLASS: Record<CalloutTone, string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-text-secondary',
};

const DEFAULT_ICON: Record<CalloutTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
  neutral: Info,
};

const ARIA_ROLE: Record<CalloutTone, 'status' | 'alert' | 'note'> = {
  info: 'note',
  success: 'status',
  warning: 'alert',
  danger: 'alert',
  neutral: 'note',
};

/** Inline informational box. Pairs an icon with the message so meaning isn't colour-only. */
export default function Callout({
  tone = 'info',
  title,
  icon,
  actions,
  className,
  children,
}: CalloutProps) {
  const Icon = icon ?? DEFAULT_ICON[tone];
  return (
    <div
      role={ARIA_ROLE[tone]}
      className={clsx('rounded-xl p-4 sm:p-5 flex gap-3', TONE_CLASS[tone], className)}
    >
      <Icon
        className={clsx('h-5 w-5 mt-0.5 shrink-0', TONE_ICON_CLASS[tone])}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        {title && (
          <p className="font-semibold text-sm text-text-primary mb-0.5">{title}</p>
        )}
        {children && (
          <div className="text-sm text-text-secondary leading-relaxed">{children}</div>
        )}
        {actions && (
          <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
}
