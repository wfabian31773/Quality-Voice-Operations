import { type ReactNode } from 'react';
import { Quote, Star } from 'lucide-react';
import clsx from 'clsx';

export interface TestimonialBlockProps {
  quote: ReactNode;
  name: ReactNode;
  title?: ReactNode;
  company?: ReactNode;
  /** Avatar initials. Used when no `avatarUrl` is provided. */
  initials?: string;
  avatarUrl?: string;
  /** Star rating, 1–5. Defaults to 5. Pass `0` to hide the row. */
  rating?: number;
  /** Optional eyebrow tag — e.g. industry. */
  eyebrow?: ReactNode;
  /** Sit on top of dark surfaces. */
  inverse?: boolean;
  className?: string;
}

/** Standalone testimonial card primitive for marketing pages and shared blocks. */
export default function TestimonialBlock({
  quote,
  name,
  title,
  company,
  initials,
  avatarUrl,
  rating = 5,
  eyebrow,
  inverse = false,
  className,
}: TestimonialBlockProps) {
  return (
    <figure
      className={clsx(
        'relative overflow-hidden rounded-2xl p-8 lg:p-10 shadow-[var(--elevation-1)]',
        inverse
          ? 'bg-sidebar-hover border border-on-sidebar/10 text-on-sidebar'
          : 'bg-surface border border-border text-text-primary',
        className,
      )}
    >
      <Quote
        className={clsx(
          'absolute top-6 right-6 h-14 w-14',
          inverse ? 'text-on-sidebar/10' : 'text-primary/10',
        )}
        aria-hidden="true"
      />
      {(rating > 0 || eyebrow) && (
        <div className="flex items-center gap-1 mb-5">
          {rating > 0 &&
            Array.from({ length: rating }).map((_, i) => (
              <Star key={i} className="h-4 w-4 fill-accent text-accent" aria-hidden="true" />
            ))}
          {eyebrow && (
            <span
              className={clsx(
                'ml-3 text-xs font-semibold uppercase tracking-wider',
                inverse ? 'text-on-sidebar opacity-60' : 'text-text-muted',
              )}
            >
              {eyebrow}
            </span>
          )}
        </div>
      )}
      <blockquote
        className={clsx(
          'font-display text-lg lg:text-xl leading-relaxed mb-6',
          inverse ? 'text-on-sidebar' : 'text-text-primary',
        )}
      >
        “{quote}”
      </blockquote>
      <figcaption className="flex items-center gap-3">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="w-11 h-11 rounded-full object-cover shrink-0"
          />
        ) : (
          <span
            className="w-11 h-11 rounded-full flex items-center justify-center font-display font-bold text-sm shrink-0 text-on-primary"
            style={{
              background:
                'linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%)',
            }}
            aria-hidden="true"
          >
            {initials}
          </span>
        )}
        <div className="min-w-0">
          <p
            className={clsx(
              'font-display font-semibold',
              inverse ? 'text-on-sidebar' : 'text-text-primary',
            )}
          >
            {name}
          </p>
          {(title || company) && (
            <p
              className={clsx(
                'text-sm',
                inverse ? 'text-on-sidebar opacity-70' : 'text-text-secondary',
              )}
            >
              {title}
              {title && company ? ', ' : ''}
              {company}
            </p>
          )}
        </div>
      </figcaption>
    </figure>
  );
}
