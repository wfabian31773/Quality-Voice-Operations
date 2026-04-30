import { useEffect, useRef } from 'react';
import { reducedMotion } from './useScrollReveal';

interface UseRevealOptions {
  /**
   * 0–1, fraction of the element that must be visible before the reveal
   * fires. Defaults to 0.15.
   */
  threshold?: number;
  /**
   * If true, the reveal fires only the first time the element is in view
   * and the observer is then disconnected. Defaults to true.
   */
  once?: boolean;
}

/**
 * Token-aware entrance reveal. Adds `data-reveal="ready"` to the element
 * when off-screen and `data-reveal="visible"` once it scrolls into view.
 * Pair with the `.motion-reveal` CSS class in `tokens.css`, which animates
 * `opacity` and `transform` using `--motion-base` + `--easing-emphasized`
 * and short-circuits cleanly under `prefers-reduced-motion`.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>({
  threshold = 0.15,
  once = true,
}: UseRevealOptions = {}) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion) {
      el.setAttribute('data-reveal', 'visible');
      return;
    }
    el.setAttribute('data-reveal', 'ready');
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.setAttribute('data-reveal', 'visible');
          if (once) observer.unobserve(el);
        } else if (!once) {
          el.setAttribute('data-reveal', 'ready');
        }
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold, once]);
  return ref;
}
