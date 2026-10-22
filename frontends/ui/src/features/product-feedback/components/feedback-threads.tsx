'use client'

/**
 * „Mein Feedback" — the reporter's side of every report they sent: their cases,
 * active ones first, each with where it stands, and the conversation on one of
 * them with the Piloti team. An office admin (`org:settings:manage`) also gets
 * „Unser Büro": every case anyone in the organization filed, each thread
 * read-only, because only the reporter's own conversations session can answer.
 *
 * The team answers in PostHog Support; the BFF reads the ticket and hands the
 * thread over (`GET /api/feedback/reports/[id]/messages`), and the reporter's
 * answer goes back onto the ticket (ADR-0118, amended). No PostHog widget is
 * involved: this sheet is the whole conversation surface. While it shows a
 * thread it re-reads it every {@link THREAD_POLL_MS}, so a reply sent while the
 * reporter is looking arrives without a reload.
 *
 * The thread is a two-party chat built from the chat's parts: `UserMessage`
 * with an author for each side (the team on the left), and the thread reply box
 * (`Composer`): Enter sends, the phone's action key says so, Send keeps the
 * keyboard up. On a phone the sheet follows the visual viewport
 * (`useFitToVisualViewport`), so the box sits on the keyboard instead of under it.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { ArrowLeft, ChevronRight, MessagesSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { LoadError } from '@/components/ui/load-error'
import { LoadMore } from '@/components/ui/load-more'
import { isCoarsePointer } from '@/components/ui/overlay-focus'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SectionLabel } from '@/components/ui/section-label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TimeAgo } from '@/components/ui/time-ago'
import { UserMessage } from '@/features/chat/components/UserMessage'
import { Composer } from '@/features/documents/components/review/composer'
import { useFitToVisualViewport } from '@/hooks/use-visual-viewport'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  fetchOfficeFeedback,
  fetchOwnFeedback,
  fetchOwnFeedbackThread,
  replyToOwnFeedback,
  type ReplyToFeedbackResult,
} from '@/lib/product-feedback/client'
import {
  isActiveFeedbackCase,
  PRODUCT_FEEDBACK_MESSAGE_MAX,
  type OwnProductFeedbackListResponse,
  type OwnProductFeedbackMessage,
  type OwnProductFeedbackSummary,
  type OwnProductFeedbackThread,
} from '@/lib/product-feedback/types'
import { FeedbackCaseStatus, feedbackCaseState } from './feedback-atoms'
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

/** The calls the sheet makes; previews and specs inject their own. */
export interface FeedbackThreadsApi {
  /** One page of the member's own reports; `cursor` is the previous page's `nextCursor`. */
  list: (cursor?: string) => Promise<OwnProductFeedbackListResponse>
  /** One page of the office's reports (office admins only). */
  office: (cursor?: string) => Promise<OwnProductFeedbackListResponse>
  thread: (id: string) => Promise<OwnProductFeedbackThread>
  reply: (id: string, message: string) => Promise<ReplyToFeedbackResult>
}

const LIVE_API: FeedbackThreadsApi = {
  list: fetchOwnFeedback,
  office: fetchOfficeFeedback,
  thread: fetchOwnFeedbackThread,
  reply: replyToOwnFeedback,
}

/** Whose cases the list shows. */
export type FeedbackScope = 'mine' | 'office'

export interface FeedbackThreadsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A thread to open straight away (after sending, from a link); the list otherwise. */
  initialReportId?: string | null
  /** Whose cases the list opens on; one's own unless asked. */
  initialScope?: FeedbackScope
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
  initialScope = 'mine',
  onNewFeedback,
  onUpdatedCount,
  api = LIVE_API,
}: FeedbackThreadsSheetProps): JSX.Element {
  const t = useTranslations('feedback')
  const [selected, setSelected] = React.useState<string | null>(initialReportId)
  const [scope, setScope] = React.useState<FeedbackScope>(initialScope)
  // Learned from the first page of one's own: the server decides, the switch follows.
  const [canViewOffice, setCanViewOffice] = React.useState(false)
  const [panel, setPanel] = React.useState<HTMLDivElement | null>(null)
  useFitToVisualViewport(open ? panel : null)

  // Every opening starts where the caller asked: a named thread or a list.
  React.useEffect(() => {
    if (!open) return
    setSelected(initialReportId)
    setScope(initialScope)
  }, [open, initialReportId, initialScope])

  const office = scope === 'office'
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={setPanel}
        side="right"
        className="flex flex-col gap-0 p-0 pr-[env(safe-area-inset-right)] sm:max-w-lg"
        data-testid="feedback-threads"
      >
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
            <SheetHeader className="gap-3 border-b px-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-4">
              <div className="flex flex-col gap-1.5 pr-8">
                <SheetTitle>{office ? t('threads.officeTitle') : t('threads.title')}</SheetTitle>
                <SheetDescription>{office ? t('threads.officeDescription') : t('threads.description')}</SheetDescription>
              </div>
              {canViewOffice && (
                <Tabs value={scope} onValueChange={(next) => setScope(next as FeedbackScope)}>
                  <TabsList className="w-full" aria-label={t('threads.scopeLabel')}>
                    <TabsTrigger value="mine" data-testid="feedback-scope-mine">
                      {t('threads.scope.mine')}
                    </TabsTrigger>
                    <TabsTrigger value="office" data-testid="feedback-scope-office">
                      {t('threads.scope.office')}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            </SheetHeader>
            {open && (
              <CaseList
                key={scope}
                scope={scope}
                api={api}
                onSelect={setSelected}
                onNewFeedback={onNewFeedback}
                onUpdatedCount={office ? undefined : onUpdatedCount}
                onCanViewOffice={setCanViewOffice}
              />
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ── The list ─────────────────────────────────────────────────────────────────

/** Most recent activity first, within a group. */
const byActivity = (a: OwnProductFeedbackSummary, b: OwnProductFeedbackSummary): number =>
  b.lastActivityAt.localeCompare(a.lastActivityAt)

function CaseList({
  scope,
  api,
  onSelect,
  onNewFeedback,
  onUpdatedCount,
  onCanViewOffice,
}: {
  scope: FeedbackScope
  api: FeedbackThreadsApi
  onSelect: (id: string) => void
  onNewFeedback?: () => void
  onUpdatedCount?: (count: number) => void
  onCanViewOffice?: (can: boolean) => void
}): JSX.Element {
  const t = useTranslations('feedback')
  const [load, setLoad] = React.useState<Load<OwnProductFeedbackListResponse>>({ kind: 'loading' })
  const [more, setMore] = React.useState<{ loading: boolean; failed: boolean }>({ loading: false, failed: false })
  const office = scope === 'office'
  const read = office ? api.office : api.list

  const reload = React.useCallback(async () => {
    setLoad({ kind: 'loading' })
    try {
      const value = await read()
      setLoad({ kind: 'ready', value })
      // The first page holds the newest reports, and with them every recent reply.
      onUpdatedCount?.(value.updatedCount)
      onCanViewOffice?.(value.canViewOffice)
    } catch {
      setLoad({ kind: 'error' })
    }
  }, [read, onUpdatedCount, onCanViewOffice])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const loadMore = async (): Promise<void> => {
    if (load.kind !== 'ready' || !load.value.nextCursor || more.loading) return
    setMore({ loading: true, failed: false })
    try {
      const page = await read(load.value.nextCursor)
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
        <LoadError title={office ? t('threads.officeLoadError') : t('threads.loadError')} onRetry={reload} />
      </div>
    )
  }
  if (load.value.reports.length === 0) {
    return (
      // The padding is the wrapper's: `EmptyState` is `w-full`, and a margin
      // on it pushed the card 48px past a phone's right edge.
      <div className="p-6">
        <EmptyState
          icon={MessagesSquare}
          title={office ? t('threads.officeEmpty.title') : t('threads.empty.title')}
          description={office ? t('threads.officeEmpty.description') : t('threads.empty.description')}
          action={onNewFeedback && !office ? <Button onClick={onNewFeedback}>{t('threads.send')}</Button> : undefined}
        />
      </div>
    )
  }
  const active = load.value.reports.filter((report) => isActiveFeedbackCase(report.status)).sort(byActivity)
  const done = load.value.reports.filter((report) => !isActiveFeedbackCase(report.status)).sort(byActivity)
  return (
    <ScrollArea className={cn('min-h-0 flex-1', FIT_VIEWPORT)}>
      <div className="flex flex-col gap-5 p-4">
        {active.length > 0 && (
          <CaseGroup label={t('threads.groups.active')} reports={active} scope={scope} onSelect={onSelect} testId="active" />
        )}
        {done.length > 0 && (
          <CaseGroup label={t('threads.groups.done')} reports={done} scope={scope} onSelect={onSelect} testId="done" />
        )}
        <LoadMore
          hasMore={load.value.nextCursor !== null}
          loading={more.loading}
          failed={more.failed}
          onLoadMore={() => void loadMore()}
          loadMoreLabel={t('threads.loadMore')}
          loadingLabel={t('threads.loadingMore')}
          failedLabel={t('threads.loadMoreFailed')}
        />
      </div>
    </ScrollArea>
  )
}

function CaseGroup({
  label,
  reports,
  scope,
  onSelect,
  testId,
}: {
  label: string
  reports: OwnProductFeedbackSummary[]
  scope: FeedbackScope
  onSelect: (id: string) => void
  testId: string
}): JSX.Element {
  const headingId = React.useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-testid={`feedback-group-${testId}`}>
      <div className="flex items-center gap-2 px-1">
        <SectionLabel as="h3" id={headingId}>
          {label}
        </SectionLabel>
        <CountPill count={reports.length} />
      </div>
      <ItemList as="ul">
        {reports.map((report) => (
          <CaseRow key={report.id} report={report} scope={scope} onSelect={() => onSelect(report.id)} />
        ))}
      </ItemList>
    </section>
  )
}

function CaseRow({
  report,
  scope,
  onSelect,
}: {
  report: OwnProductFeedbackSummary
  scope: FeedbackScope
  onSelect: () => void
}): JSX.Element {
  const t = useTranslations('feedback')
  const { locale } = useLocale()
  const Icon = FEEDBACK_KIND_ICONS[report.kind]
  return (
    <li>
      <Item asChild>
        <button type="button" onClick={onSelect} className="w-full" data-testid={`feedback-thread-${report.id}`}>
          <ItemMedia>
            <Icon className="text-muted-foreground size-4" aria-hidden />
          </ItemMedia>
          <ItemContent className="gap-1.5">
            {/* `truncate` is the atom's default; two lines of the report is what
                tells one bug from the next, so it wraps and clamps instead. */}
            <ItemTitle className="line-clamp-2 font-normal whitespace-normal">{report.excerpt}</ItemTitle>
            <ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <FeedbackCaseStatus state={feedbackCaseState(report.status)} mine={report.mine} />
              {scope === 'office' && <span className="text-foreground">{report.reporterName ?? t('threads.unknownReporter')}</span>}
              <span>{t(`kinds.${report.kind}.label`)}</span>
              {report.ticketNumber !== null && (
                <span className="tabular-nums">{t('threads.ticketNumber', { number: report.ticketNumber })}</span>
              )}
              <span>
                {t('threads.updated')} <TimeAgo date={report.lastActivityAt} locale={locale} />
              </span>
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

/** How many of the reporter's messages the server holds: the mark a sent reply is counted against. */
const reporterMessages = (thread: OwnProductFeedbackThread): number =>
  thread.messages.filter((message) => message.author === 'reporter').length

/**
 * A reply that went out but that PostHog does not list yet. Shown at the end of
 * the thread until the server holds more of the reporter's messages than it
 * did when it was sent, so a message never flickers out after Send.
 */
interface Echo {
  message: OwnProductFeedbackMessage
  /** The server's count of the reporter's messages when this was sent. */
  baseline: number
}

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
  const [echoes, setEchoes] = React.useState<Echo[]>([])

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
  const held = thread ? reporterMessages(thread) : 0
  const pending = echoes.filter((echo) => echo.baseline >= held).map((echo) => echo.message)
  const messages = thread ? [...thread.messages, ...pending] : []
  const teamSpokeLast = messages.at(-1)?.author === 'team'

  const reply = async (message: string): Promise<ReplyToFeedbackResult> => {
    const before = thread ? reporterMessages(thread) : 0
    const result = await api.reply(reportId, message)
    if (!result.ok) return result
    setLoad({ kind: 'ready', value: result.thread })
    if (reporterMessages(result.thread) <= before) {
      const echo: OwnProductFeedbackMessage = {
        id: `pending-${Date.now()}`,
        author: 'reporter',
        authorName: null,
        content: message,
        createdAt: new Date().toISOString(),
      }
      setEchoes((current) => [...current, { message: echo, baseline: before }])
    }
    return result
  }

  return (
    <>
      {/* One row, centred on the sheet's close button (32px from the top), so
          back, title and close read as one bar rather than three heights. */}
      <SheetHeader className="min-h-16 flex-row items-center gap-1.5 border-b pt-[max(0.75rem,env(safe-area-inset-top))] pr-14 pb-3 pl-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t('threads.back')} data-testid="feedback-thread-back">
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-col gap-1">
          <SheetTitle className="truncate text-base leading-tight">
            {thread ? (
              <>
                {t(`kinds.${thread.report.kind}.label`)}
                {thread.report.ticketNumber !== null && (
                  <span className="text-muted-foreground font-normal tabular-nums">
                    {' · '}
                    {t('threads.ticketNumber', { number: thread.report.ticketNumber })}
                  </span>
                )}
              </>
            ) : (
              t('threads.title')
            )}
          </SheetTitle>
          {/* Where the case stands and when it last moved; on a colleague's
              case, whose it is. Never the list's generic blurb. */}
          <SheetDescription asChild>
            <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {thread ? (
                <>
                  <FeedbackCaseStatus
                    state={feedbackCaseState(thread.live ? thread.report.status : null, thread.live && teamSpokeLast)}
                    mine={thread.report.mine}
                  />
                  {!thread.report.mine && thread.report.reporterName && <span>{thread.report.reporterName}</span>}
                  {/* Without a status the chip already says „Gesendet": the time alone follows it. */}
                  <span className="truncate">
                    {thread.report.status && <>{t('threads.updated')} </>}
                    <TimeAgo date={thread.report.status ? thread.report.lastActivityAt : thread.report.createdAt} locale={locale} />
                  </span>
                </>
              ) : (
                <span aria-hidden>&nbsp;</span>
              )}
            </div>
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
        <ThreadMessages thread={thread} messages={messages} onNewFeedback={onNewFeedback} onReply={reply} />
      )}
    </>
  )
}

/** What `Composer` throws when the reply did not go, so it keeps the text and says why. */
class ReplyNotSent extends Error {
  constructor(readonly reason: 'rate-limited' | 'failed') {
    super(reason)
  }
}

function ThreadMessages({
  thread,
  messages,
  onReply,
  onNewFeedback,
}: {
  thread: OwnProductFeedbackThread
  /** The thread's messages and any reply PostHog does not list yet. */
  messages: OwnProductFeedbackMessage[]
  onReply: (message: string) => Promise<ReplyToFeedbackResult>
  onNewFeedback?: () => void
}): JSX.Element {
  const t = useTranslations('feedback')
  const contentRef = React.useRef<HTMLDivElement>(null)
  const answered = messages.some((message) => message.author === 'team')
  const mine = thread.report.mine
  // A mouse or a keyboard came here to write: the box takes the focus. Under a
  // finger it waits for the tap, or the keyboard covers the thread at once.
  const [focusComposer] = React.useState(() => !isCoarsePointer())

  // The newest message is the one to read: keep the end of the thread in view
  // as messages arrive. The viewport itself, to its very bottom: an anchor
  // scrolled into view stopped short of the list's own padding.
  React.useLayoutEffect(() => {
    const viewport = contentRef.current?.closest<HTMLElement>('[data-radix-scroll-area-viewport]')
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [messages.length])

  // And when the pane gets shorter (the keyboard comes up, the box grows a
  // line) while the reader is at the end, the end stays in view: a resize keeps
  // `scrollTop`, so the newest message would slide under the composer.
  React.useEffect(() => {
    const viewport = contentRef.current?.closest<HTMLElement>('[data-radix-scroll-area-viewport]')
    if (!viewport || typeof ResizeObserver === 'undefined') return
    let atEnd = true
    let height = viewport.clientHeight
    const onScroll = (): void => {
      // Only the reader's own scrolling says where they are. The browser's
      // scroll anchoring also scrolls when the pane shrinks, before the
      // observer below hears of it, and that must not count as leaving the end.
      if (viewport.clientHeight !== height) return
      atEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24
    }
    const observer = new ResizeObserver(() => {
      height = viewport.clientHeight
      if (atEnd) viewport.scrollTop = viewport.scrollHeight
    })
    viewport.addEventListener('scroll', onScroll, { passive: true })
    // Both boxes: the pane shrinking, and the thread re-flowing inside it
    // (a narrower column once the scrollbar appears wraps every bubble anew).
    observer.observe(viewport)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [])

  const reporter = thread.report.reporterName ?? t('threads.unknownReporter')
  return (
    <>
      <ScrollArea className={cn('min-h-0 flex-1', FIT_VIEWPORT)}>
        <div ref={contentRef} className="flex flex-col gap-4 p-4" data-testid="feedback-thread-messages" data-chat-surface="feedback">
          {/* The chat's own attributed message: the header names who spoke
              (you, a colleague, or the team member). Unlike the Piloti chat
              this is a two-party conversation, so the team speaks from the left. */}
          {messages.map((message, index) => {
            const previous = messages[index - 1]
            const sameSpeaker = previous?.author === message.author && previous.authorName === message.authorName
            return (
              <UserMessage
                key={message.id}
                content={message.content}
                timestamp={message.createdAt}
                grouped={sameSpeaker}
                // Two parties, two sides: the reporter on the right as in any
                // messenger, the team on the left (UserMessage's `side`).
                side={message.author === 'team' ? 'start' : 'end'}
                author={
                  message.author === 'reporter'
                    ? mine
                      ? { isYou: true, userId: 'feedback-reporter' }
                      : { userId: 'feedback-reporter', name: reporter }
                    : {
                        userId: `piloti-team:${message.authorName ?? ''}`,
                        // „Matthias, Piloti-Team": the comma keeps the disc's
                        // initials on the person (MP), where „·" made them „M·".
                        name: message.authorName ? t('threads.teamMember', { name: message.authorName }) : t('threads.team'),
                      }
                }
              />
            )
          })}
          {!thread.live && <ThreadNote>{t('threads.notLive')}</ThreadNote>}
          {thread.live && !answered && <ThreadNote>{t('threads.waiting')}</ThreadNote>}
        </div>
      </ScrollArea>
      <div className="border-t px-4 pt-3 pb-[max(0.75rem,var(--overlay-inset-bottom,env(safe-area-inset-bottom)))]">
        {thread.report.canReply ? (
          <Composer
            testId="feedback-reply-input"
            placeholder={t('threads.replyPlaceholder')}
            submitLabel={t('threads.replySend')}
            maxLength={PRODUCT_FEEDBACK_MESSAGE_MAX}
            autoFocus={focusComposer}
            onSubmit={async (body) => {
              const result = await onReply(body.trim())
              if (!result.ok) throw new ReplyNotSent(result.reason)
            }}
            describeFailure={(error) =>
              error instanceof ReplyNotSent && error.reason === 'rate-limited'
                ? t('threads.replyRateLimited')
                : t('threads.replyError')
            }
          />
        ) : mine ? (
          <div className="flex flex-col items-start gap-3 px-2 py-1">
            <p className="text-muted-foreground text-sm text-pretty">{t('threads.cannotReply')}</p>
            {onNewFeedback && (
              <Button variant="outline" size="sm" onClick={onNewFeedback}>
                {t('threads.send')}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground px-2 py-1 text-sm text-pretty" data-testid="feedback-thread-readonly">
            {thread.report.reporterName
              ? t('threads.readOnly', { name: thread.report.reporterName })
              : t('threads.readOnlyUnnamed')}
          </p>
        )}
      </div>
    </>
  )
}

/** A line about the thread rather than in it: the waiting and offline notes. */
function ThreadNote({ children }: { children: string }): JSX.Element {
  return <p className="text-muted-foreground mx-auto max-w-xs py-2 text-center text-xs text-pretty">{children}</p>
}
