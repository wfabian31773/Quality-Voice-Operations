import { useReveal } from '../hooks/useReveal';

/**
 * Legacy wrapper kept for the existing public marketing pages. Now backed by
 * the token-driven `useReveal` hook + `.motion-reveal` class so timing/easing
 * come from the design tokens. The `delay` prop accepts the existing
 * `scroll-delay-N` utilities, which still apply transition-delay.
 */
export default function RevealSection({
  children,
  className = '',
  delay = '',
}: {
  children: React.ReactNode;
  className?: string;
  delay?: string;
}) {
  const ref = useReveal();
  return (
    <div ref={ref} className={`motion-reveal ${delay} ${className}`}>
      {children}
    </div>
  );
}
