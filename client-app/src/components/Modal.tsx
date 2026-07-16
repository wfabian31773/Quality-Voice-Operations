import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  ariaLabel?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  containerClassName?: string;
  panelClassName?: string;
  panelStyle?: React.CSSProperties;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('aria-hidden') && el.offsetParent !== null,
  );
}

/**
 * Single overlay root, lazily appended to <body> on first Modal mount.
 * All Modals render their JSX here via createPortal, so stacking is
 * controlled by the named z-index scale in _theme.css — not by whichever
 * component happens to host the Modal in its React tree.
 */
function getOrCreateOverlayRoot(): HTMLElement {
  let root = document.getElementById('overlay-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'overlay-root';
    document.body.appendChild(root);
  }
  return root;
}

/**
 * Ref-counted body scroll-lock. Only the first Modal opening locks the
 * body; only the last Modal closing unlocks it. Without this, nested
 * Modals (e.g. confirm-dialog opened from inside a settings drawer)
 * would unlock body scroll the moment the inner one closes even though
 * the outer is still open and needs the lock.
 */
const openModalStack: symbol[] = [];
let restoreBodyOverflow = '';
function lockBodyScroll(id: symbol) {
  if (openModalStack.length === 0) {
    restoreBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  openModalStack.push(id);
}
function releaseBodyScroll(id: symbol) {
  const idx = openModalStack.lastIndexOf(id);
  if (idx !== -1) openModalStack.splice(idx, 1);
  if (openModalStack.length === 0) {
    document.body.style.overflow = restoreBodyOverflow;
    restoreBodyOverflow = '';
  }
}

export default function Modal({
  open,
  onClose,
  labelledBy,
  ariaLabel,
  initialFocusRef,
  closeOnBackdrop = true,
  containerClassName,
  panelClassName,
  panelStyle,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Stable per-Modal-instance identity for the body-scroll ref count.
  const modalIdRef = useRef<symbol | null>(null);
  if (modalIdRef.current === null) {
    modalIdRef.current = Symbol('modal');
  }

  // Focus management: capture the previously-focused element on open,
  // restore focus on close (only if the element is still in the DOM —
  // otherwise leave focus where the browser puts it).
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const focusFirst = () => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = getFocusable(panel);
      (focusable[0] ?? panel).focus();
    };
    const id = window.setTimeout(focusFirst, 0);

    return () => {
      window.clearTimeout(id);
      const prev = previouslyFocusedRef.current;
      // Stale-element-aware restore: silently no-op if the element has
      // unmounted between Modal open and close (e.g. parent route
      // navigated away while the dialog was open).
      if (
        prev &&
        typeof prev.focus === 'function' &&
        document.body.contains(prev)
      ) {
        try {
          prev.focus();
        } catch {
          /* unfocusable for some other reason — leave focus alone */
        }
      }
    };
  }, [open, initialFocusRef]);

  // Escape closes; Tab cycles focus within the panel.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = getFocusable(panel);
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !panel.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || !panel.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [open, onClose]);

  // Body scroll lock — ref-counted so nested Modals don't release early.
  useEffect(() => {
    if (!open) return;
    const id = modalIdRef.current as symbol;
    lockBodyScroll(id);
    return () => releaseBodyScroll(id);
  }, [open]);

  if (!open) return null;

  const ariaProps = labelledBy
    ? { 'aria-labelledby': labelledBy }
    : ariaLabel
      ? { 'aria-label': ariaLabel }
      : {};

  // Render the overlay into a single #overlay-root appended to <body>
  // so it always escapes the parent's stacking context. Z-index ordering
  // is controlled by the named scale, not by where the consumer mounted us.
  return createPortal(
    <div
      className={
        containerClassName ??
        'fixed inset-0 z-modal flex items-center justify-center px-4'
      }
      onClick={() => {
        if (closeOnBackdrop) onClose();
      }}
    >
      <div className="absolute inset-0 bg-overlay" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        {...ariaProps}
        className={panelClassName
          ? `relative ${panelClassName}`
          : 'relative w-full max-w-md bg-surface border border-border rounded-xl shadow-2xl overflow-hidden'}
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    getOrCreateOverlayRoot(),
  );
}
