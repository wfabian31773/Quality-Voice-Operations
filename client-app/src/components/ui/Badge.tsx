import { type ReactNode } from 'react';
import clsx from 'clsx';

export type BadgeVariant =
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'accent'
  | 'neutral'
  | 'inverse';

export type BadgeSize = 'sm' | 'md';

export interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Add a visible dot before the label (drops the icon if both are set). */
  dot?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

// Tinted variants use `text-text-primary` for AA contrast; identity is
// carried by the bg tint + the optional dot/icon.
const VARIANT_CLASS: Record<BadgeVariant, string> = {
  primary: 'bg-primary-light text-text-primary',
  success: 'bg-success-light text-text-primary',
  warning: 'bg-warning-light text-text-primary',
  danger: 'bg-danger-light text-text-primary',
  info: 'bg-info-light text-text-primary',
  accent: 'bg-accent-light text-text-primary',
  neutral: 'bg-surface-hover text-text-primary',
  inverse: 'bg-on-sidebar/15 text-on-sidebar border border-on-sidebar/15',
};

const VARIANT_DOT_CLASS: Record<BadgeVariant, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
  neutral: 'bg-text-secondary',
  inverse: 'bg-on-sidebar',
};

const SIZE_CLASS: Record<BadgeSize, string> = {
  sm: 'text-[10px] px-1.5 py-0.5 gap-1',
  md: 'text-xs px-2 py-0.5 gap-1.5',
};

/** Small token-resolved pill: tags, "New", version stamps, console badges. */
export default function Badge({
  variant = 'neutral',
  size = 'md',
  dot = false,
  icon,
  className,
  children,
}: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center font-semibold uppercase tracking-wider rounded-full',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
    >
      {dot ? (
        <span
          className={clsx('h-1.5 w-1.5 rounded-full', VARIANT_DOT_CLASS[variant])}
          aria-hidden="true"
        />
      ) : (
        icon
      )}
      {children}
    </span>
  );
}
