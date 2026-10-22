'use client'

/**
 * „Mein Feedback" — the reporter's side of every report they sent: the list of
 * their reports, and the conversation on one of them with the Piloti team.
 *
 * The team answers in PostHog Support; the BFF reads the ticket and hands the
 * thread over (`GET /api/feedback/reports/[id]/messages`), and the reporter's
 * answer goes back onto the ticket (ADR-0118, amended). No PostHog widget is
 * involved: this sheet is the whole conversation surface. While it shows a
 * thread it re-reads it every {@link THREAD_POLL_MS}, so a reply sent while the
 * reporter is looking arrives without a reload.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { ArrowLeft, ChevronRight, MessagesSquare, Send } from 'lucide-react'

import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { LoadError } from '@/components/ui/load-error'
import { LoadMore } from '@/components/ui/load-more'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { TimeAgo } from '@/components/ui/time-ago'
import { UserMessage } from '@/features/chat/components/UserMessage'
import { useLocale, useTranslations } from '@/i18n'
import {
  fetchOwnFeedback,
  fetchOwnFeedbackThread,
  replyToOwnFeedback,
  type ReplyToFeedbackResult,
} from '@/lib/product-feedback/client'
import {
  PRODUCT_FEEDBACK_MESSAGE_MAX,
  type OwnProductFeedbackListResponse,
  type OwnProductFeedbackSummary,
  type OwnProductFeedbackThread,
} from '@/lib/product-feedback/types'
import { FEEDBACK_KIND_ICONS } from './feedback-dialog'

/** How often an open thread is re-read for a reply that arrived meanwhile. */
export const THREAD_POLL_MS = 20_000

/** The three calls the sheet makes; previews and specs inject their own. */
export interface FeedbackThreadsApi {
  /** One page of the member's reports; `cursor` is the previous page's `nextCursor`. */
  list: (cursor?: string) => Promise<OwnProductFeedbackListResponse>
  thread: (id: string) => Promise<OwnProductFeedbackThread>
  reply: (id: string, message: string) => Promise<ReplyToFeedbackResult>
}

const LIVE_API: FeedbackThreadsApi = {
  list: fetchOwnFeedback,
  thread: fetchOwnFeedbackThread,
  reply: replyToOwnFeedback,
}

export interface FeedbackThreadsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A thread to open straight away (after sending, from a link); the list otherwise. */
  initialReportId?: string | null
  /** „Feedback senden" from the empty list. */
  onNewFeedback?: () => void
  /** Told whenever the sheet learns how many threads have news, so the shell's dot follows. */
  onUpdatedCount?: (count: number) => void
  api?: FeedbackThreadsApi
}

type Load<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; value: T }

export function FeedbackThreadsSheet({
  open,
  onOpenChange,
  initialReportId = null,
  onNewFeedback,
  onUpdatedCount,
  api = LIVE_API,
}: FeedbackThreadsSheetProps): JSX.Element {
  const t = useTranslations('feedback')
  const [selected, setSelected] = React.useState<string | null>(initialReportId)

  // Every opening starts where the caller asked: a named thread or the list.
  React.useEffect(() => {
    if (open) setSelected(initialReportId)
  }, [open, initialReportId])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-lg" data-testid="feedback-threads">
        {selected ? (
          <ThreadView
            key={selected}
            reportId={selected}
            api={api}
            onBack={() => setSelected(null)}
          />
        ) : (
          <>
            <SheetHeader className="border-b px-6 pt-6 pb-4">
              <SheetTitle>{t('threads.title')}</SheetTitle>
              <SheetDescription>{t('threads.description')}</SheetDescription>
            </SheetHeader>
            {open && (
              <ThreadList api={api} onSelect={setSelected} onNewFeedback={onNewFeedback} onUpdatedCount={onUpdatedCount} />
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ── The list ─────────────────────────────────────────────────────────────────

function ThreadList({
  api,
  onSelect,
  onNewFeedback,
  onUpdatedCount,
}: {
  api: FeedbackThreadsApi
  onSelect: (id: string) => void
  onNewFeedback?: () => void
  onUpdatedCount?: (count: number) => void
}): JSX.Element {
  const t = useTranslations('feedback')
  const [load, setLoad] = React.useState<Load<OwnProductFeedbackListResponse>>({ kind: 'loading' })
  const [more, setMore] = React.useState<{ loading: boolean; failed: boolean }>({ loading: false, failed: false })

  const reload = React.useCallback(async () => {
    setLoad({ kind: 'loading' })
    try {
      const value = await api.list()
      setLoad({ kind: 'ready', value })
      // The first page holds the newest reports, and with them every recent reply.
      onUpdatedCount?.(value.updatedCount)
    } catch {
      setLoad({ kind: 'error' })
    }
  }, [api, onUpdatedCount])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const loadMore = async (): Promise<void> => {
    if (load.kind !== 'ready' || !load.value.nextCursor || more.loading) return
    setMore({ loading: true, failed: false })
    try {
      const page = await api.list(load.value.nextCursor)
      setLoad({
        kind: 'ready',
        value: { ...page, reports: [...load.value.reports, ...page.reports], updatedCount: load.value.updatedCount },
      })
      setMore({ loading: false, failed: false })
    } catch {
      setMore({ loading: false, failed: true })
    }
  }

  if (load.kind === 'loading') {
    return (
      <div className="flex flex-col gap-3 p-6" aria-busy>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    )
  }
  if (load.kind === 'error') {
    return (
      <div className="p-6">
        <LoadError title={t('threads.loadError')} onRetry={reload} />
      </div>
    )
  }
  if (load.value.reports.length === 0) {
    return (
      <EmptyState
        className="m-6"
        icon={MessagesSquare}
        title={t('threads.empty.title')}
        description={t('threads.empty.description')}
        action={onNewFeedback ? <Button onClick={onNewFeedback}>{t('threads.send')}</Button> : undefined}
      />
    )
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ItemList as="ul" className="m-4">
        {load.value.reports.map((report) => (
          <ThreadRow key={report.id} report={report} onSelect={() => onSelect(report.id)} />
        ))}
      </ItemList>
      <LoadMore
        className="mx-4 mb-4"
        hasMore={load.value.nextCursor !== null}
        loading={more.loading}
        failed={more.failed}
        onLoadMore={() => void loadMore()}
        loadMoreLabel={t('threads.loadMore')}
        loadingLabel={t('threads.loadingMore')}
        failedLabel={t('threads.loadMoreFailed')}
      />
    </ScrollArea>
  )
}

function ThreadRow({ report, onSelect }: { report: OwnProductFeedbackSummary; onSelect: () => void }): JSX.Element {
  const t = useTranslations('feedback')
  const { locale } = useLocale()
  const Icon = FEEDBACK_KIND_ICONS[report.kind]
  return (
    <li>
      <Item asChild>
        <button
          type="button"
          onClick={onSelect}
          className="w-full"
          data-testid={`feedback-thread-${report.id}`}
        >
        <ItemMedia>
          <Icon className="text-muted-foreground size-4" aria-hidden />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="line-clamp-2 font-normal">{report.excerpt}</ItemTitle>
          <ItemDescription className="flex flex-wrap items-center gap-x-2">
            <span>{t(`kinds.${report.kind}.label`)}</span>
            <span aria-hidden>·</span>
            <TimeAgo date={report.createdAt} locale={locale} />
            {report.status && (
              <>
                <span aria-hidden>·</span>
                <span>{t(`threads.statuses.${report.status}`)}</span>
              </>
            )}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {report.hasUpdate && <CountPill tone="attention">{t('threads.hasUpdate')}</CountPill>}
          <ChevronRight className="text-muted-foreground size-4" aria-hidden />
        </ItemActions>
        </button>
      </Item>
    </li>
  )
}

// ── One thread ───────────────────────────────────────────────────────────────

function ThreadView({
  reportId,
  api,
  onBack,
}: {
  reportId: string
  api: FeedbackThreadsApi
  onBack: () => void
}): JSX.Element {
  const t = useTranslations('feedback')
  const [load, setLoad] = React.useState<Load<OwnProductFeedbackThread>>({ kind: 'loading' })

  const read = React.useCallback(
    async (quiet: boolean) => {
      if (!quiet) setLoad({ kind: 'loading' })
      try {
        setLoad({ kind: 'ready', value: await api.thread(reportId) })
      } catch {
        // A failed background re-read keeps what is on screen.
        if (!quiet) setLoad({ kind: 'error' })
      }
    },
    [api, reportId],
  )

  React.useEffect(() => {
    void read(false)
    const timer = window.setInterval(() => void read(true), THREAD_POLL_MS)
    return () => window.clearInterval(timer)
  }, [read])

  const thread = load.kind === 'ready' ? load.value : null
  return (
    <>
      <SheetHeader className="flex-row items-center gap-2 border-b px-4 pt-5 pb-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t('threads.back')} data-testid="feedback-thread-back">
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-col">
          <SheetTitle className="text-base">
            {thread ? t(`kinds.${thread.report.kind}.label`) : t('threads.title')}
          </SheetTitle>
          <SheetDescription>
            {thread?.report.status ? t(`threads.statuses.${thread.report.status}`) : t('threads.description')}
          </SheetDescription>
        </div>
      </SheetHeader>
      {load.kind === 'loading' && (
        <div className="flex flex-1 flex-col gap-3 p-6" aria-busy>
          <Skeleton className="h-16 w-3/4 self-end" />
          <Skeleton className="h-12 w-2/3" />
        </div>
      )}
      {load.kind === 'error' && (
        <div className="p-6">
          <LoadError title={t('threads.threadLoadError')} onRetry={() => read(false)} />
        </div>
      )}
      {thread && (
        <ThreadMessages
          thread={thread}
          onReply={async (message) => {
            const result = await api.reply(reportId, message)
            if (result.ok) setLoad({ kind: 'ready', value: result.thread })
            return result
          }}
        />
      )}
    </>
  )
}

function ThreadMessages({
  thread,
  onReply,
}: {
  thread: OwnProductFeedbackThread
  onReply: (message: string) => Promise<ReplyToFeedbackResult>
}): JSX.Element {
  const t = useTranslations('feedback')
  const endRef = React.useRef<HTMLDivElement>(null)
  const answered = thread.messages.some((message) => message.author === 'team')

  // The newest message is the one to read: keep it in view as messages arrive.
  React.useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [thread.messages.length])

  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4" data-testid="feedback-thread-messages" data-chat-surface="feedback">
          {/* The chat's own attributed message: the header names who spoke
              (you, or the team member), and every message keeps the chat's
              one column, as a shared thread does. */}
          {thread.messages.map((message, index) => {
            const previous = thread.messages[index - 1]
            const sameSpeaker =
              previous?.author === message.author && previous.authorName === message.authorName
            return (
              <UserMessage
                key={message.id}
                content={message.content}
                timestamp={message.createdAt}
                grouped={sameSpeaker}
                author={
                  message.author === 'me'
                    ? { isYou: true, userId: 'feedback-reporter' }
                    : {
                        userId: `piloti-team:${message.authorName ?? ''}`,
                        name: message.authorName ? `${message.authorName} · ${t('threads.team')}` : t('threads.team'),
                      }
                }
              />
            )
          })}
          {!thread.live && <p className="text-muted-foreground text-center text-xs">{t('threads.notLive')}</p>}
          {thread.live && !answered && <p className="text-muted-foreground text-center text-xs">{t('threads.waiting')}</p>}
          <div ref={endRef} />
        </div>
      </ScrollArea>
      {thread.report.canReply ? (
        <ReplyComposer onReply={onReply} />
      ) : (
        <p className="text-muted-foreground border-t px-6 py-4 text-sm">{t('threads.cannotReply')}</p>
      )}
    </>
  )
}

function ReplyComposer({ onReply }: { onReply: (message: string) => Promise<ReplyToFeedbackResult> }): JSX.Element {
  const t = useTranslations('feedback')
  const [draft, setDraft] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inputId = React.useId()

  async function send(): Promise<void> {
    const message = draft.trim()
    if (!message || sending) return
    setSending(true)
    setError(null)
    const result = await onReply(message)
    setSending(false)
    if (result.ok) {
      setDraft('')
      return
    }
    setError(result.reason === 'rate-limited' ? t('threads.replyRateLimited') : t('threads.replyError'))
  }

  return (
    <form
      className="flex flex-col gap-2 border-t p-4"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {t('threads.replyLabel')}
      </label>
      <div className="flex items-end gap-2">
        <Textarea
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line: the chat convention.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder={t('threads.replyPlaceholder')}
          maxLength={PRODUCT_FEEDBACK_MESSAGE_MAX}
          rows={2}
          className="max-h-40 min-h-11 flex-1 resize-none"
          data-testid="feedback-reply-input"
        />
        <BusyButton
          type="submit"
          busy={sending}
          busyLabel={t('threads.replySending')}
          icon={<Send className="size-4" aria-hidden />}
          disabled={draft.trim().length === 0}
          data-testid="feedback-reply-send"
        >
          {t('threads.replySend')}
        </BusyButton>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm font-medium">
          {error}
        </p>
      )}
    </form>
  )
}
