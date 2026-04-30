import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { Info, Lightbulb, AlertTriangle, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DocBlock } from '../data/docs';
import { translateBlocks } from '../lib/translateDoc';
import Modal from './Modal';

const INTEGRATION_IMAGE_PREFIXES = [
  'salesforce-',
  'outlook-',
  'hubspot-',
  'google-',
  'slack-',
  'pipedrive-',
  'quickbooks-',
];

function imageIdFromSrc(src: string): string | null {
  const match = src.match(/\/docs\/screenshots\/([^/]+?)\.(svg|jpg|jpeg|png|webp)$/i);
  if (!match) return null;
  const id = match[1];
  if (!INTEGRATION_IMAGE_PREFIXES.some((p) => id.startsWith(p))) return null;
  return id;
}

function translateImageStrings(
  src: string,
  alt: string,
  caption: string | undefined,
  i18n: { exists: (key: string, opts?: { ns?: string }) => boolean; language: string },
  t: (key: string) => string,
): { alt: string; caption: string | undefined } {
  const id = imageIdFromSrc(src);
  if (!id) return { alt, caption };
  const altKey = `images.${id}.alt`;
  const captionKey = `images.${id}.caption`;
  const translatedAlt = i18n.exists(altKey, { ns: 'docs' }) ? t(altKey) : alt;
  const translatedCaption = caption && i18n.exists(captionKey, { ns: 'docs' })
    ? t(captionKey)
    : caption;
  return { alt: translatedAlt, caption: translatedCaption };
}

const MIN_SCALE = 1;
const MAX_SCALE = 3;
const DOUBLE_TAP_SCALE = 2;
const DOUBLE_TAP_MS = 300;
const SWIPE_THRESHOLD_PX = 50;

function ZoomableImage({
  src,
  alt,
  onSwipeNext,
  onSwipePrev,
}: {
  src: string;
  alt: string;
  onSwipeNext?: () => void;
  onSwipePrev?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Use refs for transform state so native touch listeners can read/write
  // without re-binding on every state change. We mirror to React state only
  // for re-rendering the transform style.
  const stateRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const [transform, setTransform] = useState({ scale: 1, tx: 0, ty: 0, animate: false });

  // Latest swipe callbacks, kept in a ref so the native touch listeners (bound
  // once on mount) always invoke the current handlers without re-subscribing.
  const swipeHandlersRef = useRef({ onSwipeNext, onSwipePrev });
  swipeHandlersRef.current = { onSwipeNext, onSwipePrev };

  const gestureRef = useRef({
    mode: 'idle' as 'idle' | 'pan' | 'pinch' | 'swipe-pending',
    startDist: 0,
    startScale: 1,
    startTx: 0,
    startTy: 0,
    startX: 0,
    startY: 0,
    startMidX: 0,
    startMidY: 0,
    lastTapTime: 0,
    lastTapX: 0,
    lastTapY: 0,
    swipeDx: 0,
    swipeDy: 0,
  });

  const clampPan = (scale: number, x: number, y: number) => {
    const c = containerRef.current;
    const img = imgRef.current;
    if (!c || !img) return { x, y };
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    const iw = img.clientWidth * scale;
    const ih = img.clientHeight * scale;
    const maxX = Math.max(0, (iw - cw) / 2);
    const maxY = Math.max(0, (ih - ch) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  };

  const apply = (scale: number, tx: number, ty: number, animate = false) => {
    stateRef.current = { scale, tx, ty };
    setTransform({ scale, tx, ty, animate });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches;
      if (t.length === 2) {
        e.preventDefault();
        const dx = t[0].clientX - t[1].clientX;
        const dy = t[0].clientY - t[1].clientY;
        gestureRef.current.mode = 'pinch';
        gestureRef.current.startDist = Math.hypot(dx, dy) || 1;
        gestureRef.current.startScale = stateRef.current.scale;
        gestureRef.current.startTx = stateRef.current.tx;
        gestureRef.current.startTy = stateRef.current.ty;
        gestureRef.current.startMidX = (t[0].clientX + t[1].clientX) / 2;
        gestureRef.current.startMidY = (t[0].clientY + t[1].clientY) / 2;
      } else if (t.length === 1) {
        const now = Date.now();
        const sinceLast = now - gestureRef.current.lastTapTime;
        const dxTap = t[0].clientX - gestureRef.current.lastTapX;
        const dyTap = t[0].clientY - gestureRef.current.lastTapY;
        const tapDist = Math.hypot(dxTap, dyTap);
        if (sinceLast > 0 && sinceLast < DOUBLE_TAP_MS && tapDist < 30) {
          // Double tap: toggle zoom
          e.preventDefault();
          gestureRef.current.lastTapTime = 0;
          gestureRef.current.mode = 'idle';
          if (stateRef.current.scale > 1.01) {
            apply(1, 0, 0, true);
          } else {
            const rect = container.getBoundingClientRect();
            const cx = t[0].clientX - rect.left - rect.width / 2;
            const cy = t[0].clientY - rect.top - rect.height / 2;
            const newScale = DOUBLE_TAP_SCALE;
            const newTx = -cx * (newScale - 1);
            const newTy = -cy * (newScale - 1);
            const clamped = clampPan(newScale, newTx, newTy);
            apply(newScale, clamped.x, clamped.y, true);
          }
          return;
        }
        gestureRef.current.lastTapTime = now;
        gestureRef.current.lastTapX = t[0].clientX;
        gestureRef.current.lastTapY = t[0].clientY;
        if (stateRef.current.scale > 1.01) {
          e.preventDefault();
          gestureRef.current.mode = 'pan';
          gestureRef.current.startTx = stateRef.current.tx;
          gestureRef.current.startTy = stateRef.current.ty;
          gestureRef.current.startX = t[0].clientX;
          gestureRef.current.startY = t[0].clientY;
        } else if (
          swipeHandlersRef.current.onSwipeNext ||
          swipeHandlersRef.current.onSwipePrev
        ) {
          // Not zoomed in: track a potential horizontal swipe for prev/next
          // navigation. We don't preventDefault here so vertical/diagonal
          // gestures stay available for the browser/modal.
          gestureRef.current.mode = 'swipe-pending';
          gestureRef.current.startX = t[0].clientX;
          gestureRef.current.startY = t[0].clientY;
          gestureRef.current.swipeDx = 0;
          gestureRef.current.swipeDy = 0;
        } else {
          gestureRef.current.mode = 'idle';
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches;
      if (gestureRef.current.mode === 'pinch' && t.length === 2) {
        e.preventDefault();
        const dx = t[0].clientX - t[1].clientX;
        const dy = t[0].clientY - t[1].clientY;
        const dist = Math.hypot(dx, dy);
        let newScale = gestureRef.current.startScale * (dist / gestureRef.current.startDist);
        newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
        const midX = (t[0].clientX + t[1].clientX) / 2;
        const midY = (t[0].clientY + t[1].clientY) / 2;
        const newTx = gestureRef.current.startTx + (midX - gestureRef.current.startMidX);
        const newTy = gestureRef.current.startTy + (midY - gestureRef.current.startMidY);
        const clamped = clampPan(newScale, newTx, newTy);
        apply(newScale, clamped.x, clamped.y, false);
      } else if (gestureRef.current.mode === 'pan' && t.length === 1) {
        e.preventDefault();
        const newTx = gestureRef.current.startTx + (t[0].clientX - gestureRef.current.startX);
        const newTy = gestureRef.current.startTy + (t[0].clientY - gestureRef.current.startY);
        const clamped = clampPan(stateRef.current.scale, newTx, newTy);
        apply(stateRef.current.scale, clamped.x, clamped.y, false);
      } else if (gestureRef.current.mode === 'swipe-pending' && t.length === 1) {
        const dx = t[0].clientX - gestureRef.current.startX;
        const dy = t[0].clientY - gestureRef.current.startY;
        gestureRef.current.swipeDx = dx;
        gestureRef.current.swipeDy = dy;
        // Once horizontal motion clearly dominates vertical motion, claim
        // the gesture so the browser doesn't try to scroll/zoom along with us.
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
          e.preventDefault();
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        const wasSwipePending = gestureRef.current.mode === 'swipe-pending';
        const dx = gestureRef.current.swipeDx;
        const dy = gestureRef.current.swipeDy;
        gestureRef.current.mode = 'idle';
        gestureRef.current.swipeDx = 0;
        gestureRef.current.swipeDy = 0;
        if (
          wasSwipePending &&
          Math.abs(dx) >= SWIPE_THRESHOLD_PX &&
          Math.abs(dx) > Math.abs(dy)
        ) {
          // A finished horizontal swipe with the dominant axis horizontal:
          // left swipe → next image, right swipe → previous image.
          if (dx < 0) {
            swipeHandlersRef.current.onSwipeNext?.();
          } else {
            swipeHandlersRef.current.onSwipePrev?.();
          }
        }
        if (stateRef.current.scale <= 1.01) {
          apply(1, 0, 0, true);
        }
      } else if (e.touches.length === 1 && gestureRef.current.mode === 'pinch') {
        if (stateRef.current.scale > 1.01) {
          gestureRef.current.mode = 'pan';
          gestureRef.current.startTx = stateRef.current.tx;
          gestureRef.current.startTy = stateRef.current.ty;
          gestureRef.current.startX = e.touches[0].clientX;
          gestureRef.current.startY = e.touches[0].clientY;
        } else {
          gestureRef.current.mode = 'idle';
        }
      }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: false });
    container.addEventListener('touchcancel', onTouchEnd, { passive: false });
    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative max-w-full max-h-[85vh] overflow-hidden rounded-lg shadow-2xl select-none"
      style={{ touchAction: 'none' }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        className="max-w-full max-h-[85vh] object-contain block"
        style={{
          transform: `translate3d(${transform.tx}px, ${transform.ty}px, 0) scale(${transform.scale})`,
          transformOrigin: 'center center',
          transition: transform.animate ? 'transform 200ms ease-out' : 'none',
          willChange: 'transform',
        }}
      />
    </div>
  );
}

const HINT_STORAGE_KEY = 'qvo:docs-lightbox-hint-shown';
const HINT_FADE_MS = 2500;

function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function LightboxHint({
  hasMultiple,
  onDismiss,
}: {
  hasMultiple: boolean;
  onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(true);
  const { t, i18n } = useTranslation('docs');

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), HINT_FADE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const handleDismiss = (e: ReactMouseEvent | ReactTouchEvent) => {
    e.stopPropagation();
    setVisible(false);
  };

  const key = hasMultiple ? 'lightbox.hintWithSwipe' : 'lightbox.hintZoomOnly';
  const fallback = hasMultiple
    ? 'Swipe to browse · Pinch to zoom · Double-tap for 2x'
    : 'Pinch to zoom · Double-tap for 2x';
  const text = i18n.exists(key, { ns: 'docs' }) ? t(key) : fallback;

  return (
    <button
      type="button"
      role="status"
      aria-live="polite"
      onClick={handleDismiss}
      onTouchStart={handleDismiss}
      onTransitionEnd={(e) => {
        if (e.propertyName === 'opacity' && !visible) onDismiss();
      }}
      className={`absolute bottom-6 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full bg-white/15 dark:bg-white/15 backdrop-blur-sm text-white text-xs sm:text-sm font-body shadow-lg transition-opacity duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
    >
      {text}
    </button>
  );
}

const calloutStyles = {
  info: { wrap: 'bg-primary/5 border-primary/20', icon: Info, iconClass: 'text-primary' },
  tip: { wrap: 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30', icon: Lightbulb, iconClass: 'text-emerald-600 dark:text-emerald-400' },
  warn: { wrap: 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30', icon: AlertTriangle, iconClass: 'text-amber-600 dark:text-amber-400' },
};

export function DocBlocks({
  blocks: rawBlocks,
  dense = false,
  articleSlug,
}: {
  blocks: DocBlock[];
  dense?: boolean;
  articleSlug?: string;
}) {
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);
  const [showZoomHint, setShowZoomHint] = useState(false);
  const { t, i18n } = useTranslation('docs');

  const blocks = useMemo(
    () => translateBlocks(rawBlocks, articleSlug, i18n, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawBlocks, articleSlug, i18n.language, t]
  );

  const images = useMemo(
    () =>
      blocks.flatMap((b) => {
        if (b.type !== 'image') return [];
        const { alt, caption } = translateImageStrings(b.src, b.alt, b.caption, i18n, t);
        return [{ src: b.src, alt, caption }];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks, i18n.language, t]
  );

  const zoomed = zoomedIndex !== null ? images[zoomedIndex] ?? null : null;
  const hasMultiple = images.length > 1;

  useEffect(() => {
    if (zoomedIndex === null) {
      setShowZoomHint(false);
      return;
    }
    if (isTouchDevice()) {
      try {
        if (window.sessionStorage.getItem(HINT_STORAGE_KEY) !== '1') {
          window.sessionStorage.setItem(HINT_STORAGE_KEY, '1');
          setShowZoomHint(true);
        }
      } catch {
        // sessionStorage may be unavailable (private mode); skip the hint.
      }
    }
    // ESC, scroll lock, focus trap, and focus restoration are handled by the
    // shared <Modal> primitive that wraps the lightbox. We only need to
    // intercept arrow keys for prev/next navigation.
    if (!hasMultiple) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setZoomedIndex((i) => (i === null ? null : (i + 1) % images.length));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setZoomedIndex((i) => (i === null ? null : (i - 1 + images.length) % images.length));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [zoomedIndex, hasMultiple, images.length]);

  // Preload the adjacent screenshots (prev + next, with wrap-around) so that
  // navigating through the lightbox carousel feels instant. We instantiate
  // Image() objects in-memory which triggers the browser to fetch and cache
  // the bytes; assigning to `src` is enough — we don't need to attach them to
  // the DOM. Skip entirely for single-image articles.
  useEffect(() => {
    if (zoomedIndex === null || !hasMultiple) return;
    const len = images.length;
    const nextSrc = images[(zoomedIndex + 1) % len]?.src;
    const prevSrc = images[(zoomedIndex - 1 + len) % len]?.src;
    const preloaders: HTMLImageElement[] = [];
    for (const src of [nextSrc, prevSrc]) {
      if (!src) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      preloaders.push(img);
    }
    return () => {
      // Drop references so an in-flight fetch can be GC'd if the lightbox
      // closes before it finishes (the browser cache entry will still be
      // populated if/when the request completes).
      for (const img of preloaders) {
        img.src = '';
      }
    };
  }, [zoomedIndex, hasMultiple, images]);

  return (
    <>
    <div className={dense ? 'space-y-3' : 'space-y-4'}>
      {blocks.map((block, idx) => {
        if (block.type === 'p') {
          return (
            <p key={idx} className="text-sm text-text-primary/75 leading-relaxed font-body">
              {block.text}
            </p>
          );
        }
        if (block.type === 'h2') {
          return (
            <h2 key={idx} id={slugify(block.text)} className="font-display text-xl font-bold text-text-primary mt-8 mb-2 scroll-mt-24">
              {block.text}
            </h2>
          );
        }
        if (block.type === 'h3') {
          return (
            <h3 key={idx} id={slugify(block.text)} className="font-display text-base font-semibold text-text-primary mt-6 mb-2 scroll-mt-24">
              {block.text}
            </h3>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={idx} className="space-y-2 my-2">
              {block.items.map((item, i) => (
                <li key={i} className="flex gap-2 text-sm text-text-primary/75 font-body leading-relaxed">
                  <span className="text-primary mt-0.5">•</span>
                  <span>{renderInline(item)}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ol') {
          return (
            <ol key={idx} className="space-y-2 my-2 list-decimal pl-5 marker:text-primary">
              {block.items.map((item, i) => (
                <li key={i} className="text-sm text-text-primary/75 font-body leading-relaxed pl-1">
                  {renderInline(item)}
                </li>
              ))}
            </ol>
          );
        }
        if (block.type === 'code') {
          return (
            <div key={idx} className="bg-sidebar-bg rounded-xl p-4 overflow-x-auto my-3">
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
              <p className="text-sm text-text-primary/80 font-body leading-relaxed">{block.text}</p>
            </div>
          );
        }
        if (block.type === 'video') {
          return (
            <figure key={idx} className="my-4">
              <div className="relative w-full overflow-hidden rounded-xl border border-border-strong/50 bg-sidebar-bg" style={{ aspectRatio: '16 / 9' }}>
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
                <figcaption className="text-xs text-text-primary/50 mt-2 text-center font-body">{block.caption}</figcaption>
              )}
            </figure>
          );
        }
        if (block.type === 'image') {
          const imageIndex = images.findIndex((img) => img.src === block.src);
          const resolvedIndex = imageIndex >= 0 ? imageIndex : 0;
          const resolved = images[resolvedIndex] ?? { alt: block.alt, caption: block.caption };
          return (
            <ImageBlock
              key={idx}
              src={block.src}
              alt={resolved.alt}
              caption={resolved.caption}
              onZoom={() => setZoomedIndex(resolvedIndex)}
            />
          );
        }
        if (block.type === 'common-issues') {
          return (
            <div key={idx} className="my-3 border border-border-strong/50 rounded-xl divide-y divide-border-strong/50 overflow-hidden">
              {block.items.map((it, i) => (
                <div key={i} className="p-4">
                  <p className="text-sm font-semibold text-text-primary mb-1">{it.problem}</p>
                  <p className="text-sm text-text-primary/70 font-body leading-relaxed">{it.fix}</p>
                </div>
              ))}
            </div>
          );
        }
        return null;
      })}
    </div>
    {zoomed && zoomedIndex !== null && (
      <Modal
        open
        onClose={() => setZoomedIndex(null)}
        ariaLabel={zoomed.alt}
        containerClassName="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-8 cursor-zoom-out"
        panelClassName="relative w-full h-full bg-transparent flex items-center justify-center focus:outline-none"
      >
        <div
          className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          aria-hidden="true"
          onClick={() => setZoomedIndex(null)}
        />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setZoomedIndex(null); }}
          aria-label="Close zoomed image"
          className="absolute top-4 right-4 text-white/80 hover:text-white bg-white/10 dark:bg-white/10 hover:bg-white/20 dark:hover:bg-white/20 rounded-full p-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white z-10"
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
              className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white bg-white/10 dark:bg-white/10 hover:bg-white/20 dark:hover:bg-white/20 rounded-full p-2 sm:p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white z-10"
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
              className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white bg-white/10 dark:bg-white/10 hover:bg-white/20 dark:hover:bg-white/20 rounded-full p-2 sm:p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white z-10"
            >
              <ChevronRight className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>
            <div className="absolute top-4 left-1/2 -translate-x-1/2 text-xs sm:text-sm text-white/80 bg-white/10 dark:bg-white/10 rounded-full px-3 py-1 font-body tabular-nums z-10">
              {zoomedIndex + 1} / {images.length}
            </div>
          </>
        )}
        <figure
          className="relative max-w-full max-h-full flex flex-col items-center gap-3"
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <ZoomableImage
            key={zoomed.src}
            src={zoomed.src}
            alt={zoomed.alt}
            onSwipeNext={
              hasMultiple
                ? () =>
                    setZoomedIndex((i) => (i === null ? null : (i + 1) % images.length))
                : undefined
            }
            onSwipePrev={
              hasMultiple
                ? () =>
                    setZoomedIndex((i) =>
                      i === null ? null : (i - 1 + images.length) % images.length
                    )
                : undefined
            }
          />
          {zoomed.caption && (
            <figcaption className="text-xs sm:text-sm text-white/70 font-body text-center max-w-2xl">
              {zoomed.caption}
            </figcaption>
          )}
        </figure>
        {showZoomHint && (
          <LightboxHint
            hasMultiple={hasMultiple}
            onDismiss={() => setShowZoomHint(false)}
          />
        )}
      </Modal>
    )}
    </>
  );
}

function renderInline(text: string) {
  // Render **bold** segments
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const m = part.match(/^\*\*(.+)\*\*$/);
    if (m) return <strong key={i} className="text-text-primary font-semibold">{m[1]}</strong>;
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

interface ImageBlockProps {
  src: string;
  alt: string;
  caption?: string;
  onZoom: () => void;
}

function ImageBlock({ src, alt, caption, onZoom }: ImageBlockProps) {
  return (
    <figure className="my-4">
      <button
        type="button"
        onClick={onZoom}
        className="group block w-full rounded-xl border border-border-strong/50 overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-zoom-in"
        aria-label={`Zoom image: ${alt}`}
      >
        <img
          src={src}
          alt={alt}
          className="w-full transition-transform duration-200 group-hover:scale-[1.01]"
        />
      </button>
      {caption && (
        <figcaption className="text-xs text-text-primary/50 mt-2 text-center font-body">{caption}</figcaption>
      )}
    </figure>
  );
}
