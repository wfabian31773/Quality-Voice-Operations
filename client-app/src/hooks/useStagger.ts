import { useEffect, useRef } from 'react';
import { reducedMotion } from './useScrollReveal';

interface UseStaggerOptions {
  /**
   * Per-step delay between children, in milliseconds. Defaults to 60ms.
   * Multiplied by the child's index when assigning `--stagger-delay`.
   */
  step?: number;
  /**
   * Selector inside the container that identifies the staggered children.
   * Defaults to `[data-stagger-item]`.
   */
  childSelector?: string;
  /**
   * 0–1, fraction of the container that must be visible before the
   * staggered reveal fires. Defaults to 0.10.
   */
  threshold?: number;
}

/**
 * Token-aware staggered reveal. Walks every direct child matching
 * `childSelector` once the container scrolls into view, sets
 * `--stagger-delay: <index*step>ms` and `data-reveal="visible"` on each.
 * Pair with the `.motion-stagger-item` class in `tokens.css` (which
 * consumes `--stagger-delay` to offset the `motion-reveal` transition).
 *
 * `prefers-reduced-motion: reduce` short-circuits to "visible" without
 * any delay, exactly like {@link useReveal}.
 */
export function useStagger<T extends HTMLElement = HTMLDivElement>({
  step = 60,
  childSelector = '[data-stagger-item]',
  threshold = 0.1,
}: UseStaggerOptions = {}) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(childSelector));
    if (reducedMotion) {
      items.forEach((item) => {
        item.style.setProperty('--stagger-delay', '0ms');
        item.setAttribute('data-reveal', 'visible');
      });
      return;
    }
    items.forEach((item, i) => {
      item.style.setProperty('--stagger-delay', `${i * step}ms`);
      item.setAttribute('data-reveal', 'ready');
    });
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          items.forEach((item) => item.setAttribute('data-reveal', 'visible'));
          observer.unobserve(el);
        }
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [step, childSelector, threshold]);
  return ref;
}
