'use client'

import type { JSX, ReactNode } from 'react'
import { Clock, MessageCircle, UserRound, type LucideIcon } from 'lucide-react'
import { CommentPin } from '@/components/ui/comment-pin'
import { useLocale, useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { formatDayRange, localCalendarDay } from '@/lib/format'
import { isLive, isOverdue, type AnnotationView } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import { MarkBody } from './mark-body'
import { useAgentByline } from './agent-attribution'
import { markInk, pinLabel } from './review-page-layer'

/**
 * The surface of one mark's row: the review's list (a button) and a project's
 * Offene Punkte (a link into that review) both wear it, so a row reads the
 * same wherever a mark is listed.
 */
export const markRowClassName = (selected = false): string =>
  cn(
    'flex w-full gap-3 rounded-control px-2.5 py-2 text-left transition-colors duration-quick ease-out outline-none',
    'hover:bg-accent/60 focus-visible:ring-ring/60 focus-visible:ring-2',
    selected && 'bg-accent'
  )

/**
 * What a row says about one mark: its number (what people say aloud), what it
 * says, and one quiet line of what kind, who, how many answers, and by when;
 * under it, the Fassung it was set on when that is an earlier one. The row's
 * element (a button, a link) is the caller's.
 */
export function MarkRowContent({
  annotation,
  viewerId,
  showPage = false,
  unread = false,
}: {
  annotation: AnnotationView
  /** The reader, so a mention of them stands out. */
  viewerId: string | null
  /** Name the page in the quiet line: where nothing around the row says which page it is on. */
  showPage?: boolean
  /** News on it the reader has not read (`DocumentReview.unread`): a dot on the pin, and words for a screen reader. */
  unread?: boolean
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const byline = useAgentByline()
  const overdue = isOverdue(annotation, localCalendarDay())
  const author =
    annotation.authorKind === 'piloti' ? byline(annotation.createdByName) : (annotation.createdByName ?? t('review.someone'))
  return (
    <>
      <span className="pt-0.5">
        {/* The pin is drawn for the eye only (`aria-hidden`): its number and its
            state (a dash, a tick, the dot) are said here, as a pin on the page
            says them. Who set it and the Fassung are the row's own text. */}
        <span className="sr-only" data-testid="mark-row-label">
          {`${pinLabel(t, annotation, undefined, undefined, { unread })}. `}
        </span>
        <CommentPin
          as="span"
          number={annotation.number}
          color={markInk(annotation)}
          proposed={annotation.status === 'proposed'}
          done={!isLive(annotation)}
          unread={unread}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('text-foreground line-clamp-2 text-sm leading-5', !isLive(annotation) && 'text-muted-foreground')}>
          <MarkBody text={annotation.body} mentions={annotation.mentions} viewerId={viewerId} clamped />
        </span>
        <MarkMeta annotation={annotation} showPage={showPage} author={author} replies overdue={overdue} />
        {!annotation.onCurrentRevision && (
          <span className="text-muted-foreground mt-0.5 block text-xs italic" title={t('annotations.earlierRevisionHint')}>
            {annotation.revisionNumber
              ? t('annotations.earlierRevision', { number: annotation.revisionNumber })
              : t('annotations.earlierRevisionUnnumbered')}
          </span>
        )}
      </span>
    </>
  )
}

/** One fact of the quiet line: its glyph and its words, on one line. */
function MetaItem({ icon: Icon, className, children }: { icon: LucideIcon; className?: string; children: ReactNode }): JSX.Element {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 whitespace-nowrap', className)}>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * The quiet line under a mark: what kind, the page where nothing around says
 * it, who set it, who is on it, how many answers, by when. Every list of
 * marks wears this one line, the review's rows and those of a replaced
 * document alike. Items are separated by space and their own glyphs, never a
 * leading „·" when the line wraps.
 */
export function MarkMeta({
  annotation,
  showPage = false,
  author,
  replies = false,
  overdue = false,
}: {
  annotation: AnnotationView
  showPage?: boolean
  /** Who set it, where the line names them. */
  author?: string
  /** Count the answers in its thread. */
  replies?: boolean
  /** Past its date and still open: the word in ink instead of the date. */
  overdue?: boolean
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const { locale } = useLocale()
  return (
    <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs" data-testid="review-row-meta">
      <span className="whitespace-nowrap">{t(`annotations.kinds.${annotation.kind}`)}</span>
      {showPage && <span className="whitespace-nowrap">{t('review.page', { page: annotation.page })}</span>}
      {author !== undefined && <span className="min-w-0 truncate">{author}</span>}
      {annotation.assigneeName && <MetaItem icon={UserRound}>{annotation.assigneeName}</MetaItem>}
      {replies && annotation.replies.length > 0 && <MetaItem icon={MessageCircle}>{annotation.replies.length}</MetaItem>}
      {annotation.dueOn && (
        <MetaItem icon={Clock} className={cn(overdue && 'text-foreground font-semibold')}>
          {overdue ? t('review.overdue') : formatDayRange(annotation.dueOn, annotation.dueOn, locale)}
        </MetaItem>
      )}
    </span>
  )
}
