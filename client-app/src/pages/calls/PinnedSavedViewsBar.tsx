import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { format, formatDistanceToNow } from 'date-fns';
import { Users, Star, Mail, MailX, Pin, PinOff, GripVertical, Trash2 } from 'lucide-react';
import type { QueryClient } from '@tanstack/react-query';
import type { SavedView } from './types';

type PinnedDragHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
};

type PinnedSortableState = {
  setNodeRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  isDragging: boolean;
  handle: PinnedDragHandleProps;
};

function SortablePinnedChip({
  id,
  render,
}: {
  id: string;
  render: (state: PinnedSortableState) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };
  return <>{render({ setNodeRef, style, isDragging, handle: { attributes, listeners } })}</>;
}

export interface PinnedSavedViewsBarProps {
  savedViews: SavedView[];
  activeViewId: string | null;
  setActiveViewId: (id: string | null) => void;
  isViewDirty: boolean;
  currentUserId: string | null;
  currentUserEmail: string | null;
  subscribersOpenFor: string | null;
  setSubscribersOpenFor: (id: string | null) => void;
  applySavedView: (view: SavedView) => void;
  handleTogglePin: (view: SavedView) => void | Promise<void>;
  handleToggleDigest: (view: SavedView) => void | Promise<void>;
  handleToggleSubscribe: (view: SavedView) => void | Promise<void>;
  handleDeleteView: (id: string) => void | Promise<void>;
  persistPinnedOrder: (orderedIds: string[]) => void | Promise<void>;
  clearFilters: () => void;
  queryClient: QueryClient;
}

export default function PinnedSavedViewsBar({
  savedViews,
  activeViewId,
  setActiveViewId,
  isViewDirty,
  currentUserId,
  currentUserEmail,
  subscribersOpenFor,
  setSubscribersOpenFor,
  applySavedView,
  handleTogglePin,
  handleToggleDigest,
  handleToggleSubscribe,
  handleDeleteView,
  persistPinnedOrder,
  clearFilters,
  queryClient,
}: PinnedSavedViewsBarProps) {
  const { t: tenantT } = useTranslation('tenant');
  const pinnedDragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Pins are per-user, so any view this user has pinned (whether they own it or not)
  // participates in their personal drag-to-reorder list.
  const myPinnedOrdered = savedViews
    .filter((v) => v.is_pinned)
    .sort((a, b) => ((a.pin_order ?? 0) - (b.pin_order ?? 0)) || a.name.localeCompare(b.name));
  const myPinnedIndex = new Map(myPinnedOrdered.map((v, i) => [v.id, i]));
  const pinnedIds = myPinnedOrdered.map((v) => v.id);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = pinnedIds.indexOf(String(active.id));
    const newIdx = pinnedIds.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(pinnedIds, oldIdx, newIdx);
    // Optimistically update the cached saved views so the chips don't snap back.
    queryClient.setQueryData<{ views: SavedView[] }>(['call-saved-views'], (prev) => {
      if (!prev?.views) return prev;
      const orderMap = new Map(reordered.map((id, i) => [id, i]));
      const next = prev.views.map((v) =>
        orderMap.has(v.id) ? { ...v, pin_order: orderMap.get(v.id)! } : v,
      );
      return { ...prev, views: next };
    });
    void persistPinnedOrder(reordered);
  };

  const renderChipMarkup = (view: SavedView, sortable: PinnedSortableState | null) => {
    const isActive = activeViewId === view.id && !isViewDirty;
    const isOwner = !!currentUserId && view.created_by === currentUserId;
    const myPinIdx = myPinnedIndex.get(view.id);
    const isSortablePinned = myPinIdx !== undefined && myPinnedOrdered.length > 1;
    const lastRunRel = view.digest_last_run_at
      ? formatDistanceToNow(new Date(view.digest_last_run_at), { addSuffix: true })
      : null;
    const lastRunAbs = view.digest_last_run_at
      ? format(new Date(view.digest_last_run_at), 'PPp')
      : null;
    const matchCount = view.digest_last_match_count ?? 0;
    const digestStatus = view.digest_enabled
      ? (lastRunRel && lastRunAbs
          ? tenantT('calls.saved_view.digest_status_with_run', { count: matchCount, rel: lastRunRel, abs: lastRunAbs })
          : tenantT('calls.saved_view.digest_status_no_run'))
      : null;
    return (
      <div
        ref={sortable?.setNodeRef}
        style={sortable?.style}
        className={`group inline-flex items-center gap-1 rounded-full border text-sm transition ${isActive ? 'border-primary bg-primary-light text-primary' : 'border-border bg-surface text-text-secondary hover:bg-surface-hover'} ${sortable?.isDragging ? 'shadow-lg ring-2 ring-primary/40' : ''}`}
      >
        {isSortablePinned && sortable && (
          <button
            type="button"
            {...sortable.handle.attributes}
            {...sortable.handle.listeners}
            className="touch-none cursor-grab active:cursor-grabbing pl-2 pr-0.5 py-1.5 text-text-muted hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-l-full"
            title={tenantT('calls.saved_view.drag_handle')}
            aria-label={tenantT('calls.saved_view.drag_handle_aria', { name: view.name })}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => applySavedView(view)}
          className={`inline-flex items-center gap-1.5 ${isSortablePinned ? 'pl-1' : 'pl-3'} pr-2 py-1.5 font-medium`}
          title={[
            view.is_shared
              ? (isOwner ? tenantT('calls.saved_view.shared_owner') : tenantT('calls.saved_view.shared_member'))
              : tenantT('calls.saved_view.personal'),
            digestStatus,
          ].filter(Boolean).join('\n')}
        >
          {view.is_shared ? <Users className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
          {view.name}
        </button>
        {view.digest_enabled && (
          <span
            className="text-xs text-text-muted whitespace-nowrap"
            title={digestStatus ?? undefined}
          >
            · {lastRunRel
              ? tenantT('calls.saved_view.digest_chip_with_run', { count: matchCount, rel: lastRunRel })
              : tenantT('calls.saved_view.digest_chip_no_run')}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); handleTogglePin(view); }}
          className={`p-1 ${isOwner ? '' : 'mr-1'} rounded-full transition ${view.is_pinned ? 'text-primary' : 'text-text-muted hover:text-primary'}`}
          title={view.is_pinned ? tenantT('calls.saved_view.unpin_tooltip') : tenantT('calls.saved_view.pin_tooltip')}
          aria-label={view.is_pinned
            ? tenantT('calls.saved_view.unpin_aria', { name: view.name })
            : tenantT('calls.saved_view.pin_aria', { name: view.name })}
        >
          {view.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
        {isOwner ? (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); handleToggleDigest(view); }}
              className={`p-1 rounded-full transition ${view.digest_enabled ? 'text-primary' : 'text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100'}`}
              title={
                view.digest_enabled
                  ? `${tenantT('calls.saved_view.digest_on_tooltip')}\n${digestStatus ?? ''}`.trim()
                  : tenantT('calls.saved_view.digest_off_tooltip')
              }
              aria-label={view.digest_enabled
                ? tenantT('calls.saved_view.digest_on_aria', { name: view.name })
                : tenantT('calls.saved_view.digest_off_aria', { name: view.name })}
            >
              {view.digest_enabled ? <Mail className="h-3.5 w-3.5" /> : <MailX className="h-3.5 w-3.5" />}
            </button>
            {view.is_shared && (view.digest_subscribers?.length ?? 0) > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setSubscribersOpenFor(subscribersOpenFor === view.id ? null : view.id); }}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs transition ${subscribersOpenFor === view.id ? 'bg-primary text-white' : 'text-text-muted hover:text-text-primary'}`}
                title={tenantT('calls.saved_view.subscribers_chip_tooltip', { count: view.digest_subscribers!.length })}
                aria-label={tenantT('calls.saved_view.subscribers_chip_aria', { count: view.digest_subscribers!.length, name: view.name })}
                aria-expanded={subscribersOpenFor === view.id}
              >
                <Users className="h-3.5 w-3.5" />
                {view.digest_subscribers!.length}
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); handleDeleteView(view.id); }}
              className="p-1 mr-1 rounded-full text-text-muted hover:text-red-600 opacity-0 group-hover:opacity-100 transition"
              title={tenantT('calls.saved_view.delete_tooltip')}
              aria-label={tenantT('calls.saved_view.delete_aria', { name: view.name })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (view.is_shared && view.digest_enabled && currentUserEmail) ? (
          (() => {
            const subscribed = (view.digest_subscribers ?? []).map((e) => e.toLowerCase()).includes(currentUserEmail);
            return (
              <button
                onClick={(e) => { e.stopPropagation(); handleToggleSubscribe(view); }}
                className={`p-1 mr-1 rounded-full transition ${subscribed ? 'text-primary' : 'text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100'}`}
                title={subscribed ? tenantT('calls.saved_view.subscribed_tooltip') : tenantT('calls.saved_view.not_subscribed_tooltip')}
                aria-label={subscribed
                  ? tenantT('calls.saved_view.subscribed_aria', { name: view.name })
                  : tenantT('calls.saved_view.not_subscribed_aria', { name: view.name })}
              >
                {subscribed ? <Mail className="h-3.5 w-3.5" /> : <MailX className="h-3.5 w-3.5" />}
              </button>
            );
          })()
        ) : null}
      </div>
    );
  };

  return (
    <DndContext
      sensors={pinnedDragSensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={pinnedIds} strategy={rectSortingStrategy}>
        <div className="flex flex-wrap items-center gap-2">
          {savedViews.map((view) => {
            const isMyPinnedSortable =
              view.is_pinned && myPinnedOrdered.length > 1;
            if (isMyPinnedSortable) {
              return (
                <SortablePinnedChip
                  key={view.id}
                  id={view.id}
                  render={(s) => renderChipMarkup(view, s)}
                />
              );
            }
            return <Fragment key={view.id}>{renderChipMarkup(view, null)}</Fragment>;
          })}
          {activeViewId && (
            <button
              onClick={() => { setActiveViewId(null); clearFilters(); }}
              className="text-xs text-text-secondary hover:text-text-primary px-2 py-1"
            >
              {tenantT('calls.saved_view.reset')}
            </button>
          )}
        </div>
      </SortableContext>
    </DndContext>
  );
}
