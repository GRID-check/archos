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
import { Kbd } from '@/components/ui/kbd'
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
import { cn } from '@/lib/utils'
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

/**
 * Radix's scroll viewport wraps its children in a `display: table` box that
 * grows to its widest child, so a clamped excerpt or a 400px bubble pushed the
 * list and the thread past the sheet's right edge (cut off on desktop, the
 * whole bubble overflowing a 390px phone). Block layout makes the content take
 * the sheet's width. The cause is in `components/ui/scroll-area.tsx`; until the
 * atom does this itself, every vertical-only caller needs it.
 */
const FIT_VIEWPORT = '[&>[data-radix-scroll-area-viewport]>div]:!block'

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
      <SheetContent side="right" className="flex flex-col gap-0 p-0 pr-[env(safe-area-inset-right)] sm:max-w-lg"
        data-testid="feedback-threads">
        {selected ? (
          <ThreadView
            key={selected}
            reportId={selected}
            api={api}
            onBack={() => setSelected(null)}
            onNewFeedback={onNewFeedback}
          />
        ) : (
          <>
            <SheetHeader className="border-b px-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-4">
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
    <ScrollArea className={cn('min-h-0 flex-1', FIT_VIEWPORT)}>
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
          {/* `truncate` is the atom's default; two lines of the report is what
              tells one bug from the next, so it wraps and clamps instead. */}
          <ItemTitle className="line-clamp-2 font-normal whitespace-normal">{report.excerpt}</ItemTitle>
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
  onNewFeedback,
}: {
  reportId: string
  api: FeedbackThreadsApi
  onBack: () => void
  onNewFeedback?: () => void
}): JSX.Element {
  const t = useTranslations('feedback')
  const { locale } = useLocale()
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
      {/* One row, centred on the sheet's close button (32px from the top), so
          back, title and close read as one bar rather than three heights. */}
      <SheetHeader className="min-h-16 flex-row items-center gap-1.5 border-b pt-[max(0.75rem,env(safe-area-inset-top))] pr-14 pb-3 pl-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t('threads.back')} data-testid="feedback-thread-back">
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-col gap-0.5">
          <SheetTitle className="text-base leading-tight">
            {thread ? t(`kinds.${thread.report.kind}.label`) : t('threads.title')}
          </SheetTitle>
          {/* Where the report stands; without a status (PostHog unreadable)
              at least when it went out, never the list's generic blurb. */}
          <SheetDescription className="truncate text-xs">
            {thread?.report.status ? (
              t(`threads.statuses.${thread.report.status}`)
            ) : thread ? (
              <>
                {t('threads.sent')} <TimeAgo date={thread.report.createdAt} locale={locale} />
              </>
            ) : (
              <span aria-hidden>&nbsp;</span>
            )}
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
          onNewFeedback={onNewFeedback}
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
  onNewFeedback,
}: {
  thread: OwnProductFeedbackThread
  onReply: (message: string) => Promise<ReplyToFeedbackResult>
  onNewFeedback?: () => void
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
      <ScrollArea className={cn('min-h-0 flex-1', FIT_VIEWPORT)}>
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
                        // „Matthias, Piloti-Team": the comma keeps the disc's
                        // initials on the person (MP), where „·" made them „M·".
                        name: message.authorName
                          ? t('threads.teamMember', { name: message.authorName })
                          : t('threads.team'),
                      }
                }
              />
            )
          })}
          {!thread.live && <ThreadNote>{t('threads.notLive')}</ThreadNote>}
          {thread.live && !answered && <ThreadNote>{t('threads.waiting')}</ThreadNote>}
          <div ref={endRef} />
        </div>
      </ScrollArea>
      {thread.report.canReply ? (
        <ReplyComposer onReply={onReply} />
      ) : (
        <div className="flex flex-col items-start gap-3 border-t px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <p className="text-muted-foreground text-sm text-pretty">{t('threads.cannotReply')}</p>
          {onNewFeedback && (
            <Button variant="outline" size="sm" onClick={onNewFeedback}>
              {t('threads.send')}
            </Button>
          )}
        </div>
      )}
    </>
  )
}

/** A line about the thread rather than in it: the waiting and offline notes. */
function ThreadNote({ children }: { children: string }): JSX.Element {
  return <p className="text-muted-foreground mx-auto max-w-xs py-2 text-center text-xs text-pretty">{children}</p>
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
      className="flex flex-col gap-2 border-t px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {t('threads.replyLabel')}
      </label>
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
        className="max-h-40 min-h-16 resize-none"
        data-testid="feedback-reply-input"
      />
      {/* The send sits under the field, as a comment box's does: the field
          keeps the sheet's full width on a phone, and the key hint says what
          Enter does before anybody finds out by accident. */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground flex items-center gap-1 text-xs pointer-coarse:invisible" aria-hidden>
          <Kbd>↵</Kbd> {t('threads.replyHint')}
        </p>
        <BusyButton
          type="submit"
          busy={sending}
          busyLabel={t('threads.replySending')}
          icon={<Send className="size-4" aria-hidden />}
          size="sm"
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
