import { type ReactNode, type CSSProperties } from 'react';
import clsx from 'clsx';

export type HeroTone = 'plain' | 'subtle' | 'inverse' | 'gradient';
export type HeroAlign = 'left' | 'center';

export interface HeroProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Primary + secondary CTAs (or anything else action-shaped). */
  actions?: ReactNode;
  /** Right-rail media (image, mockup, animation). Pushes layout to two columns. */
  media?: ReactNode;
  /** Optional row above eyebrow — e.g. trust strip, "trusted by" logos. */
  trust?: ReactNode;
  /** Optional row below CTAs — e.g. small caveat ("No credit card required"). */
  meta?: ReactNode;
  tone?: HeroTone;
  align?: HeroAlign;
  /** Tighten vertical padding when the hero precedes another tight section. */
  size?: 'compact' | 'default' | 'tall';
  className?: string;
  innerClassName?: string;
  id?: string;
}

const TONE_CLASS: Record<HeroTone, string> = {
  plain: 'bg-surface text-text-primary',
  subtle: 'bg-surface-secondary text-text-primary',
  inverse: 'bg-sidebar-bg text-on-sidebar',
  gradient: 'text-text-primary',
};

const SIZE_CLASS: Record<NonNullable<HeroProps['size']>, string> = {
  compact: 'py-12 lg:py-16',
  default: 'py-16 lg:py-24',
  tall: 'py-20 lg:py-32',
};

/** Top-of-page hero block. With `media` it lays out two columns; without it it centers. */
export default function Hero({
  eyebrow,
  title,
  description,
  actions,
  media,
  trust,
  meta,
  tone = 'plain',
  align = 'left',
  size = 'default',
  className,
  innerClassName,
  id,
}: HeroProps) {
  const inverse = tone === 'inverse';
  const isTwoCol = !!media;
  const isCentered = align === 'center' && !isTwoCol;

  const gradientStyle: CSSProperties | undefined =
    tone === 'gradient'
      ? {
          background:
            'linear-gradient(180deg, var(--color-primary-light) 0%, var(--color-surface-secondary) 60%, var(--color-surface) 100%)',
        }
      : undefined;

  return (
    <section
      id={id}
      className={clsx('relative overflow-hidden', TONE_CLASS[tone], SIZE_CLASS[size], className)}
      style={gradientStyle}
    >
      <div className={clsx('mx-auto max-w-7xl px-6 lg:px-8', innerClassName)}>
        {trust && (
          <div className={clsx('mb-8', isCentered && 'flex justify-center')}>{trust}</div>
        )}
        <div
          className={clsx(
            isTwoCol
              ? 'grid lg:grid-cols-2 gap-10 lg:gap-16 items-center'
              : isCentered
                ? 'flex flex-col items-center text-center max-w-3xl mx-auto'
                : 'flex flex-col max-w-3xl',
          )}
        >
          <div className={clsx('flex flex-col gap-4', isCentered && 'items-center text-center')}>
            {eyebrow && (
              <span
                className={clsx(
                  'text-xs font-semibold uppercase tracking-wider',
                  inverse ? 'text-on-sidebar opacity-80' : 'text-primary',
                )}
              >
                {eyebrow}
              </span>
            )}
            <h1
              className={clsx(
                'font-display font-bold tracking-tight text-4xl sm:text-5xl lg:text-6xl',
                inverse ? 'text-on-sidebar' : 'text-text-primary',
              )}
            >
              {title}
            </h1>
            {description && (
              <p
                className={clsx(
                  'text-lg sm:text-xl leading-relaxed max-w-2xl',
                  inverse ? 'text-on-sidebar opacity-80' : 'text-text-secondary',
                )}
              >
                {description}
              </p>
            )}
            {actions && (
              <div
                className={clsx(
                  'mt-4 flex flex-wrap items-center gap-3',
                  isCentered && 'justify-center',
                )}
              >
                {actions}
              </div>
            )}
            {meta && (
              <div
                className={clsx(
                  'text-sm',
                  inverse ? 'text-on-sidebar opacity-70' : 'text-text-muted',
                )}
              >
                {meta}
              </div>
            )}
          </div>
          {media && <div className="relative">{media}</div>}
        </div>
      </div>
    </section>
  );
}
