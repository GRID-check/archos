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

import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

import { useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { localCalendarDay } from '@/lib/format'
import { inboxClient, type InboxClient } from '@/lib/inbox/client'
import { isMarkAnchored, type InboxItemView } from '@/lib/inbox/types'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
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
      if (item.state === 'unread') void ownerOf(item).markRead([item.id])
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
    (event: KeyboardEvent | ReactKeyboardEvent): void => {
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
      void (item.state === 'unread' ? ownerOf(item).markRead([item.id]) : ownerOf(item).markUnread([item.id]))
    },
    [order, archive, ownerOf],
  )

  // On a page or in a sheet, the keys are the list's wherever focus is not in a field.
  useEffect(() => {
    if (keyScope !== 'page') return
    const listen = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root) return
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

  if (waiting.error && fresh.error) {
    return <LoadError title={t('inbox.errors.loadFailed')} onRetry={() => (waiting.refresh(), fresh.refresh())} />
  }
  // Nothing waits and nothing is new: the queue is done, and says so.
  if (!loading && order.length === 0 && !waiting.hasMore && !fresh.hasMore) {
    return (
      <div ref={rootRef} data-testid="inbox-queue">
        <EmptyState icon={CheckCircle2} title={t('inbox.empty.needsMeTitle')} description={t('inbox.empty.needsMeDescription')} />
      </div>
    )
  }

  return (
    <div ref={rootRef} className="space-y-3" data-testid="inbox-queue" onKeyDown={keyScope === 'self' ? onKey : undefined}>
      {(waiting.mutationError || fresh.mutationError) && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle className="line-clamp-none">{t('inbox.errors.actionFailed')}</AlertTitle>
          <Button variant="outline" size="sm" className="mt-2 w-fit" onClick={() => (waiting.dismissMutationError(), fresh.dismissMutationError())}>
            {t('sharing.errors.dismiss')}
          </Button>
        </Alert>
      )}

      {!loading && waitingCount > 0 && (
        <p className="px-1 text-sm text-muted-foreground" data-testid="inbox-queue-summary">
          {t('inbox.queue.summary', { count: waitingCount })}
          {late > 0 && `, ${t('inbox.queue.late', { count: late })}`}
        </p>
      )}

      {loading ? (
        <div className="space-y-2" aria-busy="true" data-testid="inbox-queue-skeleton">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-20 w-full rounded-surface" />
          ))}
        </div>
      ) : (
        <InboxQueueList
          groups={groups}
          news={news}
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
      )}
    </div>
  )
}
