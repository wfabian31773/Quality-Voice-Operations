import { type ReactNode } from 'react';
import clsx from 'clsx';

export interface SectionHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  align?: 'left' | 'center';
  size?: 'md' | 'lg' | 'xl';
  className?: string;
  /** Sit on top of dark surfaces (e.g. `tone="inverse"` PageSection). */
  inverse?: boolean;
  children?: ReactNode;
}

const TITLE_SIZE: Record<NonNullable<SectionHeaderProps['size']>, string> = {
  md: 'text-2xl sm:text-3xl',
  lg: 'text-3xl sm:text-4xl',
  xl: 'text-4xl sm:text-5xl lg:text-6xl',
};

/** Eyebrow + title + description block. Pairs with `<PageSection>`. */
export default function SectionHeader({
  eyebrow,
  title,
  description,
  align = 'left',
  size = 'lg',
  className,
  inverse = false,
  children,
}: SectionHeaderProps) {
  const isCentered = align === 'center';
  return (
    <header
      className={clsx(
        'flex flex-col gap-3',
        isCentered ? 'items-center text-center mx-auto max-w-3xl' : 'items-start text-left',
        className,
      )}
    >
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
      <h2
        className={clsx(
          'font-display font-bold tracking-tight',
          TITLE_SIZE[size],
          inverse ? 'text-on-sidebar' : 'text-text-primary',
        )}
      >
        {title}
      </h2>
      {description && (
        <p
          className={clsx(
            'text-base sm:text-lg leading-relaxed max-w-2xl',
            inverse ? 'text-on-sidebar opacity-80' : 'text-text-secondary',
          )}
        >
          {description}
        </p>
      )}
      {children}
    </header>
  );
}
