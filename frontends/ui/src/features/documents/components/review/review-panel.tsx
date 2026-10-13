'use client'

import type { JSX } from 'react'
import { CalendarClock, CheckCheck, MessageCircle, MousePointerClick, UserRound } from 'lucide-react'
import { CommentPin } from '@/components/ui/comment-pin'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import { formatDayRange, localCalendarDay } from '@/lib/format'
import { isLive, isOverdue, type AnnotationView } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import type { DocumentReview, ReviewFilter } from '../../hooks/use-document-review'
import { MarkFace, markInk } from './review-page-layer'
import { KIND_ICONS } from './thread-card'

function Row({
  annotation,
  review,
  onOpen,
}: {
  annotation: AnnotationView
  review: DocumentReview
  onOpen: (annotation: AnnotationView) => void
}): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const KindIcon = KIND_ICONS[annotation.kind]
  const selected = annotation.id === review.selectedId
  const overdue = isOverdue(annotation, localCalendarDay())
  return (
    <li>
      <button
        type="button"
        data-testid="review-row"
        aria-current={selected || undefined}
        onClick={() => onOpen(annotation)}
        onPointerEnter={() => review.hover(annotation.id)}
        onPointerLeave={() => review.hover(null)}
        className={cn(
          'group/row flex w-full gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-quick ease-out outline-none',
          'hover:bg-accent/60 focus-visible:ring-ring/60 focus-visible:ring-2',
          selected && 'bg-accent'
        )}
      >
        <span className="pt-1">
          <CommentPin
            as="span"
            number={annotation.number}
            face={<MarkFace annotation={annotation} />}
            color={markInk(annotation)}
            proposed={annotation.status === 'proposed'}
            done={!isLive(annotation)}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground flex items-center gap-1 text-[11px] font-medium">
            <KindIcon className="size-3" aria-hidden />
            {t(`annotations.kinds.${annotation.kind}`)}
            <span aria-hidden>·</span>
            <span className="truncate">
              {annotation.authorKind === 'piloti' ? 'Piloti' : (annotation.createdByName ?? t('review.someone'))}
            </span>
            {annotation.status === 'proposed' && (
              <span className="border-foreground/50 ml-auto shrink-0 rounded-full border border-dashed px-1.5 text-[10px]">
                {t('review.proposal')}
              </span>
            )}
          </span>
          <span
            className={cn(
              'text-foreground mt-0.5 line-clamp-2 text-[13px] leading-5',
              !isLive(annotation) && 'text-muted-foreground'
            )}
          >
            {annotation.body}
          </span>
          {(annotation.replies.length > 0 || annotation.assigneeName || annotation.dueOn || !annotation.onCurrentFassung) && (
            <span className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]">
              {annotation.replies.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <MessageCircle className="size-3" aria-hidden />
                  {annotation.replies.length}
                </span>
              )}
              {annotation.assigneeName && (
                <span className="inline-flex items-center gap-1">
                  <UserRound className="size-3" aria-hidden />
                  {annotation.assigneeName}
                </span>
              )}
              {annotation.dueOn && (
                <span className={cn('inline-flex items-center gap-1', overdue && 'text-warning font-medium')}>
                  <CalendarClock className="size-3" aria-hidden />
                  {formatDayRange(annotation.dueOn, annotation.dueOn, locale)}
                </span>
              )}
              {!annotation.onCurrentFassung && (
                <span title={t('annotations.earlierFassungHint')}>
                  {annotation.fassungNumber
                    ? t('annotations.earlierFassung', { number: annotation.fassungNumber })
                    : t('annotations.earlierFassungUnnumbered')}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

const FILTERS: ReviewFilter[] = ['open', 'proposed', 'closed']

/**
 * The review's list: every mark of the document, grouped by page, in the order
 * a review walks them. Selecting a row brings its mark to the middle of the
 * view and opens its thread; hovering a row lights its mark on the page.
 */
export function ReviewPanel({
  review,
  onOpen,
}: {
  review: DocumentReview
  onOpen: (annotation: AnnotationView) => void
}): JSX.Element {
  const t = useTranslations('files')
  const { counts, listed, filter, setFilter, load } = review
  const pages = [...new Set(listed.map((annotation) => annotation.page))]
  const live = counts.open + counts.proposed

  return (
    <aside
      data-testid="review-panel"
      aria-label={t('annotations.section')}
      className="bg-background flex h-full w-[22rem] shrink-0 flex-col border-l max-lg:hidden"
    >
      <div className="px-4 pt-4 pb-3">
        <h2 className="text-foreground text-sm font-semibold">{t('annotations.section')}</h2>
        <div role="tablist" aria-label={t('review.filter')} className="bg-muted mt-3 grid grid-cols-3 rounded-lg p-0.5">
          {FILTERS.map((option) => {
            const count = option === 'open' ? live : option === 'proposed' ? counts.proposed : counts.closed
            return (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={filter === option}
                data-testid={`review-filter-${option}`}
                onClick={() => setFilter(option)}
                className={cn(
                  'inline-flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors duration-quick ease-out',
                  filter === option ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`review.filters.${option}`)}
                <span className="text-muted-foreground tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {load === 'loading' ? (
          <div className="flex justify-center py-10">
            <Spinner size="sm" />
          </div>
        ) : load === 'error' ? (
          <div className="space-y-2 px-2 py-6 text-center">
            <p className="text-muted-foreground text-sm">{t('annotations.loadError')}</p>
            <Button type="button" variant="outline" size="sm" onClick={review.retry}>
              {t('annotations.retry')}
            </Button>
          </div>
        ) : listed.length === 0 ? (
          <EmptyList review={review} />
        ) : (
          pages.map((page) => (
            <section key={page} aria-label={t('review.page', { page })} className="mt-1">
              <h3 className="text-muted-foreground px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-[0.05em] uppercase">
                {t('review.page', { page })}
              </h3>
              <ul className="space-y-0.5">
                {listed
                  .filter((annotation) => annotation.page === page)
                  .map((annotation) => (
                    <Row key={annotation.id} annotation={annotation} review={review} onOpen={onOpen} />
                  ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <div className="text-muted-foreground border-t px-4 py-2.5 text-[11px]">
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            <Kbd>C</Kbd> {t('review.tools.point')}
          </span>
          <span>
            <Kbd>R</Kbd> {t('review.tools.region')}
          </span>
          <span>
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> {t('review.walk')}
          </span>
        </span>
      </div>
    </aside>
  )
}

/** What an empty list says depends on why it is empty: nothing yet, nothing left, or nothing in this filter. */
function EmptyList({ review }: { review: DocumentReview }): JSX.Element {
  const t = useTranslations('files')
  const { counts, filter, annotations } = review
  const allDone = filter === 'open' && annotations.length > 0 && counts.open + counts.proposed === 0
  const Icon = allDone ? CheckCheck : MousePointerClick
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center" data-testid="review-empty">
      <span className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="text-foreground mt-3 text-sm font-medium">
        {allDone
          ? t('review.empty.doneTitle')
          : annotations.length === 0
            ? t('review.empty.noneTitle')
            : t(`review.empty.${filter}Title`)}
      </p>
      <p className="text-muted-foreground mt-1 text-xs leading-5">
        {allDone
          ? t('review.empty.doneBody')
          : annotations.length === 0
            ? review.canAnnotate
              ? t('review.empty.noneBody')
              : t('review.empty.readOnlyBody')
            : t(`review.empty.${filter}Body`)}
      </p>
    </div>
  )
}
