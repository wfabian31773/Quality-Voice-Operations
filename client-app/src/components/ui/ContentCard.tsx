import {
  type ReactNode,
  type ElementType,
  type HTMLAttributes,
  type ButtonHTMLAttributes,
  type AnchorHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';

export type ContentCardTone = 'default' | 'subtle' | 'primary' | 'inverse';
export type ContentCardPad = 'none' | 'sm' | 'md' | 'lg';

type DOMProps = HTMLAttributes<HTMLElement> &
  Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'type'> &
  Pick<AnchorHTMLAttributes<HTMLAnchorElement>, 'target' | 'rel'>;

export interface ContentCardProps extends DOMProps {
  tone?: ContentCardTone;
  pad?: ContentCardPad;
  /** Adds the shared `motion-hover-lift` interaction. */
  interactive?: boolean;
  /** Render as a different element. Auto-resolved when `href`/`to`/`onClick` is set. */
  as?: ElementType;
  /** External link → renders `<a href>`. */
  href?: string;
  /** Internal route → renders react-router `<Link to>`. */
  to?: string;
  children: ReactNode;
}

const TONE_CLASS: Record<ContentCardTone, string> = {
  default: 'bg-surface border border-border text-text-primary',
  subtle: 'bg-surface-secondary border border-border text-text-primary',
  primary:
    'bg-primary-light border border-primary/20 text-text-primary',
  inverse: 'bg-sidebar-bg border border-on-sidebar/10 text-on-sidebar',
};

const PAD_CLASS: Record<ContentCardPad, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-7',
};

export default function ContentCard({
  tone = 'default',
  pad = 'md',
  interactive = false,
  as,
  href,
  to,
  onClick,
  type,
  className,
  children,
  ...rest
}: ContentCardProps) {
  const Comp: ElementType =
    as ?? (to ? Link : href ? 'a' : onClick ? 'button' : 'div');
  const isInteractive = interactive || !!onClick || !!href || !!to;
  // Only forward to/href/type to elements that accept them.
  const linkProps = Comp === Link ? { to } : undefined;
  const anchorProps = Comp === 'a' ? { href } : undefined;
  const buttonProps = Comp === 'button' ? { type: type ?? 'button' } : undefined;
  return (
    <Comp
      {...rest}
      {...linkProps}
      {...anchorProps}
      {...buttonProps}
      onClick={onClick}
      className={clsx(
        'rounded-xl shadow-[var(--elevation-1)]',
        TONE_CLASS[tone],
        PAD_CLASS[pad],
        isInteractive && 'motion-hover-lift cursor-pointer',
        (onClick || Comp === 'button') &&
          'text-left w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        className,
      )}
    >
      {children}
    </Comp>
  );
}
