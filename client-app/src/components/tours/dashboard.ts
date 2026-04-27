import type { TourStep } from '../ProductTour';

export const dashboardTour: TourStep[] = [
  {
    selector: '[data-tour="agents"]',
    title: 'Build voice agents',
    description: 'Create and tune AI voice agents in minutes. Each agent can answer calls, follow workflows, and use tools.',
    path: '/dashboard',
    placement: 'right',
  },
  {
    selector: '[data-tour="campaigns"]',
    title: 'Run outbound campaigns',
    description: 'Upload contact lists and launch outbound calls — appointment reminders, follow-ups, win-back, and more.',
    path: '/dashboard',
    placement: 'right',
  },
  {
    selector: '[data-tour="conversations"]',
    title: 'Review every call',
    description: 'Listen to recordings, read transcripts, see outcomes, and follow up on escalations from one place.',
    path: '/dashboard',
    placement: 'right',
  },
  {
    selector: '[data-tour="analytics"]',
    title: 'Measure what matters',
    description: 'Calls handled, automation rate, revenue attributed, and tool reliability — all live from your tenant data.',
    path: '/dashboard',
    placement: 'right',
  },
  {
    selector: '[data-tour="help"]',
    title: 'Help when you need it',
    description: "Press \u2318K for the command palette, or click here for docs, shortcuts, support, and what's new.",
    path: '/dashboard',
    placement: 'left',
  },
];
