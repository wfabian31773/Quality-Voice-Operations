import clsx from 'clsx';
import type { BadgeTone } from './StatusBadge';

export type DotSize = 'xs' | 'sm' | 'md';

export interface StatusDotProps {
  /**
   * Required, plain-language description of what this coloured dot means
   * (e.g. "Live calls in progress"). Surfaced both as a hover tooltip and
   * as the dot's accessible name so screen-reader users hear the same
   * context that sighted users infer from the colour.
   */
  label: string;
  tone?: BadgeTone;
  size?: DotSize;
  /** Apply the inner-dot pulsing animation. */
  pulse?: boolean;
  /** Render an outer ping ring. */
  ping?: boolean;
  className?: string;
}

const TONE_BG: Record<BadgeTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
  neutral: 'bg-text-muted',
};

const SIZE: Record<DotSize, string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
};

export default function StatusDot({
  label,
  tone = 'success',
  size = 'sm',
  pulse = false,
  ping = false,
  className,
}: StatusDotProps) {
  const sizeCls = SIZE[size];
  const colorCls = TONE_BG[tone];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={clsx('relative inline-flex items-center justify-center', sizeCls, className)}
    >
      {ping ? (
        <span
          aria-hidden="true"
          className={clsx(
            'absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping',
            colorCls,
          )}
        />
      ) : null}
      <span
        aria-hidden="true"
        className={clsx(
          'relative inline-flex rounded-full',
          sizeCls,
          colorCls,
          pulse && 'motion-safe:animate-pulse',
        )}
      />
    </span>
  );
}
