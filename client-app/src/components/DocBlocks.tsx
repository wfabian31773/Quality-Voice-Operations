import { Info, Lightbulb, AlertTriangle } from 'lucide-react';
import type { DocBlock } from '../data/docs';

const calloutStyles = {
  info: { wrap: 'bg-teal/5 border-teal/20', icon: Info, iconClass: 'text-teal' },
  tip: { wrap: 'bg-emerald-50 border-emerald-200', icon: Lightbulb, iconClass: 'text-emerald-600' },
  warn: { wrap: 'bg-amber-50 border-amber-200', icon: AlertTriangle, iconClass: 'text-amber-600' },
};

export function DocBlocks({ blocks, dense = false }: { blocks: DocBlock[]; dense?: boolean }) {
  return (
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
          return (
            <figure key={idx} className="my-4">
              <img src={block.src} alt={block.alt} className="rounded-xl border border-soft-steel/50 w-full" />
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
