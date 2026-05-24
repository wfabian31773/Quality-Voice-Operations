import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import RevealSection from '../RevealSection';
import type { HeroCta } from './PageHero';

export interface BottomCTAProps {
  /**
   * Background image. Defaults to the D2 cityscape so every page closer
   * shares the same "vast, calm" feeling as Landing.
   */
  bgSrc?: string;
  /** Small teal eyebrow above the headline */
  eyebrow?: string;
  /** Centered serif headline (white) */
  title: ReactNode;
  /** Body description below the title */
  body?: ReactNode;
  /** 1-3 CTAs (primary first, ghost(s) after) */
  ctas: HeroCta[];
}

/**
 * The closing CTA section used at the bottom of every marketing page.
 *
 * Always renders against a dark image (default: D2 cityscape) so the page
 * ends with the same "premium product launch" energy regardless of the
 * page's own theme.
 */
export default function BottomCTA({
  bgSrc = '/assets/sections-web/D2-cityscape.jpg',
  eyebrow,
  title,
  body,
  ctas,
}: BottomCTAProps) {
  return (
    <section className="relative isolate overflow-hidden">
      <img
        src={bgSrc}
        alt=""
        loading="lazy"
        className="absolute inset-0 -z-10 w-full h-full object-cover"
      />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/85 via-black/65 to-black/55" />
      <div className="relative max-w-3xl mx-auto px-6 lg:px-8 py-24 lg:py-36 text-center">
        <RevealSection>
          {eyebrow ? (
            <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary-light mb-4">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="font-display text-3xl lg:text-5xl font-bold text-white leading-[1.1] mb-5 [text-wrap:balance]">
            {title}
          </h2>
          {body ? (
            <p className="font-body text-lg text-white/80 leading-relaxed mb-10 max-w-xl mx-auto">
              {body}
            </p>
          ) : null}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {ctas.map((cta) => {
              const variant = cta.variant ?? 'primary';
              const primaryClasses =
                'bg-primary hover:bg-primary-hover text-on-primary shadow-[0_8px_30px_rgba(45,212,191,0.3)]';
              const ghostClasses =
                'bg-white/10 hover:bg-white/20 backdrop-blur-sm text-white border border-white/25 hover:border-white/40';
              return (
                <Link
                  key={`${cta.label}-${cta.to}`}
                  to={cta.to}
                  onClick={cta.onClick}
                  className={`inline-flex items-center justify-center gap-2 font-semibold px-8 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px] ${
                    variant === 'primary' ? primaryClasses : ghostClasses
                  }`}
                >
                  {cta.label}
                  {cta.trailingIcon !== undefined
                    ? cta.trailingIcon
                    : variant === 'primary'
                      ? <ArrowRight className="h-4 w-4" />
                      : null}
                </Link>
              );
            })}
          </div>
        </RevealSection>
      </div>
    </section>
  );
}
