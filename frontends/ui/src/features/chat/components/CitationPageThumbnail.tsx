/**
 * The page a citation cites, small, with the place on it marked.
 *
 * A plan is cited for a depiction (a Grundriss, a Schnitt), and the passage the
 * peek can quote is the vision model's description of it. The reader's question
 * "is this the drawing the answer means?" is answered faster by the sheet with
 * the box on it than by the description (ADR-0128, "Citations become places").
 * The marks are the viewer's own (`RegionMarks`), and the box is the one the
 * viewer opens with, so the thumbnail and the opened document agree.
 *
 * Only a stored PDF is drawn here. The drawing is the shared place thumbnail
 * (`PageRegionThumbnail`, which the look card and the Herleitung's look rows
 * use too): the viewer's own pdf.js runtime and the same-origin file route.
 * It draws at once, because the peek mounts only while it is open. Anything
 * that cannot be drawn renders nothing: the peek is the same as it was
 * without it.
 */

'use client'

import type { FC } from 'react'
import { PageRegionThumbnail } from '@/features/knowledge/components/page-region-thumbnail'
import type { PageRegion } from '@/features/knowledge/lib/page-region'
import { useTranslations } from '@/i18n'
import type { CitationTarget } from '../lib/citations'

/** Drawn width in CSS pixels: the peek's content column (`w-80` less its padding). */
const THUMBNAIL_WIDTH = 288

/**
 * The id of the stored PDF a peek may draw a page of, or `undefined`.
 * An office file's PDF is a rendition the BFF makes on request and an image has
 * no page: neither is drawn here, they open in the viewer as before.
 */
export const thumbnailDocumentId = (target: CitationTarget): string | undefined => {
  if (target.kind !== 'document' || target.document.type !== 'stored') return undefined
  const { id, filename, contentType } = target.document
  const isPdf = (contentType ?? '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(filename)
  return isPdf ? id : undefined
}

export const CitationPageThumbnail: FC<{
  documentId: string
  page: number
  regions: readonly PageRegion[]
  /** CSS colour of the marks: the tint of the source, as in the viewer. */
  color?: string
}> = ({ documentId, page, regions, color }) => {
  const t = useTranslations('chat')
  return (
    <PageRegionThumbnail
      data-citation-thumbnail=""
      place={{ document: { id: documentId, name: '', shelf: 'stored' }, page, frame: 'page', region: null }}
      clip={false}
      lazy={false}
      width={THUMBNAIL_WIDTH}
      marks={regions}
      color={color}
      label={regions.find((region) => region.label)?.label ?? t('citationPeek.pageThumbnail', { page })}
      fallback="none"
      className="max-w-72 justify-start"
    />
  )
}
