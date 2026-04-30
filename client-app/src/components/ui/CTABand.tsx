import { type ReactNode, type CSSProperties } from 'react';
import clsx from 'clsx';

export type CTABandTone = 'inverse' | 'primary' | 'subtle' | 'gradient';

export interface CTABandProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions: ReactNode;
  tone?: CTABandTone;
  align?: 'center' | 'split';
  className?: string;
}

// Each tone owns its own bg/copy pairing so dark-mode contrast holds
// (notably `primary` must pair bg-primary with text-on-primary).
const TONE_STYLE: Record<
  CTABandTone,
  { bg: string; eyebrow: string; title: string; description: string; style?: CSSProperties }
> = {
  inverse: {
    bg: 'bg-sidebar-bg',
    eyebrow: 'text-on-sidebar opacity-80',
    title: 'text-on-sidebar',
    description: 'text-on-sidebar opacity-80',
  },
  primary: {
    bg: 'bg-primary',
    eyebrow: 'text-on-primary opacity-80',
    title: 'text-on-primary',
    description: 'text-on-primary opacity-80',
  },
  subtle: {
    bg: 'bg-surface-secondary',
    eyebrow: 'text-primary',
    title: 'text-text-primary',
    description: 'text-text-secondary',
  },
  gradient: {
    bg: '',
    eyebrow: 'text-on-sidebar opacity-80',
    title: 'text-on-sidebar',
    description: 'text-on-sidebar opacity-80',
    style: {
      background:
        'linear-gradient(135deg, var(--color-sidebar-bg) 0%, var(--color-primary) 120%)',
    },
  },
};

/** Footer-of-section CTA band for a single conversion action. */
export default function CTABand({
  eyebrow,
  title,
  description,
  actions,
  tone = 'inverse',
  align = 'split',
  className,
}: CTABandProps) {
  const toneStyle = TONE_STYLE[tone];
  const split = align === 'split';
  return (
    <section
      className={clsx('rounded-2xl px-6 py-10 sm:px-10 sm:py-12 shadow-[var(--elevation-2)]', toneStyle.bg, className)}
      style={toneStyle.style}
    >
      <div
        className={clsx(
          split
            ? 'flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between'
            : 'flex flex-col items-center text-center gap-6',
        )}
      >
        <div className={clsx(split ? 'max-w-2xl' : 'max-w-2xl')}>
          {eyebrow && (
            <span
              className={clsx('text-xs font-semibold uppercase tracking-wider', toneStyle.eyebrow)}
            >
              {eyebrow}
            </span>
          )}
          <h3
            className={clsx(
              'font-display text-2xl sm:text-3xl font-bold tracking-tight mt-1',
              toneStyle.title,
            )}
          >
            {title}
          </h3>
          {description && (
            <p
              className={clsx('mt-2 text-base leading-relaxed', toneStyle.description)}
            >
              {description}
            </p>
          )}
        </div>
        <div className={clsx('flex flex-wrap gap-3 shrink-0', !split && 'justify-center')}>
          {actions}
        </div>
      </div>
    </section>
  );
}
