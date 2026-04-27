import type { TourStep } from '../ProductTour';

export const evolutionEngineTour: TourStep[] = [
  {
    selector: '[data-tour="evolution-header"]',
    title: 'Welcome to the Platform Evolution Engine',
    description: 'Evolution Engine watches signals from your usage, support tickets, and feature requests, then proposes prioritized recommendations for what to ship next.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="evolution-run-pipeline"]',
    title: 'Run the analysis pipeline',
    description: 'The pipeline runs on a schedule, but you can trigger it on demand to fold in your latest data and regenerate recommendations.',
    placement: 'left',
  },
  {
    selector: '[data-tour="evolution-tabs"]',
    title: 'From signals to experiments',
    description: 'Signals are raw inputs. Opportunities are themes Evolution Engine clustered. Recommendations are prioritized actions. Experiments lets you run an A/B test against any of them.',
    placement: 'bottom',
  },
];
