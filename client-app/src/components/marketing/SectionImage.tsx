import type { ReactNode } from 'react';
import RevealSection from '../RevealSection';

export interface SectionImageProps {
  /** Image source under /assets/ */
  img: string;
  /** Alt text for accessibility */
  alt: string;
  /** Optional uppercase eyebrow above the headline */
  eyebrow?: string;
  /** Section title (rendered in serif) */
  title: ReactNode;
  /** Section body copy */
  body: ReactNode;
  /** If true, image renders on the right instead of the left */
  reverse?: boolean;
  /** Load the image eagerly (for the first one above the fold) */
  eager?: boolean;
  /** Optional extra content rendered below the body (e.g. a stat list or CTA) */
  children?: ReactNode;
}

/**
 * Editorial image/text split row used in the visual-proof section pattern.
 *
 * Composes naturally inside any section background — the parent decides bg color.
 * Wrap in `<section className="bg-surface-secondary">` (or similar) and stack
 * multiple SectionImage rows with alternating `reverse` for the classic
 * zigzag editorial layout.
 */
export default function SectionImage({
  img,
  alt,
  eyebrow,
  title,
  body,
  reverse = false,
  eager = false,
  children,
}: SectionImageProps) {
  return (
    <RevealSection>
      <div
        className={`max-w-7xl mx-auto px-6 lg:px-8 py-20 lg:py-32 grid lg:grid-cols-2 gap-10 lg:gap-20 items-center ${
          reverse ? 'lg:[&>div:first-child]:order-2' : ''
        }`}
      >
        <div>
          <div className="relative aspect-[3/2] rounded-2xl overflow-hidden bg-surface-muted shadow-[0_20px_60px_-20px_rgba(14,39,56,0.25)]">
            <img
              src={img}
              alt={alt}
              loading={eager ? 'eager' : 'lazy'}
              className="absolute inset-0 w-full h-full object-cover"
            />
          </div>
        </div>
        <div className="max-w-lg">
          {eyebrow ? (
            <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary mb-3">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="font-display text-3xl lg:text-[42px] font-bold text-text-primary leading-[1.1] mb-5 [text-wrap:balance]">
            {title}
          </h2>
          <p className="font-body text-lg text-text-secondary leading-relaxed">{body}</p>
          {children ? <div className="mt-6">{children}</div> : null}
        </div>
      </div>
    </RevealSection>
  );
}
