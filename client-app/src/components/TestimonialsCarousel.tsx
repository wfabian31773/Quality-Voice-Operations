import { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Star, Quote } from 'lucide-react';
import { reducedMotion } from '../hooks/useScrollReveal';

interface Testimonial {
  quote: string;
  name: string;
  title: string;
  company: string;
  initials: string;
  industry: string;
}

const testimonials: Testimonial[] = [
  {
    quote: 'We went from missing 1 in 3 calls to answering every single one. Our patient satisfaction scores jumped 22 points in the first month.',
    name: 'Dr. Sarah Mitchell',
    title: 'Practice Administrator',
    company: 'Lakewood Family Medicine',
    initials: 'SM',
    industry: 'Healthcare',
  },
  {
    quote: 'QVO responds to our Zillow leads in seconds. Our conversion rate doubled because we are always first to respond — even at 11pm.',
    name: 'Marcus Chen',
    title: 'Broker / Owner',
    company: 'Pinnacle Realty Group',
    initials: 'MC',
    industry: 'Real Estate',
  },
  {
    quote: 'During last winter\'s cold snap, we handled 3x our normal call volume without adding a single person. Dispatch was faster than our best dispatcher.',
    name: 'Mike Rodriguez',
    title: 'Owner',
    company: 'Comfort First HVAC',
    initials: 'MR',
    industry: 'Home Services',
  },
  {
    quote: 'We were losing 8-10 potential clients per week to missed calls. QVO captures every one now, and the intake quality is better than our previous staff.',
    name: 'Jennifer Park',
    title: 'Managing Partner',
    company: 'Park & Associates Law',
    initials: 'JP',
    industry: 'Legal',
  },
  {
    quote: 'Our no-show rate dropped from 18% to 7% in the first quarter. The recall campaign agent alone brought back 140 overdue patients.',
    name: 'Dr. Lisa Nguyen',
    title: 'Practice Owner',
    company: 'Bright Smile Dental',
    initials: 'LN',
    industry: 'Dental',
  },
];

export default function TestimonialsCarousel() {
  const [index, setIndex] = useState(0);
  const paused = useRef(false);

  useEffect(() => {
    if (reducedMotion) return;
    const interval = setInterval(() => {
      if (!paused.current) {
        setIndex((i) => (i + 1) % testimonials.length);
      }
    }, 7000);
    return () => clearInterval(interval);
  }, []);

  const current = testimonials[index];

  return (
    <div
      className="relative max-w-4xl mx-auto"
      onMouseEnter={() => { paused.current = true; }}
      onMouseLeave={() => { paused.current = false; }}
    >
      <div className="bg-white rounded-2xl border border-soft-steel/30 shadow-sm p-8 lg:p-12 relative overflow-hidden">
        <Quote className="absolute top-6 right-6 h-16 w-16 text-teal/10" />
        <div className="flex items-center gap-1 mb-6">
          {[...Array(5)].map((_, i) => (
            <Star key={i} className="h-4 w-4 fill-warm-amber text-warm-amber" />
          ))}
          <span className="ml-3 text-xs font-semibold uppercase tracking-wider text-slate-ink/40">{current.industry}</span>
        </div>
        <blockquote className="font-display text-xl lg:text-2xl text-harbor leading-relaxed mb-8 min-h-[6rem]">
          "{current.quote}"
        </blockquote>
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-teal to-teal-hover text-white flex items-center justify-center font-display font-bold text-sm shrink-0">
            {current.initials}
          </div>
          <div>
            <p className="font-display font-semibold text-harbor">{current.name}</p>
            <p className="text-sm text-slate-ink/60 font-body">{current.title}, {current.company}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setIndex((i) => (i - 1 + testimonials.length) % testimonials.length)}
          aria-label="Previous testimonial"
          className="w-10 h-10 rounded-full bg-white border border-soft-steel/40 flex items-center justify-center text-harbor hover:bg-teal hover:text-white hover:border-teal transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          {testimonials.map((_, i) => (
            <button
              key={i}
              onClick={() => setIndex(i)}
              aria-label={`Go to testimonial ${i + 1}`}
              className={`h-2 rounded-full transition-all ${i === index ? 'w-8 bg-teal' : 'w-2 bg-soft-steel/50 hover:bg-soft-steel'}`}
            />
          ))}
        </div>
        <button
          onClick={() => setIndex((i) => (i + 1) % testimonials.length)}
          aria-label="Next testimonial"
          className="w-10 h-10 rounded-full bg-white border border-soft-steel/40 flex items-center justify-center text-harbor hover:bg-teal hover:text-white hover:border-teal transition-colors"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
