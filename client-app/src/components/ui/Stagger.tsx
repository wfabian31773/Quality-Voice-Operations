import { type ReactNode, type CSSProperties, type ElementType, type HTMLAttributes } from 'react';
import clsx from 'clsx';
import { useStagger } from '../../hooks/useStagger';

export interface StaggerProps extends HTMLAttributes<HTMLElement> {
  /** Per-step delay between children, in milliseconds. */
  step?: number;
  threshold?: number;
  style?: CSSProperties;
  as?: ElementType;
  children: ReactNode;
}

export default function Stagger({
  step = 60,
  threshold = 0.1,
  className,
  style,
  as: Comp = 'div',
  children,
  ...rest
}: StaggerProps) {
  const ref = useStagger<HTMLDivElement>({ step, threshold });
  return (
    <Comp {...rest} ref={ref} className={clsx(className)} style={style}>
      {children}
    </Comp>
  );
}
