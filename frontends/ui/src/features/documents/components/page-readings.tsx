'use client'

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { ArrowUpRight, RotateCcw, ScanSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ClampedText } from '@/components/ui/clamped-text'
import { InspectorGroup, InspectorSection } from '@/components/ui/inspector-group'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import {
  humanizeTerm,
  hasStructuredDetail,
  type DrawingStructured,
} from '@/lib/documents/drawing-structured'
import { DrawingStructuredDetails } from './drawing-structured-details'

/** One visual chunk's VLM description (mirrors the BFF visual-details payload). */
export interface VisualDetail {
  page: number
  contentType: string
  drawingType: string
  scale: string
  text: string
  /** Which drawing on the sheet — a sheet is indexed one chunk per drawing. */
  segment?: number
  /**
   * How many drawings share this chunk's sheet. Optional because chunks
   * indexed before per-segment chunking recorded it carry none; absent reads
   * as a single depiction and renders no position.
   */
  segmentCount?: number
  /** The structured analysis behind the description; absent on older chunks. */
  structured?: DrawingStructured | null
}

/**
 * Entries shown before the list asks for the space. Four is what fits beside
 * the document in the split without pushing the approval section off the
 * first screen; a 40-sheet Einreichplan would otherwise be the whole rail.
 */
const FIRST_ENTRIES = 4

/**
 * What Piloti saw on each page: the drawing type, its scale and its words for
 * the drawing, page by page.
 *
 * It used to be „Detaillierte Informationen", a collapsed disclosure at the
 * foot of the rail that loaded nothing until opened, under Project, Type and
 * Updated. For a drawing set this is the most specific thing the rail knows:
 * the summary says what the document is, this says what is on sheet 7. So it
 * leads, loaded with the document, and each entry opens its page in the
 * viewer beside it when there is one, which ties the sentence to the drawing
 * it describes.
 */
export function PageReadings({
  details,
  loading,
  failed,
  onRetry,
  onShowPage,
  className,
}: {
  details: readonly VisualDetail[] | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  /** Present only where the well can turn to a page (the inline PDF viewer). */
  onShowPage?: (page: number) => void
  className?: string
}): JSX.Element | null {
  const t = useTranslations('files')
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [details])

  // A document whose visual chunks carry no descriptions has nothing to say
  // here, and an empty group would be a heading over nothing.
  if (!loading && !failed && details && details.length === 0) return null

  const shown = details ? (expanded ? details : details.slice(0, FIRST_ENTRIES)) : []
  const hidden = details ? details.length - shown.length : 0

  return (
    <InspectorSection
      label={t('preview.visualDetails.title')}
      icon={ScanSearch}
      className={className}
      data-testid="page-readings"
    >
      <InspectorGroup>
        {(loading || details === null) && !failed ? (
          <div className="space-y-2 p-3" aria-busy="true">
            <span className="sr-only">{t('preview.visualDetails.loading')}</span>
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ) : failed ? (
          <div className="space-y-2 p-3">
            <p className="text-muted-foreground text-xs">{t('preview.visualDetails.failed')}</p>
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={onRetry}>
              <RotateCcw className="size-3.5" aria-hidden />
              {t('preview.tryAgain')}
            </Button>
          </div>
        ) : (
          <ol className="divide-border/60 divide-y">
            {shown.map((detail, index) => (
              <PageReading
                key={`${detail.page}-${detail.contentType}-${detail.segment ?? 0}-${index}`}
                detail={detail}
                onShowPage={onShowPage}
              />
            ))}
          </ol>
        )}
        {hidden > 0 || (expanded && details && details.length > FIRST_ENTRIES) ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="text-muted-foreground hover:text-foreground hover:bg-accent/40 duration-snap border-border/60 touch-target focus-visible:bg-accent/40 w-full border-t px-3 py-2 text-left text-xs/5 font-medium outline-none transition-colors ease-out motion-reduce:transition-none"
          >
            {expanded
              ? t('preview.visualDetails.showFewer')
              : t('preview.visualDetails.showAll', { count: details?.length ?? 0 })}
          </button>
        ) : null}
      </InspectorGroup>
    </InspectorSection>
  )
}

function PageReading({
  detail,
  onShowPage,
}: {
  detail: VisualDetail
  onShowPage?: (page: number) => void
}): JSX.Element {
  const t = useTranslations('files')
  /**
   * The drawing type's label. A type this build has no translation for is
   * humanized from its key, the same contract as the structured vocabulary:
   * a domain added on the backend shows up without a frontend release. The
   * raw key (`floor_plan`) is what this row used to print.
   */
  const typeLabel = (() => {
    if (!detail.drawingType) return null
    const path = `preview.visualDetails.segmentTypes.${detail.drawingType}`
    const translated = t(path)
    return translated.endsWith(path) ? humanizeTerm(detail.drawingType) : translated
  })()
  const position =
    detail.segmentCount != null && detail.segmentCount > 1
      ? `${(detail.segment ?? 0) + 1}/${detail.segmentCount}`
      : null
  const scale = detail.scale && detail.scale.toLowerCase() !== 'unbekannt' ? detail.scale : null

  const heading = (
    <>
      <span
        className="bg-muted text-muted-foreground inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium tabular-nums"
        aria-label={t('preview.visualDetails.page', { page: detail.page })}
      >
        {t('preview.visualDetails.pageShort', { page: detail.page })}
      </span>
      <span className="text-foreground min-w-0 flex-1 truncate font-medium">
        {typeLabel ?? t('preview.visualDetails.page', { page: detail.page })}
        {position && (
          <span className="text-muted-foreground font-normal tabular-nums"> · {position}</span>
        )}
      </span>
      {scale && (
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {t('preview.visualDetails.scale', { scale })}
        </span>
      )}
    </>
  )

  return (
    <li className="py-2.5 text-xs/5">
      {onShowPage ? (
        <button
          type="button"
          onClick={() => onShowPage(detail.page)}
          title={t('preview.visualDetails.showPage', { page: detail.page })}
          className="hover:bg-accent/40 duration-snap group/page focus-visible:bg-accent/40 -my-1 flex w-full items-center gap-2 px-3 py-1 text-left outline-none transition-colors ease-out motion-reduce:transition-none"
        >
          {heading}
          <ArrowUpRight
            className="text-muted-foreground/60 group-hover/page:text-foreground size-3.5 shrink-0 transition-colors"
            aria-hidden
          />
        </button>
      ) : (
        <div className="flex items-center gap-2 px-3">{heading}</div>
      )}
      <div className="mt-1 px-3">
        <ClampedText
          lines={3}
          moreLabel={t('preview.summaryMore')}
          lessLabel={t('preview.summaryLess')}
          className="text-muted-foreground whitespace-pre-line text-xs leading-relaxed"
        >
          {detail.text}
        </ClampedText>
        {hasStructuredDetail(detail.structured ?? null) && detail.structured && (
          <DrawingStructuredDetails structured={detail.structured} />
        )}
      </div>
    </li>
  )
}
