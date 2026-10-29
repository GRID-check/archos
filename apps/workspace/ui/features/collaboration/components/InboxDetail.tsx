'use client'

/**
 * The selected Postfach entry, beside the list: read it and act on it without
 * leaving the inbox.
 *
 * A request on a mark shows the mark's thread, read with the annotations' own
 * client (`getAnnotation`), and is answered or resolved here through
 * `useMarkAnswer`, the same writes its row and the thread make. Anything else
 * shows what its row says, at full length, with the move it leads to: the
 * review's decision, the comparison of two Fassungen, or opening its target.
 * The way into the full document stays one click away, and comes back here.
 *
 * It holds the entry it was given even when the list re-reads without it (a
 * news row read here leaves „Für mich“; a request answered here is resolved),
 * so the reader sees the outcome of what they just did.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Archive, ArrowUpRight, Check, Layers } from 'lucide-react'

import { namespaceRoot, useLocale, useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { filesCopy } from '@/i18n/namespaces/files'
import { PRODUCT_NAME } from '@/lib/brand'
import { getAnnotation } from '@/lib/annotations/client'
import type { AnnotationView, MarkMention } from '@/lib/annotations/types'
import { inboxItemCopy } from '@/lib/inbox/item-copy'
import { isMarkAnchored, type InboxItemView } from '@/lib/inbox/types'
import { AgentGlyph } from '@/components/ui/agent-glyph'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TimeAgo } from '@/components/ui/time-ago'
import { cn } from '@/lib/utils'
import { documentLifecycleClient } from '@/lib/documents/lifecycle-client'
import { Composer } from '@/features/documents/components/review/composer'
import { compareRevisionHref } from '@/features/documents/lib/revision-compare-link'
import { withReviewBack } from '@/features/documents/lib/open-review'
import { MARK_CLIENT, useMarkAnswer, type InboxMarkClient } from '../hooks/use-mark-answer'
import { isPlainClick } from '../lib/plain-click'
import { inboxDue } from '../lib/inbox-due'
import { inboxReason } from '../lib/inbox-reason'
import { InboxReviewDecision, type InboxReviewClient } from './InboxReviewDecision'
import { MentionText } from './MentionText'

/** Reads one mark with its thread. Injected by the specs and the preview. */
export type ReadMark = (documentId: string, annotationId: string) => Promise<AnnotationView>

export interface InboxDetailProps {
  item: InboxItemView
  viewerId?: string | null
  /** Opening, answering or acting on it counts as having read it. */
  onOpen?: (item: InboxItemView) => void
  onArchive?: (itemId: string) => void
  markClient?: InboxMarkClient
  reviewClient?: InboxReviewClient
  readMark?: ReadMark
}

export function InboxDetail({
  item,
  viewerId = null,
  onOpen,
  onArchive,
  markClient = MARK_CLIENT,
  reviewClient = documentLifecycleClient,
  readMark = getAnnotation,
}: InboxDetailProps): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const tFiles = useTranslations(filesCopy)
  const { locale } = useLocale()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const inert = item.state === 'inert'
  const { title, body } = inboxItemCopy(item, t, namespaceRoot(collaborationCopy, locale), locale)
  const markRow = isMarkAnchored(item.type) && !inert && item.href !== null && item.resourceType === 'document' && item.anchorId !== null
  const query = searchParams?.toString()
  const here = pathname ? `${pathname}${query ? `?${query}` : ''}` : null
  const openHref = markRow && item.href ? withReviewBack(item.href, here) : item.href
  const compareHref =
    item.type === 'document.new_revision' && !inert && item.related !== null && item.anchorId !== null && item.anchorId !== item.resourceId
      ? compareRevisionHref(item.href, item.anchorId)
      : null
  const canDecideReview =
    item.type === 'document.review_requested' && item.actionable && item.state !== 'resolved' && !inert && item.anchorId !== null && item.subject !== null

  const answer = useMarkAnswer({ item, markRow, markClient, onOpen })
  const thread = useMarkThread(markRow ? item : null, readMark)
  const due = inboxDue(item, t, locale)
  const reason = inboxReason(item, t)

  // A reply lands in the thread: read it again, so the answer shows where it went.
  const sendReply = async (text: string, send: Parameters<typeof answer.sendReply>[1]): Promise<readonly MarkMention[] | void> => {
    const kept = await answer.sendReply(text, send)
    thread.reload()
    return kept
  }

  const crumbs = [item.projectName, item.subject, markRow && item.related ? t('inbox.reason.mark', { number: item.related }) : null].filter(
    (crumb): crumb is string => Boolean(crumb),
  )

  return (
    <article className="flex h-full min-h-0 flex-col" aria-labelledby={`inbox-detail-${item.id}`} data-testid="inbox-detail">
      <div className="flex items-center gap-1 border-b px-6 py-2.5">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="inbox-detail-crumbs">
          {crumbs.join(' › ')}
        </p>
        {openHref && !inert && (
          <Button asChild variant="ghost" size="sm">
            <Link
              href={openHref}
              onClick={(event) => {
                if (isPlainClick(event)) onOpen?.(item)
              }}
              data-testid="inbox-detail-open"
            >
              {t(item.resourceType === 'document' ? 'inbox.detail.openDocument' : 'inbox.detail.open')}
              <ArrowUpRight aria-hidden />
            </Link>
          </Button>
        )}
        {onArchive && !item.archived && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label={t('inbox.archive')}
            title={t('inbox.archive')}
            onClick={() => onArchive(item.id)}
          >
            <Archive aria-hidden />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        <header className="space-y-1.5">
          {/* A mark's own words are what it is about; anything else is its sentence. */}
          <h2 id={`inbox-detail-${item.id}`} className="text-lg font-semibold tracking-tight">
            {markRow && item.excerpt ? item.excerpt : title}
          </h2>
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            <span>{markRow && reason ? reason : <TimeAgo date={item.updatedAt} locale={locale} />}</span>
            {due && (
              <>
                <span aria-hidden>·</span>
                <span
                  className={cn(due.variant === 'danger' && 'font-medium text-error', due.variant === 'warning' && 'font-medium text-warning')}
                  data-testid="inbox-detail-due"
                >
                  {due.label}
                </span>
              </>
            )}
          </p>
        </header>

        {!markRow && (body || item.excerpt) && (
          <div className="space-y-3 text-sm leading-relaxed">
            {body && <p className="text-muted-foreground">{body}</p>}
            {item.excerpt && (
              <p className="whitespace-pre-line">
                <MentionText content={item.excerpt} mentions={item.mentions} currentUserId={viewerId} />
              </p>
            )}
          </div>
        )}

        {canDecideReview && <InboxReviewDecision item={item} reviewClient={reviewClient} onOpen={onOpen} />}

        {compareHref && (
          <Button asChild variant="outline" size="sm">
            <Link href={compareHref} onClick={() => onOpen?.(item)} data-testid="inbox-detail-compare">
              <Layers aria-hidden />
              {t('inbox.compareRevisions')}
            </Link>
          </Button>
        )}

        {markRow && <MarkThread thread={thread} viewerId={viewerId} />}
      </div>

      {answer.answerHere && (
        <footer className="space-y-2 border-t px-6 py-4" data-testid="inbox-detail-composer">
          {answer.markOutcome !== 'resolved' && (
            <Composer
              key={item.id}
              testId="inbox-detail-reply"
              placeholder={item.related ? t('inbox.mark.replyLabel', { related: item.related }) : t('inbox.mark.replyLabelNoNumber')}
              submitLabel={t('inbox.mark.send')}
              documentId={item.resourceId}
              mentionAgent={item.pilotiWakes === true}
              describeFailure={() => t('inbox.mark.failed')}
              onSubmit={sendReply}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {answer.markOutcome && (
              <p
                role={answer.markOutcome === 'failed' || answer.markOutcome === 'conflict' ? 'alert' : 'status'}
                className={cn(
                  'min-w-0 flex-1 text-xs',
                  answer.markOutcome === 'failed' || answer.markOutcome === 'conflict' ? 'text-error' : 'text-muted-foreground',
                )}
                data-testid="inbox-detail-outcome"
              >
                {t(`inbox.mark.${answer.markOutcome}`)}
                {answer.untold.length > 0 &&
                  ` ${answer.untold.length === 1 ? tFiles('review.mentions.untoldOne', { name: answer.untold[0] }) : tFiles('review.mentions.untoldMany', { names: answer.untold.join(', ') })}`}
              </p>
            )}
            {answer.offerUndo && (
              <Button type="button" variant="inline" onClick={answer.undoResolve} data-testid="inbox-detail-undo">
                {t('inbox.undo')}
              </Button>
            )}
            {answer.canResolveMark && answer.markOutcome !== 'resolved' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={answer.markBusy}
                onClick={answer.resolveMark}
                data-testid="inbox-detail-resolve"
              >
                <Check aria-hidden />
                {t('inbox.mark.resolve')}
              </Button>
            )}
          </div>
        </footer>
      )}

      {answer.answerInReview && openHref && (
        <footer className="border-t px-6 py-4">
          <Button asChild size="sm">
            <Link href={openHref} onClick={() => onOpen?.(item)} data-testid="inbox-detail-answer-in-review">
              {t('inbox.mark.answerInReview')}
              <ArrowUpRight aria-hidden />
            </Link>
          </Button>
        </footer>
      )}
    </article>
  )
}

type MarkThreadState =
  | { status: 'idle' | 'loading' | 'failed'; mark: null; reload: () => void }
  | { status: 'ready'; mark: AnnotationView; reload: () => void }

/** The mark and its replies, read when the entry is shown and again after an answer. */
function useMarkThread(item: InboxItemView | null, readMark: ReadMark): MarkThreadState {
  const documentId = item?.resourceId ?? null
  const markId = item?.anchorId ?? null
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'failed' | 'ready'; mark: AnnotationView | null }>({
    status: 'idle',
    mark: null,
  })
  const [round, setRound] = useState(0)
  const reload = useCallback(() => setRound((value) => value + 1), [])

  useEffect(() => {
    if (!documentId || !markId) return
    let live = true
    // A re-read keeps the thread on screen; only a first read shows the skeleton.
    setState((previous) => (previous.mark?.id === markId ? previous : { status: 'loading', mark: null }))
    readMark(documentId, markId)
      .then((mark) => live && setState({ status: 'ready', mark }))
      .catch(() => live && setState((previous) => (previous.mark?.id === markId ? previous : { status: 'failed', mark: null })))
    return () => {
      live = false
    }
  }, [documentId, markId, readMark, round])

  if (state.status === 'ready' && state.mark) return { status: 'ready', mark: state.mark, reload }
  return { status: state.status === 'ready' ? 'loading' : state.status, mark: null, reload }
}

function MarkThread({ thread, viewerId }: { thread: MarkThreadState; viewerId: string | null }): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const { locale } = useLocale()
  if (thread.status === 'failed') {
    return <p className="text-sm text-muted-foreground" data-testid="inbox-detail-thread-failed">{t('inbox.detail.threadFailed')}</p>
  }
  if (thread.status !== 'ready') {
    return (
      <div className="space-y-4" aria-busy="true" aria-label={t('inbox.detail.threadLoading')}>
        {[0, 1].map((index) => (
          <div key={index} className="flex gap-3">
            <Skeleton className="size-7 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-1/4" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    )
  }
  const { mark } = thread
  const entries = [
    { id: mark.id, authorKind: mark.authorKind, name: mark.createdByName, userId: mark.createdBy, at: mark.createdAt, body: mark.body, mentions: mark.mentions },
    ...mark.replies.map((reply) => ({
      id: reply.id,
      authorKind: reply.authorKind,
      name: reply.createdByName,
      userId: reply.createdBy,
      at: reply.createdAt,
      body: reply.body,
      mentions: reply.mentions,
    })),
  ]
  return (
    <section aria-label={t('inbox.detail.thread')}>
      <ol className="space-y-4" data-testid="inbox-detail-thread">
        {entries.map((entry) => {
          const piloti = entry.authorKind !== 'person'
          const name = piloti ? PRODUCT_NAME : (entry.name ?? t('inbox.unknownActor'))
          return (
            <li key={entry.id} className="flex gap-3">
              <span aria-hidden className="mt-0.5 shrink-0">
                {piloti ? <AgentGlyph size="md" tone="outline" /> : <PersonAvatar person={{ userId: entry.userId ?? entry.id, name }} size="sm" />}
              </span>
              <div className="min-w-0 space-y-0.5">
                <p className="text-xs">
                  <span className="font-semibold">{name}</span>{' '}
                  <TimeAgo date={entry.at} locale={locale} className="text-muted-foreground" />
                </p>
                <p className="text-sm leading-relaxed whitespace-pre-line">
                  <MentionText content={entry.body} mentions={entry.mentions} currentUserId={viewerId} />
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
