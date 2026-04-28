import { Link } from 'react-router-dom';
import { ArrowUpRight, Stethoscope, Smile, Scale, Home, Wrench, PawPrint, Car, Landmark, Hotel } from 'lucide-react';
import RevealSection from './RevealSection';

type Industry = {
  slug: string;
  name: string;
  tagline: string;
  image: string;
  icon: typeof Stethoscope;
  accent: string;
  ringColor: string;
  stat: { value: string; label: string };
};

const industries: Industry[] = [
  {
    slug: 'healthcare',
    name: 'Healthcare',
    tagline: 'Answer every patient call — HIPAA-aware, 24/7.',
    image: '/industry-hero/healthcare.jpg',
    icon: Stethoscope,
    accent: 'from-blue-500/70 to-primary/50',
    ringColor: 'ring-blue-400/30',
    stat: { value: '95%', label: 'Calls answered' },
  },
  {
    slug: 'dental',
    name: 'Dental',
    tagline: 'Fill your chairs and cut no-shows in half.',
    image: '/industry-hero/dental.jpg',
    icon: Smile,
    accent: 'from-cyan-500/70 to-primary/50',
    ringColor: 'ring-cyan-400/30',
    stat: { value: '35%', label: 'Fewer no-shows' },
  },
  {
    slug: 'legal',
    name: 'Legal',
    tagline: 'Professional intake for every case, day or night.',
    image: '/industry-hero/legal.jpg',
    icon: Scale,
    accent: 'from-amber-600/70 to-orange-500/40',
    ringColor: 'ring-amber-400/30',
    stat: { value: '$180K', label: 'Revenue recovered/yr' },
  },
  {
    slug: 'real-estate',
    name: 'Real Estate',
    tagline: 'Qualify leads in 30 seconds, book showings instantly.',
    image: '/industry-hero/real-estate.jpg',
    icon: Home,
    accent: 'from-emerald-500/70 to-primary/50',
    ringColor: 'ring-emerald-400/30',
    stat: { value: '< 30s', label: 'Lead response' },
  },
  {
    slug: 'home-services',
    name: 'Home Services',
    tagline: 'Catch every emergency call, dispatch in 5 minutes.',
    image: '/industry-hero/home-services.jpg',
    icon: Wrench,
    accent: 'from-orange-500/70 to-amber-500/50',
    ringColor: 'ring-orange-400/30',
    stat: { value: '100%', label: 'Emergencies captured' },
  },
  {
    slug: 'veterinary',
    name: 'Veterinary',
    tagline: 'Book visits and triage urgent pet care 24/7.',
    image: '/industry-hero/veterinary.jpg',
    icon: PawPrint,
    accent: 'from-green-500/70 to-primary/50',
    ringColor: 'ring-green-400/30',
    stat: { value: '40%', label: 'Tech hours freed' },
  },
  {
    slug: 'automotive',
    name: 'Automotive',
    tagline: 'Capture sales leads and book service in under a minute.',
    image: '/industry-hero/automotive.jpg',
    icon: Car,
    accent: 'from-slate-500/70 to-blue-500/40',
    ringColor: 'ring-slate-400/30',
    stat: { value: '4x', label: 'After-hours leads' },
  },
  {
    slug: 'finance',
    name: 'Financial Services',
    tagline: 'Compliant prospect intake and review scheduling.',
    image: '/industry-hero/finance.jpg',
    icon: Landmark,
    accent: 'from-indigo-500/70 to-blue-500/40',
    ringColor: 'ring-indigo-400/30',
    stat: { value: '< 60s', label: 'Lead response' },
  },
  {
    slug: 'hospitality',
    name: 'Hospitality',
    tagline: 'Multilingual reservations and guest concierge, 24/7.',
    image: '/industry-hero/hospitality.jpg',
    icon: Hotel,
    accent: 'from-amber-500/70 to-rose-500/40',
    ringColor: 'ring-amber-400/30',
    stat: { value: '38%', label: 'Direct bookings lift' },
  },
];

export default function IndustryShowcase() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      {industries.map((ind, i) => {
        const Icon = ind.icon;
        // First item spans 2 cols on lg screens for a bento feel
        const featured = i === 0;
        return (
          <RevealSection
            key={ind.slug}
            delay={`scroll-delay-${(i % 3) + 1}`}
            className={featured ? 'lg:col-span-2 lg:row-span-2' : ''}
          >
            <Link
              to={`/industries/${ind.slug}`}
              className={`group relative block overflow-hidden rounded-2xl border border-border-strong/30 bg-sidebar-bg shadow-sm hover:shadow-2xl transition-all duration-500 h-full ${
                featured ? 'aspect-[16/10] lg:aspect-auto lg:min-h-[520px]' : 'aspect-[4/3]'
              }`}
            >
              {/* Photo */}
              <img
                src={ind.image}
                alt={`${ind.name} industry`}
                loading="lazy"
                className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
              />

              {/* Bottom gradient for text legibility */}
              <div className="absolute inset-0 bg-gradient-to-t from-sidebar-bg via-sidebar-bg/70 to-transparent" />
              <div className={`absolute inset-0 bg-gradient-to-br opacity-30 mix-blend-overlay ${ind.accent}`} />

              {/* Content */}
              <div className="absolute inset-0 flex flex-col p-6 lg:p-7">
                <div className="flex items-start justify-between">
                  <div className={`w-11 h-11 rounded-xl bg-white/15 backdrop-blur-sm border border-white/25 flex items-center justify-center ring-2 ring-offset-0 ${ind.ringColor}`}>
                    <Icon className="h-5 w-5 text-white" />
                  </div>
                  <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-white/80 bg-white/10 backdrop-blur-sm border border-white/15 rounded-full px-2.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    Explore
                    <ArrowUpRight className="h-3 w-3" />
                  </div>
                </div>

                <div className="mt-auto">
                  {featured && (
                    <span className="inline-block text-[10px] font-semibold uppercase tracking-[0.15em] text-primary bg-primary/20 border border-primary/30 rounded-full px-2.5 py-1 mb-3">
                      Most popular
                    </span>
                  )}
                  <h3 className={`font-display font-bold text-white leading-tight mb-2 ${featured ? 'text-3xl lg:text-4xl' : 'text-xl lg:text-2xl'}`}>
                    {ind.name}
                  </h3>
                  <p className={`text-white/75 font-body leading-relaxed ${featured ? 'text-base max-w-md' : 'text-sm'}`}>
                    {ind.tagline}
                  </p>

                  <div className="mt-4 flex items-center gap-3 pt-4 border-t border-white/15">
                    <div>
                      <p className="font-display text-2xl font-bold text-primary leading-none">{ind.stat.value}</p>
                      <p className="text-[10px] uppercase tracking-wider text-white/50 mt-1">{ind.stat.label}</p>
                    </div>
                    <div className="ml-auto flex items-center gap-1.5 text-xs font-semibold text-white/80 group-hover:text-white transition-colors">
                      See solution
                      <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          </RevealSection>
        );
      })}
    </div>
  );
}
