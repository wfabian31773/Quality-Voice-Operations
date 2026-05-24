import type { ReactNode } from 'react';
import RevealSection from '../RevealSection';

export interface Pillar {
  /** Small numeric label like "01", "02", "03" */
  num: string;
  /** Pillar headline */
  title: ReactNode;
  /** Pillar body copy */
  body: ReactNode;
}

export interface PillarsProps {
  /** Small uppercase eyebrow */
  eyebrow?: string;
  /** Section title (rendered in centered serif) */
  title?: ReactNode;
  /** 2-4 pillars to render in columns */
  items: Pillar[];
  /** Optional content rendered below the pillars (e.g. a stats strip) */
  children?: ReactNode;
}

/**
 * Typography-only pillars section used to anchor the page in big serif type.
 *
 * Used as the second section on Landing/VerticalLanding ("Three things every
 * business needs the phone to do — and most can't"). Renders 3 columns on lg,
 * stacks on mobile.
 */
export default function Pillars({ eyebrow, title, items, children }: PillarsProps) {
  return (
    <section className="bg-surface py-24 lg:py-36 border-b border-border/60">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        {title ? (
          <RevealSection>
            {eyebrow ? (
              <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary mb-3 text-center">
                {eyebrow}
              </p>
            ) : null}
            <h2 className="font-display text-3xl lg:text-5xl font-bold text-text-primary text-center max-w-3xl mx-auto leading-[1.1] mb-20 [text-wrap:balance]">
              {title}
            </h2>
          </RevealSection>
        ) : null}

        <div
          className={`grid gap-x-12 gap-y-16 ${
            items.length === 2
              ? 'lg:grid-cols-2'
              : items.length === 4
                ? 'lg:grid-cols-4'
                : 'lg:grid-cols-3'
          }`}
        >
          {items.map((p, i) => (
            <RevealSection key={p.num} delay={`scroll-delay-${(i % 4) + 1}`}>
              <p className="font-display text-sm font-semibold text-primary tracking-wide mb-5">
                {p.num}
              </p>
              <h3 className="font-display text-2xl lg:text-[28px] font-bold text-text-primary leading-[1.2] mb-4 [text-wrap:balance]">
                {p.title}
              </h3>
              <p className="font-body text-base text-text-secondary leading-relaxed">
                {p.body}
              </p>
            </RevealSection>
          ))}
        </div>

        {children ? (
          <div className="mt-24 pt-12 border-t border-border/60">{children}</div>
        ) : null}
      </div>
    </section>
  );
}
