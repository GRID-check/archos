'use client'

/**
 * „Für mich“ as a queue, with the selected entry beside it.
 *
 * Two reads, because they answer two questions: what waits on the reader (the
 * open requests, `requests`, every one of them however old) and what is new
 * (`unread`). Read as one page of „pending“, a request older than fifty news
 * rows fell behind „Ältere laden“, and the queue's first promise is that what
 * waits on you is on top.
 *
 * Where the detail fits beside the list (from `lg`), a plain click selects an
 * entry and shows it there; elsewhere the entry is the link it always was. The
 * detail is shown or not by CSS, and the click asks whether it is displayed,
 * so no breakpoint is written twice.
 *
 * Keys, while focus is not in a field: j/k move, Enter opens the target, e
 * archives, u toggles read, r goes to the answer box.
 */

import type { JSX, MouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { withReviewBack } from '@/features/documents/lib/open-review'
import { useInboxList } from '../hooks/use-inbox'
import { ARCHIVE_UNDO_MS, useUndoableArchive } from '../hooks/use-undoable-archive'
import type { InboxMarkClient } from '../hooks/use-mark-answer'
import { isOpenRequest, newsOf, queueOrder, waitingGroups } from '../lib/inbox-queue'
import { isPlainClick } from '../lib/plain-click'
import { InboxDetail, type ReadMark } from './InboxDetail'
import type { InboxReviewClient } from './InboxReviewDecision'
import { InboxQueueList } from './InboxQueueList'

export interface InboxQueueProps {
  enabled?: boolean
  viewerId?: string | null
  /** Injected by the specs and the preview. */
  client?: InboxClient
  markClient?: InboxMarkClient
  reviewClient?: InboxReviewClient
  readMark?: ReadMark
}

/** Whether a key press belongs to whatever has focus rather than to the queue. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.closest('input, textarea, select, [role="textbox"], [role="menu"], [role="listbox"]') !== null
}

export function InboxQueue({ enabled = true, viewerId = null, client = inboxClient, markClient, reviewClient, readMark }: InboxQueueProps): JSX.Element {
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

  // The entry beside the list. Held as the row itself, so it stays readable
  // after the list re-reads without it (read news leaves; an answer resolves).
  const [selected, setSelected] = useState<InboxItemView | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  // Whether the detail is on screen (CSS decides, from `lg`): only then does the
  // first entry stand selected before the reader picks one. A phone's list
  // marks nothing it is not showing.
  const [split, setSplit] = useState(false)
  const queueEmpty = order.length === 0
  useEffect(() => {
    const pane = detailRef.current
    if (!pane || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setSplit(Boolean(pane.offsetParent)))
    observer.observe(document.documentElement)
    setSplit(Boolean(pane.offsetParent))
    return () => observer.disconnect()
    // Re-armed when the pane mounts: an empty queue draws none.
  }, [queueEmpty])
  const current = selected ? (order.find((item) => item.id === selected.id) ?? selected) : split ? (order[0] ?? null) : null

  const pathname = usePathname()
  const searchParams = useSearchParams()
  const here = pathname ? `${pathname}${searchParams?.toString() ? `?${searchParams.toString()}` : ''}` : null
  const hrefOf = useCallback(
    (item: InboxItemView) => (item.href && isMarkAnchored(item.type) ? withReviewBack(item.href, here) : item.href),
    [here],
  )

  const markRead = useCallback(
    (item: InboxItemView) => {
      if (item.state !== 'unread') return
      void (isOpenRequest(item) ? waiting.markRead([item.id]) : fresh.markRead([item.id]))
    },
    [waiting, fresh],
  )

  const detailShown = (): boolean => Boolean(detailRef.current?.offsetParent)

  const select = useCallback(
    (item: InboxItemView, { focus = false }: { focus?: boolean } = {}) => {
      setSelected(item)
      if (detailShown()) markRead(item)
      if (focus) {
        const entry = document.querySelector<HTMLElement>(`[data-testid="inbox-queue-entry"][data-item-id="${CSS.escape(item.id)}"]`)
        entry?.focus({ preventScroll: true })
        entry?.scrollIntoView?.({ block: 'nearest' })
      }
    },
    [markRead],
  )

  const onEntryClick = (event: MouseEvent<HTMLAnchorElement>, item: InboxItemView): void => {
    if (!isPlainClick(event)) return
    if (detailShown()) {
      event.preventDefault()
      select(item)
      return
    }
    // The link goes to the target: opening it is reading it.
    markRead(item)
  }

  const archive = useCallback(
    (itemId: string) => {
      const index = order.findIndex((item) => item.id === itemId)
      const next = order[index + 1] ?? order[index - 1] ?? null
      archiveLater.request(itemId)
      setSelected(next)
      toast(t('inbox.archived'), {
        duration: ARCHIVE_UNDO_MS,
        action: { label: t('inbox.undo'), onClick: () => archiveLater.undo(itemId) },
      })
    },
    [order, archiveLater, t],
  )

  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typingInto(event.target)) return
      const scope = root.closest('[role="dialog"]') ?? document.body
      if (event.target instanceof Node && event.target !== document.body && !scope.contains(event.target)) return
      if (!['j', 'k', 'Enter', 'e', 'u', 'r'].includes(event.key) || order.length === 0) return
      const index = current ? order.findIndex((item) => item.id === current.id) : -1
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault()
        const step = event.key === 'j' ? 1 : -1
        const next = order[Math.min(order.length - 1, Math.max(0, index < 0 ? 0 : index + step))]
        select(next, { focus: true })
        return
      }
      if (!current) return
      // Enter on a focused control is that control's.
      if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.closest('button, a') && !event.target.closest('[data-testid="inbox-queue-entry"]')) return
      event.preventDefault()
      if (event.key === 'Enter') {
        root.querySelector<HTMLAnchorElement>('[data-testid="inbox-detail-open"]')?.click()
        return
      }
      if (event.key === 'e') archive(current.id)
      if (event.key === 'u') {
        const owner = isOpenRequest(current) ? waiting : fresh
        void (current.state === 'unread' ? owner.markRead([current.id]) : owner.markUnread([current.id]))
      }
      if (event.key === 'r') root.querySelector<HTMLElement>('[data-testid="inbox-detail-composer"] [contenteditable], [data-testid="inbox-detail-composer"] textarea')?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [order, current, select, archive, waiting, fresh])

  const loading = waiting.loading || fresh.loading
  const failed = waiting.error && fresh.error
  const late = groups.flatMap((group) => group.items).filter((item) => item.variant === 'overdue').length
  const waitingCount = groups.reduce((sum, group) => sum + group.items.length, 0)

  if (failed) {
    return <LoadError title={t('inbox.errors.loadFailed')} onRetry={() => (waiting.refresh(), fresh.refresh())} />
  }
  // Nothing waits and nothing is new: the queue is done, and says so instead of drawing two empty panes.
  if (!loading && order.length === 0 && !waiting.hasMore && !fresh.hasMore) {
    return (
      <div ref={rootRef} data-testid="inbox-queue">
        <EmptyState icon={CheckCircle2} title={t('inbox.empty.needsMeTitle')} description={t('inbox.empty.needsMeDescription')} />
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

      {!loading && waitingCount > 0 && (
        <p className="px-1 text-sm text-muted-foreground" data-testid="inbox-queue-summary">
          {t('inbox.queue.summary', { count: waitingCount })}
          {late > 0 && `, ${t('inbox.queue.late', { count: late })}`}
        </p>
      )}

      <div className="lg:grid lg:h-[min(calc(100dvh-13rem),60rem)] lg:min-h-[28rem] lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:overflow-hidden lg:rounded-surface lg:border">
        <div className="lg:overflow-y-auto lg:p-3">
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
              shownId={current?.id ?? null}
              hrefOf={hrefOf}
              onEntryClick={onEntryClick}
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

        {/* Shown from `lg` only: below it, an entry is its link. */}
        <div ref={detailRef} className="hidden min-h-0 border-l bg-card lg:block">
          {current ? (
            <InboxDetail
              key={current.id}
              item={current}
              viewerId={viewerId}
              onOpen={markRead}
              onArchive={archive}
              markClient={markClient}
              reviewClient={reviewClient}
              readMark={readMark}
            />
          ) : (
            !loading && <p className="p-6 text-sm text-muted-foreground">{t('inbox.detail.empty')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
