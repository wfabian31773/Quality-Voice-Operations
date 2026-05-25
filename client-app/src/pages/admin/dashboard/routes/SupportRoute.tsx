import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { SupportInboxTab } from '../../../PlatformAdmin';

/**
 * Honors `#bounced-recipients-panel` hash on mount so the deep link
 * from the dashboard's "Bounced" StatCard scrolls into view. The hash
 * stays in the URL but we only act on it once per mount — re-scrolling
 * on every hashchange would fight the user's manual scrolling.
 */
export default function SupportRoute() {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash !== '#bounced-recipients-panel') return;
    // Defer one frame so the panel has had a chance to render before
    // we look for it. Mirrors the original behavior from PlatformAdmin
    // where the scroll was wrapped in requestAnimationFrame.
    const id = window.requestAnimationFrame(() => {
      document
        .getElementById('bounced-recipients-panel')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [hash]);

  return <SupportInboxTab />;
}
