import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle } from 'lucide-react';
import ProductTour, { type TourStep, getTourCompleted } from './ProductTour';

interface TourLauncherProps {
  tourId: string;
  steps: TourStep[];
  /**
   * Auto-launch on first visit when the tour has never been completed.
   * Defaults to true. Set false to require explicit user click.
   */
  autoLaunch?: boolean;
  /**
   * Optional gate — when false, the tour will not auto-launch even on
   * first visit (e.g. wait for tenant data to load before starting).
   */
  ready?: boolean;
  /**
   * Tooltip / aria-label for the help button.
   */
  buttonLabel?: string;
}

/**
 * Renders a "?" help button that opens a guided tour for the current page.
 * Auto-launches the tour on the user's first visit (per-tour storage).
 *
 * Use one per surface; place inside the page header.
 */
export default function TourLauncher({
  tourId,
  steps,
  autoLaunch = true,
  ready = true,
  buttonLabel,
}: TourLauncherProps) {
  const { t } = useTranslation('tenant');
  const [open, setOpen] = useState(false);
  const label = buttonLabel ?? t('tour_launcher.default_label');

  useEffect(() => {
    if (!autoLaunch || !ready) return;
    if (getTourCompleted(tourId)) return;
    // Brief delay so the page has time to mount the tour-target elements.
    const t = setTimeout(() => setOpen(true), 800);
    return () => clearTimeout(t);
  }, [autoLaunch, ready, tourId]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        data-testid={`tour-launcher-${tourId}`}
        className="inline-flex items-center justify-center h-7 w-7 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
      >
        <HelpCircle className="h-4 w-4" />
      </button>
      <ProductTour
        active={open}
        onClose={() => setOpen(false)}
        steps={steps}
        tourId={tourId}
      />
    </>
  );
}
