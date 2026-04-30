import { type ReactNode, type CSSProperties, type ElementType, type HTMLAttributes } from 'react';
import clsx from 'clsx';
import { useReveal } from '../../hooks/useReveal';

export interface RevealProps extends HTMLAttributes<HTMLElement> {
  delay?: number;
  threshold?: number;
  /** When false, the reveal re-fires whenever the element re-enters view. */
  once?: boolean;
  style?: CSSProperties;
  as?: ElementType;
  children: ReactNode;
}

export default function Reveal({
  delay = 0,
  threshold = 0.15,
  once = true,
  className,
  style,
  as: Comp = 'div',
  children,
  ...rest
}: RevealProps) {
  const ref = useReveal<HTMLDivElement>({ threshold, once });
  return (
    <Comp
      {...rest}
      ref={ref}
      className={clsx('motion-reveal', className)}
      style={{ ['--motion-reveal-delay' as string]: `${delay}ms`, ...style }}
    >
      {children}
    </Comp>
  );
}
