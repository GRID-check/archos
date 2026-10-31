'use client'

/**
 * The inbox list — the surface that answers "what needs me?" (spec IB-20).
 *
 * Owns exactly two things: the filter the user is looking through, and the
 * layout of the four states a list can be in (loading / error / empty / rows).
 * All data comes from `useInboxList`, which re-reads on live events, on focus and
 * on a slow poll while the live channel is down — so this component never has to
 * know whether an update arrived by push or by poll.
 *
 * Accessibility notes that are requirements, not polish:
 *   - a small `role="status"` region carries the announcement — NOT the row
 *     container, which would read the whole list aloud on every filter change
 *     and every archive. It states the count of things needing attention (NF-3),
 *     and says nothing at all when that count is zero — "nothing needs you" is
 *     already on screen as the empty state and is not worth interrupting for;
 *     an arrival that leaves the count unchanged is likewise not announced,
 *     which is a known narrowing of NF-3 rather than the intent;
 *   - the filter is a single-select `ToggleGroup` (`role="radiogroup"`) rather
 *     than loose unlabelled buttons;
 *   - the empty state differs per filter, because "nothing needs you" and "your
 *     inbox is empty" are different facts and collapsing them misleads;
 *   - the list can be worked from the keyboard: j/k move between rows, Enter
 *     opens the row, e archives it, u toggles it read (the shortcuts sheet's
 *     „Postfach“ group). The keys are the list's own while focus is not in a
 *     field, so typing a reply never archives anything.
 *
 * The three filters are three questions: „Für mich“ is what is new or waits
 * on the reader (the badge's number: an open request, or a row not yet
 * opened), „Alle“ everything, and „Archiviert“ what they put away, which can
 * come back from there. Opening a piece of news takes it out of „Für mich“,
 * as reading a mail does; `u` puts it back. A request stays until it is
 * answered.
 *
 * The filter is in the page's address (`filter=all|archived`; „Für
 * mich“, the default, is not written), as Offene Punkte keeps its own: a row
 * that opens a mark carries this address as `back`, so closing the review
 * comes back to the filter the reader left, and a reload keeps it. A change
 * replaces the address with `history.replaceState`, which Next's router
 * follows (`useSearchParams` reads it) without asking the server again.
 */

import type { FocusEvent, JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { AlertCircle, Archive, Bell, CheckCheck, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

import { useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { useInboxBadge, useInboxList } from '../hooks/use-inbox'
import { ARCHIVE_UNDO_MS, useUndoableArchive } from '../hooks/use-undoable-archive'
import type { InboxItemView, InboxListFilter } from '@/lib/inbox/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemContent, ItemList, ItemMedia } from '@/components/ui/item'
import { LoadError } from '@/components/ui/load-error'
import { LoadMore } from '@/components/ui/load-more'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AnimatePresence } from '@/components/motion'
import { cn } from '@/lib/utils'
import { NotificationPrompt } from '@/features/notifications/components/notification-prompt'
import { focusLost, restoreFocus } from '@/features/documents/components/review/focus-return'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { SectionLabel } from '@/components/ui/section-label'
import { inboxSections } from '../lib/inbox-day-groups'
import { InboxItemRow } from './InboxItemRow'
import { InboxQueue } from './InboxQueue'

type InboxFilter = 'needsMe' | 'all' | 'archived'

const FILTERS: readonly InboxFilter[] = ['needsMe', 'all', 'archived']

/**
 * Which slice of the API each filter reads. „Für mich“ is `pending`, the set
 * the badge counts (an open request, or anything not yet opened): a bell
 * saying 18 opened on a tab saying 8, because the tab counted requests alone
 * and the news sat one tab over under „Ungelesen“. One number, one place.
 */
const API_FILTER: Record<InboxFilter, InboxListFilter> = {
  needsMe: 'pending',
  all: 'all',
  archived: 'archived',
}

const EMPTY_ICON = { needsMe: CheckCircle2, all: Bell, archived: Archive } as const

function isInboxFilter(value: string): value is InboxFilter {
  return (FILTERS as readonly string[]).includes(value)
}

/** The page's address parameter that holds the filter. */
const FILTER_PARAM = 'filter'

/** The filter the page's address names; anything else is `fallback`. */
function filterOf(params: Pick<URLSearchParams, 'get'> | null, fallback: InboxFilter): InboxFilter {
  const named = params?.get(FILTER_PARAM)
  return named && isInboxFilter(named) ? named : fallback
}

/**
 * This page's address with `filter` on it, leaving out the default („Für mich“)
 * and keeping every other param: what a row's link carries as `back`.
 */
function hrefOf(pathname: string, current: string, filter: InboxFilter): string {
  const params = new URLSearchParams(current)
  if (filter === 'needsMe') params.delete(FILTER_PARAM)
  else params.set(FILTER_PARAM, filter)
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

/** Whether a key press belongs to whatever has focus rather than to the list. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest('input, textarea, select, [role="textbox"], [role="menu"], [role="listbox"]')) return true
  return false
}

export interface InboxListProps {
  /**
   * False for an organization without the collaboration flag: the hooks then open
   * no connection and issue no request at all (NF-8).
   */
  enabled?: boolean
  /**
   * Which filter the list opens on when the page's address names none. Defaults
   * to `needsMe` — the inbox exists to answer "what needs me?" — but an entry
   * point that means "show me everything that happened" can seed the other one.
   * Seed only: the address, and the user's clicks, own it from then on.
   */
  initialFilter?: InboxFilter
  /** The reader: a quoted mention of them is drawn louder, as the thread draws it. */
  viewerId?: string | null
  className?: string
}

export function InboxList({
  enabled = true,
  initialFilter = 'needsMe',
  viewerId = null,
  className,
}: InboxListProps): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [filter, setFilter] = useState<InboxFilter>(() => filterOf(searchParams, initialFilter))
  /** A filter changes the list and the address, so a review opened from a row comes back to it. */
  const choose = (next: InboxFilter): void => {
    setFilter(next)
    setFocusedId(null)
    if (pathname) window.history.replaceState(null, '', hrefOf(pathname, searchParams?.toString() ?? '', next))
  }

  const {
    items,
    pending,
    loading,
    error,
    mutationError,
    dismissMutationError,
    mutating,
    refresh,
    hasMore,
    loadingMore,
    loadMoreFailed,
    loadMore,
    markRead,
    markUnread,
    markAllRead,
    archive,
    unarchive,
    // „Für mich“ is the queue (`InboxQueue`), which reads its own two slices:
    // this read idles there, so the page asks the server once per question.
  } = useInboxList(enabled && filter !== 'needsMe', API_FILTER[filter])
  const queued = filter === 'needsMe'
  // The badge's number is what „Für mich“ holds; the queue's reads do not count it.
  const badge = useInboxBadge(enabled && queued)
  const shownPending = queued ? badge.pending : pending

  const archiveLater = useUndoableArchive(archive)
  // A row waiting out its undo window is already gone as far as the reader can
  // tell; the server hears about it when the window closes.
  const visibleItems = items.filter((item) => !archiveLater.pendingIds.has(item.id))
  const hasUnread = visibleItems.some((item) => !item.read)

  const onArchive = useCallback(
    (itemId: string): void => {
      archiveLater.request(itemId)
      toast(t('inbox.archived'), {
        duration: ARCHIVE_UNDO_MS,
        action: { label: t('inbox.undo'), onClick: () => archiveLater.undo(itemId) },
      })
    },
    [archiveLater, t],
  )

  const onUnarchive = useCallback(
    (itemId: string): void => {
      // Said once it is true: a refused restore shows the list's own error instead.
      void unarchive(itemId).then((restored) => {
        if (restored) toast(t('inbox.unarchived'))
      })
    },
    [unarchive, t],
  )

  const onOpen = useCallback(
    (item: InboxItemView) => {
      if (!item.read) void markRead([item.id])
    },
    [markRead],
  )

  // ---- Keyboard triage: j/k move, Enter opens, e archives, u toggles read ----
  const rootRef = useRef<HTMLDivElement>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const focusedIndex = visibleItems.findIndex((item) => item.id === focusedId)

  /** Focus a row; `scroll` brings it into view, as a key moving through the list wants and a handoff the reader did not ask for does not. */
  const focusRow = useCallback((itemId: string, { scroll = true }: { scroll?: boolean } = {}) => {
    setFocusedId(itemId)
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`)
    row?.focus({ preventScroll: true })
    if (scroll) row?.scrollIntoView?.({ block: 'nearest' })
  }, [])

  // ---- The focus stays on the list when its row leaves ----
  // A row can leave with the focus in it without a key pressed here: a refresh
  // drops it (under „Für mich“ a mark resolved from its row is no open request,
  // and the re-read after the undo window takes the row with its outcome line).
  // The focus would fall to the page. It goes to the row now at that place, or
  // to the list when none is left. A row on its way out (its exit animation)
  // still holds the focus, so that counts as lost too.
  const listRef = useRef<HTMLDivElement>(null)
  const heldRowId = useRef<string | null>(null)
  const shownIds = useRef<string[]>([])
  useEffect(() => {
    const previous = shownIds.current
    shownIds.current = visibleItems.map((item) => item.id)
    const held = heldRowId.current
    if (!held || shownIds.current.includes(held)) return
    heldRowId.current = null
    const active = document.activeElement
    const inLeavingRow = active instanceof Element && active.closest('[data-item-id]')?.getAttribute('data-item-id') === held
    if (!inLeavingRow && !focusLost()) return
    const next = visibleItems[Math.min(Math.max(previous.indexOf(held), 0), visibleItems.length - 1)]
    // Without scrolling: the reader may have scrolled on during the undo window, and stays where they read.
    if (next) focusRow(next.id, { scroll: false })
    else restoreFocus(listRef.current)
  }, [visibleItems, focusRow])
  /** Which row the focus is in, so its leaving can hand the focus on. */
  const trackFocus = (event: FocusEvent<HTMLDivElement>): void => {
    heldRowId.current = event.target.closest('[data-item-id]')?.getAttribute('data-item-id') ?? null
  }
  const dropFocus = (event: FocusEvent<HTMLDivElement>): void => {
    // Only when the reader takes it elsewhere: a row unmounting blurs to nothing.
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) heldRowId.current = null
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (typingInto(event.target)) return
      // The list's keys work wherever its page is: inside its sheet, or on the
      // page when nothing else holds the focus.
      const scope = root.closest('[role="dialog"]') ?? document.body
      if (event.target instanceof Node && event.target !== document.body && !scope.contains(event.target)) return
      const key = event.key
      if (key !== 'j' && key !== 'k' && key !== 'Enter' && key !== 'e' && key !== 'u') return
      if (queued || visibleItems.length === 0) return
      const current = focusedIndex >= 0 ? visibleItems[focusedIndex] : null
      if (key === 'j' || key === 'k') {
        event.preventDefault()
        const next =
          focusedIndex < 0
            ? key === 'j'
              ? 0
              : visibleItems.length - 1
            : Math.min(visibleItems.length - 1, Math.max(0, focusedIndex + (key === 'j' ? 1 : -1)))
        focusRow(visibleItems[next].id)
        return
      }
      if (!current) return
      // Enter on a focused control (a row's button) is that control's.
      if (key === 'Enter' && event.target instanceof HTMLElement && event.target.closest('button, a')) return
      event.preventDefault()
      if (key === 'Enter') {
        root.querySelector<HTMLAnchorElement>(`[data-item-id="${CSS.escape(current.id)}"] [data-testid="inbox-item-link"]`)?.click()
        return
      }
      if (key === 'e') {
        if (current.archived) onUnarchive(current.id)
        else onArchive(current.id)
        // The keyboard stays on the list: the next row takes the focus the
        // archived one had, in the DOM as well as in the ring.
        const neighbour = visibleItems[focusedIndex + 1] ?? visibleItems[focusedIndex - 1]
        if (neighbour) focusRow(neighbour.id)
        else setFocusedId(null)
        return
      }
      if (!current.read) void markRead([current.id])
      else if (current.state !== 'inert') void markUnread([current.id])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [queued, visibleItems, focusedIndex, focusRow, markRead, markUnread, onArchive, onUnarchive])

  // The count each filter wears: what waits on the reader, and what is unread.
  const filterCount = (key: InboxFilter): number => (key === 'needsMe' ? shownPending : 0)
  const emptyKey = filter

  return (
    // A reading measure: inbox rows are reading material, and a 1400px line of them is not.
    <div
      ref={rootRef}
      className={cn('mx-auto w-full max-w-3xl space-y-4', className)}
      onFocus={trackFocus}
      onBlur={dropFocus}
    >
      {/* ---- Filter + bulk action ---- */}
      {/* `min-h-8` holds the toolbar's line even if the filter wraps, so a
          count arriving cannot lift the list. */}
      <div className="flex min-h-8 items-center justify-between gap-2">
        {/* One line at any width: on a phone the four filters ran off the
            screen's edge („Archivie…“) and the bulk action took a line of its
            own. The filters scroll sideways inside their own box instead. */}
        <div className="-mx-1 min-w-0 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ToggleGroup
          type="single"
          // Segmented with a filled thumb: the outlined pair this was before
          // told the selected filter apart by a hairline, which dark mode lost.
          segmented
          variant="inverted"
          size="sm"
          value={filter}
          onValueChange={(value) => {
            // type=single can emit "" when the pressed item is clicked again;
            // the inbox always has a filter, so ignore a clear.
            if (isInboxFilter(value)) choose(value)
          }}
          aria-label={t('inbox.filters.ariaLabel')}
        >
          {FILTERS.map((key) => {
            const count = filterCount(key)
            return (
              <ToggleGroupItem key={key} value={key} aria-label={key === 'archived' ? t('inbox.filters.archived') : undefined}>
                {/* „Archiviert“ is the filter visited least, and on a phone its
                    word was the one pushed off the screen: there it is its icon. */}
                {key === 'archived' ? (
                  <>
                    <Archive aria-hidden className="sm:hidden" />
                    <span className="max-sm:hidden">{t('inbox.filters.archived')}</span>
                  </>
                ) : (
                  t(`inbox.filters.${key}`)
                )}
                {/* Only when there is a number to say: an invisible pill kept
                    a blank tail after the label at zero. */}
                {count > 0 && <CountPill count={count} className={cn(filter === key && 'bg-background/20 text-current')} />}
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>
        </div>

        {/* Nothing to mark on an empty list, and nothing to read under
            „Archiviert“: the button would be a control with no job. */}
        {!queued && visibleItems.length > 0 && filter !== 'archived' && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground"
            disabled={!hasUnread || mutating}
            aria-label={t('inbox.markAllRead')}
            title={t('inbox.markAllRead')}
            onClick={() => void markAllRead()}
          >
            <CheckCheck aria-hidden />
            <span className="max-sm:hidden">{t('inbox.markAllReadShort')}</span>
          </Button>
        )}
      </div>

      {/* Offered once, never forced (ADR-0112): shown only where this browser can
          show notifications and has not been asked. */}
      <NotificationPrompt />

      {/* A refused action — most often a row a second tab already archived. It
          belongs beside the list, not instead of it: replacing the rows with
          "your inbox could not be loaded" made a working inbox look broken and
          stated something that had not happened. */}
      {mutationError && (
        <Alert
          variant="destructive"
          className="animate-in fade-in-0 duration-snap ease-out motion-reduce:animate-none"
        >
          <AlertCircle />
          <AlertTitle className="line-clamp-none">{t('inbox.errors.actionFailed')}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 pt-1">
            <Button variant="outline" size="sm" onClick={dismissMutationError}>
              {t('sharing.errors.dismiss')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* ---- The list itself ----
          The live region is the small `role="status"` node below, NOT this
          container: announcing the container meant a screen reader read the whole
          inbox — every row, title, body, excerpt and timestamp — on the first
          skeleton→rows swap, on every filter change and after every archive. */}
      {/* Focusable from code only: where the focus goes when the last row leaves with it. */}
      {queued ? (
        <InboxQueue enabled={enabled} />
      ) : (
      <div ref={listRef} data-testid="inbox-list" tabIndex={-1} className="outline-none">
        {error ? (
          <LoadError title={t('inbox.errors.loadFailed')} onRetry={() => refresh()} />
        ) : loading ? (
          <ItemList as="ul" data-testid="inbox-skeleton" aria-busy="true" className="bg-card shadow-xs">
            {Array.from({ length: 4 }).map((_, index) => (
              <Item as="li" key={index} className="items-start py-3.5">
                <ItemMedia>
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                </ItemMedia>
                <ItemContent className="flex flex-col gap-2">
                  <Skeleton className="h-3.5 w-3/5" />
                  <Skeleton className="h-2.5 w-1/3" />
                  <Skeleton className="h-2.5 w-20" />
                </ItemContent>
              </Item>
            ))}
          </ItemList>
        ) : visibleItems.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICON[emptyKey]}
            title={t(`inbox.empty.${emptyKey}Title`)}
            description={t(`inbox.empty.${emptyKey}Description`)}
          />
        ) : (
          /* Sections by the day a row last changed („Heute“, „Gestern“ …): one
             heading does the date arithmetic forty timestamps left to the
             reader. The order is the server's; the sections only cut it, so
             j/k walks the rows as drawn. */
          <div className="space-y-5">
            {inboxSections(visibleItems, new Date()).map((section, index) => (
              <section key={`${section.group}-${index}`} aria-labelledby={`inbox-section-${index}`} data-testid="inbox-section">
                <SectionLabel as="h3" id={`inbox-section-${index}`} className="mb-2 block px-1">
                  {t(`inbox.groups.${section.group}`)}
                </SectionLabel>
                <ItemList as="ul" className="bg-card shadow-xs">
                  {/* Archiving a row is the one action here, and it removes that row —
                      so the list needs an exit, which CSS cannot give it, and `layout`
                      so the rows below close the gap instead of jumping.

                      No entrance stagger. The inbox is a work queue people open to
                      triage, and a cascade makes the first glance slower every single
                      time for a flourish that only reads once. Motion here is reserved
                      for a change the user causes. */}
                  <AnimatePresence initial={false} mode="popLayout">
                    {section.items.map((item) => (
                      <InboxItemRow
                        key={item.id}
                        item={item}
                        focused={item.id === focusedId}
                        viewerId={viewerId}
                        onOpen={onOpen}
                        onArchive={onArchive}
                        onUnarchive={onUnarchive}
                        onMarkRead={(itemId) => void markRead([itemId])}
                        onMarkUnread={(itemId) => void markUnread([itemId])}
                      />
                    ))}
                  </AnimatePresence>
                </ItemList>
              </section>
            ))}
          </div>
        )}
        {/* The list stopped at a page and used to say nothing about it. */}
        {!error && !loading && (
          <LoadMore
            hasMore={hasMore}
            loading={loadingMore}
            failed={loadMoreFailed}
            onLoadMore={loadMore}
            loadMoreLabel={t('inbox.loadMore')}
            loadingLabel={t('inbox.loadingMore')}
            failedLabel={t('inbox.loadMoreFailed')}
          />
        )}
      </div>
      )}

      {/* The list's keys were there and nowhere said: a quiet line under the
          rows, where a pointer and a keyboard are (a phone has neither). Aria-
          hidden: the shortcuts sheet is where a screen reader learns them. */}
      {!error && !loading && (queued || visibleItems.length > 0) && (
        <p
          aria-hidden
          data-testid="inbox-key-hint"
          className="hidden flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground pointer-fine:flex"
        >
          <span className="inline-flex items-center gap-1"><KbdGroup><Kbd>j</Kbd><Kbd>k</Kbd></KbdGroup>{t('inbox.keys.move')}</span>
          <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd>{t('inbox.keys.open')}</span>
          <span className="inline-flex items-center gap-1"><Kbd>e</Kbd>{t('inbox.keys.archive')}</span>
          <span className="inline-flex items-center gap-1"><Kbd>u</Kbd>{t('inbox.keys.read')}</span>
        </p>
      )}

      {/* The whole announcement, in one always-mounted node: how many things need
          this person. A live region that is created at the same moment as its
          content is routinely dropped by screen readers, so it is mounted whether
          or not there is anything to say.

          Nothing to say is the literal case at zero: "0 items need your attention"
          is not news, and this region is re-read on every filter change and after
          every archive — so an empty queue interrupted the reader to tell them
          about nothing, over and over. */}
      <p className="sr-only" role="status" aria-live="polite">
        {(loading && !queued) || shownPending === 0
          ? ''
          : shownPending === 1
            ? t('inbox.badgeAriaOne')
            : t('inbox.badgeAria', { count: shownPending })}
      </p>
    </div>
  )
}
