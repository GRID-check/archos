'use client'

import type { JSX } from 'react'
import { Maximize2, StickyNote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CommentPin } from '@/components/ui/comment-pin'
import { CountPill } from '@/components/ui/count-pill'
import { InspectorGroup, InspectorSection } from '@/components/ui/inspector-group'
import { useTranslations } from '@/i18n'
import { isLive } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import type { DocumentReview } from '../../hooks/use-document-review'
import { markInk } from './review-page-layer'

/** Live marks the rail shows before it sends the reader into the review for the rest. */
const PREVIEWED = 3

/**
 * „Anmerkungen" in the opened document's rail: how much is open, the first few
 * marks, and the door into the focused review, which is where marks are set,
 * discussed and closed. The rail only tells; the review is where the work
 * happens, so the rail never grows a form.
 */
export function AnnotationsSummary({
  review,
  onOpenReview,
  className,
}: {
  review: DocumentReview
  /** Open the review, at one mark when given. */
  onOpenReview: (annotationId?: string) => void
  className?: string
}): JSX.Element {
  const t = useTranslations('files')
  const live = review.annotations.filter(isLive)
  const others = review.room.peers.length
  return (
    <InspectorSection
      label={t('annotations.section')}
      icon={StickyNote}
      action={
        live.length > 0 ? <CountPill>{t('annotations.openCount', { count: live.length })}</CountPill> : undefined
      }
      className={className}
      data-testid="annotations-summary"
    >
      <InspectorGroup>
        {live.slice(0, PREVIEWED).map((annotation) => (
          <button
            key={annotation.id}
            type="button"
            data-testid="annotations-summary-row"
            onClick={() => onOpenReview(annotation.id)}
            className="hover:bg-accent/40 border-border/60 flex w-full items-start gap-2.5 border-t px-3 py-2.5 text-left first:border-t-0"
          >
            <CommentPin
              as="span"
              number={annotation.number}
              color={markInk(annotation)}
              proposed={annotation.status === 'proposed'}
            />
            <span className="text-foreground line-clamp-2 min-w-0 flex-1 text-xs leading-5">{annotation.body}</span>
          </button>
        ))}
        <div className={cn('p-2', live.length > 0 && 'border-border/60 border-t')}>
          <Button
            type="button"
            variant={live.length > 0 ? 'ghost' : 'outline'}
            size="sm"
            className="h-8 w-full justify-center gap-1.5"
            data-testid="open-review"
            onClick={() => onOpenReview()}
          >
            <Maximize2 className="size-3.5" aria-hidden />
            {live.length > PREVIEWED
              ? t('review.openAll', { count: live.length })
              : t('review.open')}
          </Button>
          {others > 0 && (
            <p className="text-muted-foreground mt-1.5 text-center text-[11px]">
              {t('review.othersHere', { count: others })}
            </p>
          )}
        </div>
      </InspectorGroup>
    </InspectorSection>
  )
}
