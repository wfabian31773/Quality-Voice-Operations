import { type ReactNode, type CSSProperties, type ElementType } from 'react';
import clsx from 'clsx';

export type PageSectionTone =
  | 'plain'
  | 'subtle'
  | 'inverse'
  | 'gradient';

export type PageSectionPad = 'sm' | 'md' | 'lg' | 'xl';
export type PageSectionWidth = 'narrow' | 'standard' | 'wide' | 'full';

export interface PageSectionProps {
  tone?: PageSectionTone;
  pad?: PageSectionPad;
  width?: PageSectionWidth;
  as?: ElementType;
  id?: string;
  className?: string;
  innerClassName?: string;
  style?: CSSProperties;
  children: ReactNode;
}

const TONE_CLASS: Record<PageSectionTone, string> = {
  plain: 'bg-surface text-text-primary',
  subtle: 'bg-surface-secondary text-text-primary',
  inverse: 'bg-sidebar-bg text-on-sidebar',
  gradient: 'bg-surface-secondary text-text-primary',
};

const PAD_CLASS: Record<PageSectionPad, string> = {
  sm: 'py-10 lg:py-12',
  md: 'py-14 lg:py-16',
  lg: 'py-20 lg:py-24',
  xl: 'py-24 lg:py-32',
};

const WIDTH_CLASS: Record<PageSectionWidth, string> = {
  narrow: 'max-w-3xl',
  standard: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

/** Vertically-padded section wrapper with shared tone, padding, and max-width steps. */
export default function PageSection({
  tone = 'plain',
  pad = 'lg',
  width = 'wide',
  as: Comp = 'section',
  id,
  className,
  innerClassName,
  style,
  children,
}: PageSectionProps) {
  const gradientStyle: CSSProperties | undefined =
    tone === 'gradient'
      ? {
          background:
            'linear-gradient(180deg, var(--color-primary-light) 0%, var(--color-surface-secondary) 60%, var(--color-surface) 100%)',
        }
      : undefined;
  return (
    <Comp
      id={id}
      className={clsx(TONE_CLASS[tone], PAD_CLASS[pad], className)}
      style={{ ...gradientStyle, ...style }}
    >
      <div
        className={clsx(
          'mx-auto px-6 lg:px-8',
          WIDTH_CLASS[width],
          innerClassName,
        )}
      >
        {children}
      </div>
    </Comp>
  );
}
