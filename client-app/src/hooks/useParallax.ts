import { useEffect, useRef } from 'react';
import { reducedMotion } from './useScrollReveal';

interface UseParallaxOptions {
  /** Max vertical translate in px applied at full in-view. Default 8. */
  distance?: number;
}

/**
 * Parallax-lite: drives the `--parallax-y` custom property on the element
 * as it scrolls through the viewport. Pair with `.motion-parallax` from
 * `tokens.css`. Short-circuits to `0px` under `prefers-reduced-motion`.
 */
export function useParallax<T extends HTMLElement = HTMLDivElement>({
  distance = 8,
}: UseParallaxOptions = {}) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion) {
      el.style.setProperty('--parallax-y', '0px');
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const progress = Math.max(0, Math.min(1, 1 - (rect.top + rect.height / 2) / vh));
      const y = (progress - 0.5) * 2 * distance;
      el.style.setProperty('--parallax-y', `${y.toFixed(2)}px`);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [distance]);
  return ref;
}
