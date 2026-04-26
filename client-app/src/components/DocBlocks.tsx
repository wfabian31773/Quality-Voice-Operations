import { useEffect, useMemo, useState } from 'react';
import { Info, Lightbulb, AlertTriangle, X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { DocBlock } from '../data/docs';

const calloutStyles = {
  info: { wrap: 'bg-teal/5 border-teal/20', icon: Info, iconClass: 'text-teal' },
  tip: { wrap: 'bg-emerald-50 border-emerald-200', icon: Lightbulb, iconClass: 'text-emerald-600' },
  warn: { wrap: 'bg-amber-50 border-amber-200', icon: AlertTriangle, iconClass: 'text-amber-600' },
};

export function DocBlocks({ blocks, dense = false }: { blocks: DocBlock[]; dense?: boolean }) {
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);

  const images = useMemo(
    () =>
      blocks.flatMap((b) =>
        b.type === 'image' ? [{ src: b.src, alt: b.alt, caption: b.caption }] : []
      ),
    [blocks]
  );

  const zoomed = zoomedIndex !== null ? images[zoomedIndex] ?? null : null;
  const hasMultiple = images.length > 1;

  useEffect(() => {
    if (zoomedIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setZoomedIndex(null);
      } else if (e.key === 'ArrowRight' && hasMultiple) {
        e.preventDefault();
        setZoomedIndex((i) => (i === null ? null : (i + 1) % images.length));
      } else if (e.key === 'ArrowLeft' && hasMultiple) {
        e.preventDefault();
        setZoomedIndex((i) => (i === null ? null : (i - 1 + images.length) % images.length));
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [zoomedIndex, hasMultiple, images.length]);

  return (
    <>
    <div className={dense ? 'space-y-3' : 'space-y-4'}>
      {blocks.map((block, idx) => {
        if (block.type === 'p') {
          return (
            <p key={idx} className="text-sm text-slate-ink/75 leading-relaxed font-body">
              {block.text}
            </p>
          );
        }
        if (block.type === 'h2') {
          return (
            <h2 key={idx} id={slugify(block.text)} className="font-display text-xl font-bold text-harbor mt-8 mb-2 scroll-mt-24">
              {block.text}
            </h2>
          );
        }
        if (block.type === 'h3') {
          return (
            <h3 key={idx} id={slugify(block.text)} className="font-display text-base font-semibold text-harbor mt-6 mb-2 scroll-mt-24">
              {block.text}
            </h3>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={idx} className="space-y-2 my-2">
              {block.items.map((item, i) => (
                <li key={i} className="flex gap-2 text-sm text-slate-ink/75 font-body leading-relaxed">
                  <span className="text-teal mt-0.5">•</span>
                  <span>{renderInline(item)}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ol') {
          return (
            <ol key={idx} className="space-y-2 my-2 list-decimal pl-5 marker:text-teal">
              {block.items.map((item, i) => (
                <li key={i} className="text-sm text-slate-ink/75 font-body leading-relaxed pl-1">
                  {renderInline(item)}
                </li>
              ))}
            </ol>
          );
        }
        if (block.type === 'code') {
          return (
            <div key={idx} className="bg-harbor rounded-xl p-4 overflow-x-auto my-3">
              {block.lang && (
                <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 font-mono">
                  {block.lang}
                </div>
              )}
              <pre className="text-xs text-white/90 font-mono leading-relaxed whitespace-pre-wrap">
                {block.text}
              </pre>
            </div>
          );
        }
        if (block.type === 'callout') {
          const s = calloutStyles[block.tone];
          const Icon = s.icon;
          return (
            <div key={idx} className={`flex gap-3 border rounded-xl px-4 py-3 my-3 ${s.wrap}`}>
              <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${s.iconClass}`} />
              <p className="text-sm text-slate-ink/80 font-body leading-relaxed">{block.text}</p>
            </div>
          );
        }
        if (block.type === 'video') {
          return (
            <figure key={idx} className="my-4">
              <div className="relative w-full overflow-hidden rounded-xl border border-soft-steel/50 bg-harbor" style={{ aspectRatio: '16 / 9' }}>
                {block.provider === 'youtube' ? (
                  <iframe
                    src={`https://www.youtube.com/embed/${block.src}`}
                    title={block.title || block.caption || 'Embedded video'}
                    className="absolute inset-0 h-full w-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                ) : (
                  <video
                    src={block.src}
                    poster={block.poster}
                    controls
                    preload="metadata"
                    className="absolute inset-0 h-full w-full object-cover"
                  >
                    Your browser does not support embedded video.
                  </video>
                )}
              </div>
              {block.caption && (
                <figcaption className="text-xs text-slate-ink/50 mt-2 text-center font-body">{block.caption}</figcaption>
              )}
            </figure>
          );
        }
        if (block.type === 'image') {
          const imageIndex = images.findIndex((img) => img.src === block.src && img.alt === block.alt);
          return (
            <figure key={idx} className="my-4">
              <button
                type="button"
                onClick={() => setZoomedIndex(imageIndex >= 0 ? imageIndex : 0)}
                className="group block w-full rounded-xl border border-soft-steel/50 overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-teal cursor-zoom-in"
                aria-label={`Zoom image: ${block.alt}`}
              >
                <img
                  src={block.src}
                  alt={block.alt}
                  className="w-full transition-transform duration-200 group-hover:scale-[1.01]"
                />
              </button>
              {block.caption && (
                <figcaption className="text-xs text-slate-ink/50 mt-2 text-center font-body">{block.caption}</figcaption>
              )}
            </figure>
          );
        }
        if (block.type === 'common-issues') {
          return (
            <div key={idx} className="my-3 border border-soft-steel/50 rounded-xl divide-y divide-soft-steel/50 overflow-hidden">
              {block.items.map((it, i) => (
                <div key={i} className="p-4">
                  <p className="text-sm font-semibold text-harbor mb-1">{it.problem}</p>
                  <p className="text-sm text-slate-ink/70 font-body leading-relaxed">{it.fix}</p>
                </div>
              ))}
            </div>
          );
        }
        return null;
      })}
    </div>
    {zoomed && zoomedIndex !== null && (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={zoomed.alt}
        onClick={() => setZoomedIndex(null)}
        className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8 cursor-zoom-out"
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setZoomedIndex(null); }}
          aria-label="Close zoomed image"
          className="absolute top-4 right-4 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full p-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-5 w-5" />
        </button>
        {hasMultiple && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setZoomedIndex((i) => (i === null ? null : (i - 1 + images.length) % images.length));
              }}
              aria-label="Previous image"
              className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full p-2 sm:p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <ChevronLeft className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setZoomedIndex((i) => (i === null ? null : (i + 1) % images.length));
              }}
              aria-label="Next image"
              className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full p-2 sm:p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <ChevronRight className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>
            <div className="absolute top-4 left-1/2 -translate-x-1/2 text-xs sm:text-sm text-white/80 bg-white/10 rounded-full px-3 py-1 font-body tabular-nums">
              {zoomedIndex + 1} / {images.length}
            </div>
          </>
        )}
        <figure
          className="max-w-full max-h-full flex flex-col items-center gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          <img
            src={zoomed.src}
            alt={zoomed.alt}
            className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl"
          />
          {zoomed.caption && (
            <figcaption className="text-xs sm:text-sm text-white/70 font-body text-center max-w-2xl">
              {zoomed.caption}
            </figcaption>
          )}
        </figure>
      </div>
    )}
    </>
  );
}

function renderInline(text: string) {
  // Render **bold** segments
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const m = part.match(/^\*\*(.+)\*\*$/);
    if (m) return <strong key={i} className="text-harbor font-semibold">{m[1]}</strong>;
    return <span key={i}>{part}</span>;
  });
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
