import type { TourStep } from '../ProductTour';

export const autopilotTour: TourStep[] = [
  {
    selector: '[data-tour="autopilot-header"]',
    title: 'Welcome to AI Business Autopilot',
    description: 'Autopilot proactively scans your operations, flags issues, and recommends concrete actions you can approve in one click.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="autopilot-run-scan"]',
    title: 'Trigger an on-demand scan',
    description: "Autopilot scans on its own schedule, but you can run a fresh scan anytime — for example after a big change to your call volume or pricing.",
    placement: 'left',
  },
  {
    selector: '[data-tour="autopilot-summary"]',
    title: 'Your live operations summary',
    description: 'These cards show how many issues Autopilot is currently tracking, how many recommendations are awaiting your review, and the revenue impact of what you\u2019ve already approved.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="autopilot-tabs"]',
    title: 'Insights, recommendations, and actions',
    description: 'Insights are what Autopilot found. Recommendations are what it thinks you should do. Action History shows what was actually executed. Policies let you tell Autopilot what it can do without asking.',
    placement: 'bottom',
  },
];
