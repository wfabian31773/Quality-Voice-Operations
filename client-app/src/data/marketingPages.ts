import type { LucideIcon } from 'lucide-react';
import { Phone, Briefcase, Stethoscope, Smile } from 'lucide-react';

export type MarketingPageCategory = 'Product' | 'Industries' | 'Resources';

export interface MarketingPage {
  slug: string;
  path: string;
  title: string;
  description: string;
  category: MarketingPageCategory;
  icon: LucideIcon;
  keywords: string[];
}

export const marketingPages: MarketingPage[] = [
  // ---------- Focused offer ----------
  {
    slug: 'pricing',
    path: '/pricing',
    title: 'Pricing',
    description: 'Plans for solo operators, growing teams, and multi-location enterprises.',
    category: 'Product',
    icon: Briefcase,
    keywords: ['pricing', 'plans', 'cost', 'billing'],
  },
  // ---------- Healthcare use cases ----------
  {
    slug: 'healthcare',
    path: '/industries/healthcare',
    title: 'Healthcare',
    description: 'HIPAA-aware voice AI for patient scheduling, intake, refills, and after-hours triage.',
    category: 'Industries',
    icon: Stethoscope,
    keywords: ['healthcare', 'medical', 'hipaa', 'patient', 'clinic'],
  },
  {
    slug: 'dental',
    path: '/industries/dental',
    title: 'Dental',
    description: 'Voice agents for dental practices — appointment scheduling, recall outreach, and insurance triage.',
    category: 'Industries',
    icon: Smile,
    keywords: ['dental', 'dentist', 'practice', 'appointments'],
  },
  {
    slug: 'demo',
    path: '/demo',
    title: 'Live demo',
    description: 'Try a live QVO voice agent in your browser — no signup required.',
    category: 'Resources',
    icon: Phone,
    keywords: ['demo', 'try', 'live', 'voice'],
  },
];

// Locale-aware search lives in `client-app/src/lib/translateMarketingPage.ts`
// (see `useSearchMarketingPages` / `searchMarketingPagesLocalized`). The old
// English-only helper was removed because it could not match translated
// marketing copy.
