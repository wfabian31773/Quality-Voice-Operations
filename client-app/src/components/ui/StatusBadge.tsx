import { type ReactNode } from 'react';
import clsx from 'clsx';

export type BadgeTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';
export type BadgeSize = 'sm' | 'md';
export type BadgeVariant = 'soft' | 'solid' | 'outline';

export interface StatusBadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  size?: BadgeSize;
  variant?: BadgeVariant;
  icon?: ReactNode;
  pill?: boolean;
  className?: string;
}

const SOFT: Record<BadgeTone, string> = {
  primary: 'bg-primary-light text-primary',
  success: 'bg-success-light text-success',
  warning: 'bg-warning-light text-warning',
  danger: 'bg-danger-light text-danger',
  info: 'bg-info-light text-info',
  accent: 'bg-accent-light text-accent',
  neutral: 'bg-surface-hover text-text-secondary',
};

const SOLID: Record<BadgeTone, string> = {
  primary: 'bg-primary text-on-primary',
  success: 'bg-success text-white',
  warning: 'bg-warning text-white',
  danger: 'bg-danger text-white',
  info: 'bg-info text-white',
  accent: 'bg-accent text-on-accent',
  neutral: 'bg-text-secondary text-white',
};

const OUTLINE: Record<BadgeTone, string> = {
  primary: 'border-primary/40 text-primary',
  success: 'border-success/40 text-success',
  warning: 'border-warning/40 text-warning',
  danger: 'border-danger/40 text-danger',
  info: 'border-info/40 text-info',
  accent: 'border-accent/40 text-accent',
  neutral: 'border-border text-text-secondary',
};

export default function StatusBadge({
  children,
  tone = 'neutral',
  size = 'sm',
  variant = 'soft',
  icon,
  pill = true,
  className,
}: StatusBadgeProps) {
  const sizing =
    size === 'sm'
      ? 'text-[11px] px-2 py-0.5 gap-1'
      : 'text-xs px-2.5 py-1 gap-1.5';
  const palette =
    variant === 'soft' ? SOFT[tone] : variant === 'solid' ? SOLID[tone] : `border ${OUTLINE[tone]}`;
  const radius = pill ? 'rounded-full' : 'rounded-md';
  return (
    <span
      className={clsx(
        'inline-flex items-center font-medium whitespace-nowrap',
        sizing,
        palette,
        radius,
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
