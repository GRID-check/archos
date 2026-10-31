'use client'

/**
 * „Für mich“ as a queue: what waits on the reader, gathered by document or
 * chat and most urgent first, then what is new.
 *
 * A list, never a copy of what it lists (ADR-0148). Every entry is a link to
 * its real place: the chat at the message, the review at the mark. Docked
 * beside the page (`InboxDock`), following one replaces the page beside the
 * list; on the Postfach page it leaves the page, and closing the review comes
 * back to it (`returnHere`). Which entry is current is read from the address,
 * so it is right however the reader got there.
 *
 * Two reads, because they answer two questions: what waits on the reader (the
 * open requests, `requests`, every one of them however old) and what is new
 * (`unread`). Read as one page of „pending“, a request older than fifty news
 * rows fell behind „Ältere laden“, and the queue's first promise is that what
 * waits on you is on top.
 *
 * Keys, while focus is not in a field: j/k move between entries, Enter follows
 * the focused one (the link's own), e archives it, u toggles it read. Where
 * they listen is `keyScope`: the page or sheet the list is on, or only the
 * list itself when it is docked beside a page that has keys of its own.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { AlertCircle, Check } from 'lucide-react'
import { toast } from 'sonner'

import { useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { localCalendarDay } from '@/lib/format'
import { inboxClient, type InboxClient } from '@/lib/inbox/client'
import { isMarkAnchored, type InboxItemView } from '@/lib/inbox/types'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FadeIn, motion, springSnap, useMotionToken } from '@/components/motion'
import { LoadError } from '@/components/ui/load-error'
import { LoadMore } from '@/components/ui/load-more'
import { Skeleton } from '@/components/ui/skeleton'
import { withReviewBack } from '@/features/documents/review-links'
import { useInboxList } from '../hooks/use-inbox'
import { ARCHIVE_UNDO_MS, useUndoableArchive } from '../hooks/use-undoable-archive'
import { isAtHref, isOpenRequest, newsOf, queueOrder, waitingGroups } from '../lib/inbox-queue'
import { isPlainClick } from '../lib/plain-click'
import { InboxQueueList } from './InboxQueueList'

export interface InboxQueueProps {
  enabled?: boolean
  /**
   * Whether following an entry should come back here when its review closes:
   * true on the Postfach page, which the entry leaves; false docked, where the
   * list never went away.
   */
  returnHere?: boolean
  /** Where j/k/e/u listen: the page or sheet the list is on, or only the list itself. */
  keyScope?: 'page' | 'self'
  /** Injected by the specs and the preview. */
  client?: InboxClient
}

const QUEUE_KEYS = new Set(['j', 'k', 'e', 'u'])

/** Whether a key press belongs to whatever has focus rather than to the queue. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.closest('input, textarea, select, [role="textbox"], [role="menu"], [role="listbox"]') !== null
}

export function InboxQueue({ enabled = true, returnHere = true, keyScope = 'page', client = inboxClient }: InboxQueueProps): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const waiting = useInboxList(enabled, 'requests', client)
  const fresh = useInboxList(enabled, 'unread', client)

  // Archiving holds for the undo window, as the list does; either read may hold the row.
  const archiveOf = useCallback(
    (itemId: string) => (waiting.items.some((item) => item.id === itemId) ? waiting.archive(itemId) : fresh.archive(itemId)),
    [waiting, fresh],
  )
  const archiveLater = useUndoableArchive(archiveOf)

  const today = localCalendarDay()
  const groups = useMemo(
    () => waitingGroups(waiting.items.filter((item) => !archiveLater.pendingIds.has(item.id)), today),
    [waiting.items, archiveLater.pendingIds, today],
  )
  const news = useMemo(() => newsOf(fresh.items).filter((item) => !archiveLater.pendingIds.has(item.id)), [fresh.items, archiveLater.pendingIds])
  const order = useMemo(() => queueOrder(groups, news), [groups, news])

  const pathname = usePathname() ?? ''
  const searchParams = useSearchParams()
  const here = `${pathname}${searchParams?.toString() ? `?${searchParams.toString()}` : ''}`
  const hrefOf = useCallback(
    (item: InboxItemView) => (item.href && returnHere && isMarkAnchored(item.type) ? withReviewBack(item.href, here) : item.href),
    [returnHere, here],
  )
  // The entry whose place the reader is at: drawn as current, whoever took them there.
  const currentId = order.find((item) => item.href !== null && isAtHref(item.href, pathname, searchParams))?.id ?? null

  const ownerOf = useCallback((item: InboxItemView) => (isOpenRequest(item) ? waiting : fresh), [waiting, fresh])
  const markRead = useCallback(
    (item: InboxItemView) => {
      if (!item.read) void ownerOf(item).markRead([item.id])
    },
    [ownerOf],
  )

  const archive = useCallback(
    (itemId: string) => {
      archiveLater.request(itemId)
      toast(t('inbox.archived'), {
        duration: ARCHIVE_UNDO_MS,
        action: { label: t('inbox.undo'), onClick: () => archiveLater.undo(itemId) },
      })
    },
    [archiveLater, t],
  )

  // ---- Keys: the entries are links, so moving is moving focus, and Enter is the link's ----
  const rootRef = useRef<HTMLDivElement>(null)
  const onKey = useCallback(
    (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typingInto(event.target)) return
      if (!QUEUE_KEYS.has(event.key) || order.length === 0) return
      const links = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-testid="inbox-queue-entry"]') ?? [])]
      const at = links.findIndex((link) => link === document.activeElement)
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault()
        const step = event.key === 'j' ? 1 : -1
        const next = links[at < 0 ? (step > 0 ? 0 : links.length - 1) : Math.min(links.length - 1, Math.max(0, at + step))]
        next?.focus()
        next?.scrollIntoView?.({ block: 'nearest' })
        return
      }
      const item = at < 0 ? null : (order.find((entry) => entry.id === links[at].getAttribute('data-item-id')) ?? null)
      if (!item) return
      event.preventDefault()
      if (event.key === 'e') {
        // The keyboard stays in the list: the next entry takes the focus.
        ;(links[at + 1] ?? links[at - 1])?.focus()
        archive(item.id)
        return
      }
      void (!item.read ? ownerOf(item).markRead([item.id]) : ownerOf(item).markUnread([item.id]))
    },
    [order, archive, ownerOf],
  )

  // On a page or in a sheet, the keys are the list's wherever focus is not in a
  // field. Kept to itself, they are the list's while focus is anywhere in the
  // container that declares the scope (`data-queue-keys`, the dock), so a click
  // on the dock's own background is enough; without one, the list itself.
  useEffect(() => {
    const listen = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root) return
      if (keyScope === 'self') {
        const scope = root.closest('[data-queue-keys]') ?? root
        if (event.target instanceof Node && scope.contains(event.target)) onKey(event)
        return
      }
      const scope = root.closest('[role="dialog"]') ?? document.body
      if (event.target instanceof Node && event.target !== document.body && !scope.contains(event.target)) return
      onKey(event)
    }
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [keyScope, onKey])

  const loading = waiting.loading || fresh.loading
  const late = groups.flatMap((group) => group.items).filter((item) => item.variant === 'overdue').length
  const waitingCount = groups.reduce((sum, group) => sum + group.items.length, 0)

  // Either read failing means the queue cannot say it is done: half a queue
  // under „Alles erledigt“ is the one answer that must never be wrong.
  if ((waiting.error || fresh.error) && order.length === 0) {
    return <LoadError title={t('inbox.errors.loadFailed')} onRetry={() => (waiting.refresh(), fresh.refresh())} />
  }
  // Nothing waits and nothing is new: the queue is done, and says so.
  if (!loading && order.length === 0 && !waiting.hasMore && !fresh.hasMore) {
    return (
      <div ref={rootRef} data-testid="inbox-queue">
        <QueueDone />
      </div>
    )
  }

  return (
    <div ref={rootRef} className="space-y-3" data-testid="inbox-queue">
      {(waiting.mutationError || fresh.mutationError) && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle className="line-clamp-none">{t('inbox.errors.actionFailed')}</AlertTitle>
          <Button variant="outline" size="sm" className="mt-2 w-fit" onClick={() => (waiting.dismissMutationError(), fresh.dismissMutationError())}>
            {t('sharing.errors.dismiss')}
          </Button>
        </Alert>
      )}

      {loading ? (
        // The shape of what is coming: a heading, then rows of a title and its
        // line, so the list lands where the skeleton stood instead of reflowing.
        <div className="space-y-4 px-2" aria-busy="true" data-testid="inbox-queue-skeleton">
          <Skeleton className="h-3 w-28" />
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-1.5">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : (
        // Lands where the skeleton stood, settling the last few pixels instead of snapping in.
        <FadeIn distance={4}>
          <InboxQueueList
            groups={groups}
            news={news}
            waitingCount={waitingCount}
            lateCount={late}
            currentId={currentId}
            hrefOf={hrefOf}
            onFollow={(event, item) => {
              // Following an entry is reading it; a background tab is not.
              if (isPlainClick(event)) markRead(item)
            }}
            onArchive={archive}
            onNewsRead={news.length > 0 ? () => void fresh.markAllRead() : undefined}
            waitingMore={
              <LoadMore
                hasMore={waiting.hasMore}
                loading={waiting.loadingMore}
                failed={waiting.loadMoreFailed}
                onLoadMore={waiting.loadMore}
                loadMoreLabel={t('inbox.loadMore')}
                loadingLabel={t('inbox.loadingMore')}
                failedLabel={t('inbox.loadMoreFailed')}
              />
            }
            newsMore={
              <LoadMore
                hasMore={fresh.hasMore}
                loading={fresh.loadingMore}
                failed={fresh.loadMoreFailed}
                onLoadMore={fresh.loadMore}
                loadMoreLabel={t('inbox.loadMore')}
                loadingLabel={t('inbox.loadingMore')}
                failedLabel={t('inbox.loadMoreFailed')}
              />
            }
          />
        </FadeIn>
      )}
    </div>
  )
}

/**
 * The queue worked to the end. Not an empty box: a quiet mark of having
 * finished, the one moment in the queue that earns a small spring.
 */
function QueueDone(): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const settle = useMotionToken(springSnap)
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center" data-testid="inbox-queue-done">
      <motion.span
        aria-hidden
        className="mb-1 flex size-10 items-center justify-center rounded-full bg-success-subtle text-success"
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={settle}
      >
        <Check className="size-5" strokeWidth={2.25} />
      </motion.span>
      <p className="text-sm font-medium text-foreground">{t('inbox.empty.needsMeTitle')}</p>
      <p className="max-w-[30ch] text-sm text-muted-foreground">{t('inbox.empty.needsMeDescription')}</p>
    </div>
  )
}
