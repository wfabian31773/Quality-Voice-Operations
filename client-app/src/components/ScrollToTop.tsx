/**
 * Resets window scroll position to the top on route change.
 *
 * Default React Router behavior leaves `window.scrollY` wherever the
 * previous page left it — so if you scroll halfway down the /pricing
 * page and click a link to /features, you land mid-way through /features
 * instead of at the top. This is the classic SPA "lands at the bottom"
 * complaint.
 *
 * Renders nothing. Mount once inside the router, above any `<Outlet>`
 * so it fires on every navigation in both the public and authed app
 * trees.
 *
 * Edge cases handled:
 *
 *   1. **Hash links** (`/docs/quickstart#oauth-setup`) — the browser
 *      is already moving focus + scroll to the in-page anchor. Skipping
 *      our scroll-reset preserves that behavior.
 *
 *   2. **Back / forward navigation** — `useNavigationType()` returns
 *      `'POP'` when the user hit the browser back/forward button.
 *      The browser restores the prior scroll position automatically
 *      in that case; resetting to top here would feel jarring and
 *      destroy the user's "return to where I was" expectation.
 *
 *   3. **`behavior: 'instant'`** — explicit instant scroll (not smooth)
 *      so the page never animates the reset. Smooth scrolling on every
 *      navigation feels sluggish and motion-sensitive users can't opt
 *      out via prefers-reduced-motion on Safari.
 */
import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

export default function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    // Hash-link navigation: let the browser handle anchor jump.
    if (hash) return;
    // Back/forward navigation: let the browser restore prior position.
    if (navigationType === 'POP') return;

    // Forward navigation to a new page: snap to top.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname, hash, navigationType]);

  return null;
}
