import type { TourStep } from '../ProductTour';

export const digitalTwinTour: TourStep[] = [
  {
    selector: '[data-tour="twin-header"]',
    title: 'Welcome to Digital Twin',
    description: 'Digital Twin is a safe sandbox of your operations. Try out staffing changes, pricing tweaks, or new workflows here before rolling them out for real.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="twin-new-model"]',
    title: 'Create a model of your business',
    description: 'A model is a snapshot of how your business currently runs — call volume, agents, costs, conversion rates. You can have several (e.g., one per location).',
    placement: 'left',
  },
  {
    // Anchor on the always-present "New Model" button rather than the tabs
    // bar (which only renders once a model is selected) so the tour never
    // falls back to a centered tooltip with no highlight.
    selector: '[data-tour="twin-new-model"]',
    title: 'Run simulations and forecasts',
    description: 'Once you have a model, you\u2019ll see tabs for Run Simulation (change one variable, see projected impact), Forecasts (project your trajectory weeks ahead), and Results (history of every run so you can compare).',
    placement: 'left',
  },
];
