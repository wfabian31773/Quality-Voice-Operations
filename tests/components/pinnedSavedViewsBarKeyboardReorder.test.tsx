// @vitest-environment happy-dom
/**
 * Task #1144: keyboard-driven drag-to-reorder regression test for the
 * pinned saved views bar on the Calls page.
 *
 * Task #1008 already covers that `Calls.tsx` mounts at all (it used to
 * crash because of a duplicate React copy pulled in by `@dnd-kit/core`).
 * What was still missing — and what this test locks in — is the actual
 * sortable interaction on `client-app/src/pages/calls/PinnedSavedViewsBar.tsx`:
 *
 *   1. The bar wires up dnd-kit's `KeyboardSensor` so users without a
 *      mouse can reorder pinned chips with Space + Arrow keys.
 *   2. On drop, it must call the page's `persistPinnedOrder` callback —
 *      which on the page is implemented as a POST to
 *      `/call-saved-views/pinned/reorder` — with the new id ordering.
 *   3. Before the network round-trip, it must optimistically update the
 *      `['call-saved-views']` React Query cache so the chips don't visually
 *      snap back to their pre-drag order while the request is in flight.
 *
 * Implementation notes for the test rig:
 *
 * - dnd-kit's `KeyboardSensor` listens for the activator (Space) on the
 *   handle button itself, then attaches a *document*-scoped keydown
 *   listener (via `setTimeout(0)`) for subsequent Arrow / Space keys. So
 *   we fire Space on the handle, flush a microtask + a 0-timer, then
 *   dispatch ArrowRight and Space at the document level.
 *
 * - dnd-kit picks the next droppable in a given direction by reading
 *   each item's `getBoundingClientRect()`. happy-dom returns 0/0/0/0 by
 *   default, which would make every chip occupy the same point and the
 *   ArrowRight collision search would not find a target. We patch the
 *   wrapper div for each chip to report a deterministic horizontal slot
 *   so "right of A" unambiguously resolves to B.
 *
 * - We mock `react-i18next.useTranslation` with a passthrough so we can
 *   target chips by their stable i18n key + interpolated name without
 *   waiting on the lazy tenant namespace bundle to load.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

void React;

// ---------------------------------------------------------------------------
// Deterministic translations: t('foo', { name: 'A' }) -> 'foo::A'.
// Lets us locate the per-chip drag handle by aria-label without depending
// on the lazy tenant namespace finishing its dynamic import inside the
// happy-dom test environment.
// ---------------------------------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object') {
        const parts: string[] = [key];
        for (const [k, v] of Object.entries(opts)) {
          parts.push(`${k}=${String(v)}`);
        }
        return parts.join('::');
      }
      return key;
    },
  }),
}));

import PinnedSavedViewsBar from '../../client-app/src/pages/calls/PinnedSavedViewsBar';
import type { SavedView } from '../../client-app/src/pages/calls/types';

function makeView(overrides: Partial<SavedView> & Pick<SavedView, 'id' | 'name' | 'pin_order'>): SavedView {
  return {
    filters: {},
    is_shared: false,
    is_pinned: true,
    created_by: 'user-1',
    ...overrides,
  };
}

const SAVED_VIEWS: SavedView[] = [
  makeView({ id: 'view-a', name: 'Active Calls', pin_order: 0 }),
  makeView({ id: 'view-b', name: 'Booked Today', pin_order: 1 }),
  makeView({ id: 'view-c', name: 'Cold Leads', pin_order: 2 }),
];

const NOOP = () => {};
const ASYNC_NOOP = async () => {};

interface RigResult {
  client: QueryClient;
  persistPinnedOrder: ReturnType<typeof vi.fn>;
  unmount: () => void;
  container: HTMLElement;
}

function renderBar(): RigResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Seed the cache the way `Calls.tsx` does — the optimistic update path
  // in PinnedSavedViewsBar reads from this exact key shape.
  client.setQueryData(['call-saved-views'], { views: SAVED_VIEWS });

  const persistPinnedOrder = vi.fn().mockResolvedValue(undefined);

  const utils = render(
    <QueryClientProvider client={client}>
      <PinnedSavedViewsBar
        savedViews={SAVED_VIEWS}
        activeViewId={null}
        setActiveViewId={NOOP}
        isViewDirty={false}
        currentUserId="user-1"
        currentUserEmail="owner@acme.test"
        subscribersOpenFor={null}
        setSubscribersOpenFor={NOOP}
        applySavedView={NOOP}
        handleTogglePin={ASYNC_NOOP}
        handleToggleDigest={ASYNC_NOOP}
        handleToggleSubscribe={ASYNC_NOOP}
        handleDeleteView={ASYNC_NOOP}
        persistPinnedOrder={persistPinnedOrder}
        clearFilters={NOOP}
        queryClient={client}
      />
    </QueryClientProvider>,
  );

  return { client, persistPinnedOrder, unmount: utils.unmount, container: utils.container };
}

// Chip wrapper divs all carry the drag handle as their first child button.
// Locate them via the handle's stable i18n-keyed aria-label.
function getChipHandles(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="calls.saved_view.drag_handle_aria"]',
    ),
  );
}

function patchChipRects(container: HTMLElement) {
  // Lay the chips out left-to-right at distinct x positions so dnd-kit's
  // sortableKeyboardCoordinates can resolve "the chip to the right of the
  // active one" deterministically. happy-dom's default getBoundingClientRect
  // returns all zeros, which would make every chip a single coincident point.
  const handles = getChipHandles(container);
  handles.forEach((handle, idx) => {
    const wrapper = handle.parentElement as HTMLElement;
    const left = idx * 200;
    const top = 0;
    const width = 150;
    const height = 32;
    const rect: DOMRect = {
      x: left,
      y: top,
      width,
      height,
      left,
      right: left + width,
      top,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect;
    Object.defineProperty(wrapper, 'getBoundingClientRect', {
      value: () => rect,
      configurable: true,
    });
  });
}

async function flushTimers(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  // happy-dom polyfills are otherwise fine; nothing to set up globally.
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PinnedSavedViewsBar keyboard drag-to-reorder (task #1144)', () => {
  it('moves the active chip one slot to the right and persists the new order', async () => {
    const { container, persistPinnedOrder, client, unmount } = renderBar();

    const handles = getChipHandles(container);
    expect(handles).toHaveLength(SAVED_VIEWS.length);

    patchChipRects(container);

    const handleA = handles[0];
    handleA.focus();

    // Activator: Space on the handle starts the drag. dnd-kit's
    // KeyboardSensor.attach defers binding the document-level keydown
    // listener via setTimeout(0), so we flush a 0-timer afterwards.
    await act(async () => {
      handleA.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flushTimers(0);

    // Move right one slot. ArrowRight is consumed by the document-level
    // listener that the KeyboardSensor just attached.
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          code: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flushTimers(0);

    // Drop. Space (also Enter / Tab) ends the drag and triggers onDragEnd.
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flushTimers(0);

    // 1. The page's persistPinnedOrder callback should have been invoked
    //    exactly once with the new ordering. A is now after B; C is
    //    still last. This matches POST /call-saved-views/pinned/reorder
    //    { ids: [...] } in Calls.tsx.
    expect(persistPinnedOrder).toHaveBeenCalledTimes(1);
    expect(persistPinnedOrder).toHaveBeenCalledWith(['view-b', 'view-a', 'view-c']);

    // 2. The optimistic React Query cache update must have been written
    //    BEFORE persistPinnedOrder (or its underlying network request)
    //    resolves, so the chips don't visually snap back. We assert the
    //    pin_order values reflect the reordered list.
    const cached = client.getQueryData<{ views: SavedView[] }>(['call-saved-views']);
    expect(cached).toBeTruthy();
    const byId = new Map(cached!.views.map((v) => [v.id, v]));
    expect(byId.get('view-b')?.pin_order).toBe(0);
    expect(byId.get('view-a')?.pin_order).toBe(1);
    expect(byId.get('view-c')?.pin_order).toBe(2);

    unmount();
  });

  it('does not call persistPinnedOrder if the user activates and immediately drops without moving', async () => {
    const { container, persistPinnedOrder, client, unmount } = renderBar();

    patchChipRects(container);
    const [handleA] = getChipHandles(container);
    handleA.focus();

    // Space to start, then Space again to drop with no movement in between.
    await act(async () => {
      handleA.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flushTimers(0);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flushTimers(0);

    // No reorder happened, so the no-op guard inside `handleDragEnd`
    // (`if (!over || active.id === over.id) return;`) should have
    // suppressed the network call AND left the cache untouched.
    expect(persistPinnedOrder).not.toHaveBeenCalled();
    const cached = client.getQueryData<{ views: SavedView[] }>(['call-saved-views']);
    expect(cached?.views.map((v) => v.id)).toEqual(['view-a', 'view-b', 'view-c']);
    expect(cached?.views.map((v) => v.pin_order)).toEqual([0, 1, 2]);

    unmount();
  });
});
