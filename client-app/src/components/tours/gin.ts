import type { TourStep } from '../ProductTour';

export const ginTour: TourStep[] = [
  {
    selector: '[data-tour="gin-header"]',
    title: 'Welcome to the Global Intelligence Network',
    description: 'GIN aggregates anonymized metrics across all participating tenants in your industry, so you can see how you stack up and learn from what works for similar businesses.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="gin-tabs"]',
    title: 'Benchmarks, best practices, recommendations',
    description: 'Industry Benchmarks compare your numbers to peers. Best Practices Library is patterns that work for businesses like yours. Recommendations are GIN-suggested actions tailored to you.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="gin-participation"]',
    title: 'Your participation status',
    description: 'GIN only aggregates anonymized metrics from tenants who opt in. This badge shows whether you\u2019re currently sharing — head to the "Participation Settings" tab to toggle it. Your raw call data is never shared.',
    placement: 'bottom',
  },
];
