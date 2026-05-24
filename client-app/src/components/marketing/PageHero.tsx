import { Link } from 'react-router-dom';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

export interface HeroCta {
  /** Button label */
  label: string;
  /** React Router path */
  to: string;
  /** Visual style. `primary` = teal solid; `ghost` = translucent white outline. */
  variant?: 'primary' | 'ghost';
  /** Optional click handler for analytics */
  onClick?: () => void;
  /** Optional trailing icon override (defaults to ArrowRight on primary, none on ghost) */
  trailingIcon?: ReactNode;
}

export interface HeroPill {
  /** Label text */
  label: string;
}

export interface PageHeroProps {
  /** Hero image used in light mode. Path under /assets/. */
  lightSrc: string;
  /** Hero image used in dark mode (via prefers-color-scheme). */
  darkSrc: string;
  /**
   * Optional video for the dark/cinematic experience. When provided, it plays
   * above the dark image. Falls back to the image if the browser refuses video.
   */
  videoSrc?: string;
  /** Small uppercase eyebrow above the headline */
  eyebrow?: string;
  /** Main headline (renders in white serif). Can be ReactNode for inline emphasis. */
  title: ReactNode;
  /**
   * Optional second-line accent text rendered after the title in primary-light color.
   * Use for two-line headlines like "Calls that don't get missed. / Patients that don't get lost."
   */
  titleAccent?: ReactNode;
  /** Body description below the title */
  description?: ReactNode;
  /** Primary + secondary CTAs (1-3) */
  ctas?: HeroCta[];
  /** Optional trust pills below the CTAs (HIPAA, SOC 2, etc.) */
  pills?: HeroPill[];
  /**
   * Optional right-side floating content (e.g. a stats card on VerticalLanding).
   * Rendered in the right column on lg+; hidden on smaller viewports.
   */
  rightContent?: ReactNode;
  /** Minimum viewport-height for the hero. Default 88vh. */
  minHeightClass?: string;
  /** Constrains text column width. Default `max-w-xl`. */
  textMaxWidthClass?: string;
}

/**
 * Editorial full-bleed hero used across the marketing surface.
 *
 * Renders an image (light + dark variants via `<picture>`), an optional video
 * overlay, a multi-stop left-side scrim that creates a clean dark "panel" for
 * the headline, and a small bottom scrim for trust pills.
 *
 * Composed so every public page can drop one in with page-specific copy and
 * imagery while staying visually consistent with Landing.
 */
export default function PageHero({
  lightSrc,
  darkSrc,
  videoSrc,
  eyebrow,
  title,
  titleAccent,
  description,
  ctas,
  pills,
  rightContent,
  minHeightClass = 'min-h-[88vh]',
  textMaxWidthClass = 'max-w-xl',
}: PageHeroProps) {
  return (
    <section
      className={`relative isolate ${minHeightClass} flex items-end overflow-hidden`}
    >
      {/* Image backdrop: dark mode swaps via prefers-color-scheme */}
      <picture className="absolute inset-0 -z-10">
        <source srcSet={darkSrc} media="(prefers-color-scheme: dark)" />
        <img
          src={lightSrc}
          alt=""
          className="w-full h-full object-cover object-[80%_50%] lg:object-[75%_50%]"
          fetchPriority="high"
        />
      </picture>

      {/* Optional motion layer for the hero. Plays muted/looped/autoplay so it */}
      {/* behaves like a "live image". Sits between the image and the scrim. */}
      {videoSrc ? (
        <video
          src={videoSrc}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 -z-10 w-full h-full object-cover object-[80%_50%] lg:object-[75%_50%] hidden dark:block"
        />
      ) : null}

      {/* Heavy multi-stop left-side scrim: dark panel through ~50% width, */}
      {/* image emerges cleanly on the right. */}
      <div
        className="absolute inset-0 -z-10"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.92) 42%, rgba(0,0,0,0.7) 55%, rgba(0,0,0,0.25) 75%, rgba(0,0,0,0) 95%)',
        }}
      />
      {/* Soft bottom wash for trust pills against the lower part of the image */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/40 via-transparent to-transparent" />

      <div className="relative w-full max-w-7xl mx-auto px-6 lg:px-8 pb-16 lg:pb-24 pt-32">
        <div
          className={
            rightContent
              ? 'grid lg:grid-cols-[1.1fr,1fr] gap-12 items-end'
              : 'flex'
          }
        >
          <div className={`${textMaxWidthClass} text-white`}>
            {eyebrow ? (
              <p className="font-display text-[11px] tracking-[0.18em] uppercase mb-6 text-primary-light">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="font-display text-[40px] sm:text-5xl lg:text-[64px] font-bold leading-[1.05] mb-6 [text-wrap:balance]">
              {title}
              {titleAccent ? (
                <>
                  <br />
                  <span className="text-primary-light dark:text-primary">
                    {titleAccent}
                  </span>
                </>
              ) : null}
            </h1>
            {description ? (
              <p className="font-body text-lg lg:text-xl text-white/85 leading-relaxed mb-8 max-w-xl">
                {description}
              </p>
            ) : null}
            {ctas && ctas.length > 0 ? (
              <div className="flex flex-col sm:flex-row gap-3">
                {ctas.map((cta) => {
                  const variant = cta.variant ?? 'primary';
                  const primaryClasses =
                    'bg-primary hover:bg-primary-hover text-on-primary shadow-[0_8px_30px_rgba(45,212,191,0.25)]';
                  const ghostClasses =
                    'bg-white/10 hover:bg-white/20 backdrop-blur-sm text-white border border-white/25 hover:border-white/40';
                  return (
                    <Link
                      key={`${cta.label}-${cta.to}`}
                      to={cta.to}
                      onClick={cta.onClick}
                      className={`inline-flex items-center justify-center gap-2 font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px] ${
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
            ) : null}
            {pills && pills.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-8 text-[11px] text-white/70">
                {pills.map((p) => (
                  <span key={p.label} className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5 text-primary-light" />
                    {p.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {rightContent ? (
            <div className="hidden lg:flex justify-end pb-2">{rightContent}</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
