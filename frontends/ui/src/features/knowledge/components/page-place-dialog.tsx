'use client'

/**
 * Open a document at a place (ADR-0128): the citation viewer at the page, with
 * the box glowing. The glow is the viewer's own arrival pulse on
 * `RegionMarks`, so a look opened from the chat lands exactly as a citation
 * with a region does.
 *
 * Stored PDFs (and an office file's rendition) stream from the same-origin
 * route the viewer reads, a named Fassung from its own; a corpus file from the
 * corpus route; an image upload shows the signed picture its thumbnail drew.
 */

import type { FC } from 'react'
import { PdfViewerDialog } from './pdf-viewer-dialog'
import { placeFileUrl, placeRegions, type PagePlace } from '../lib/page-place'

export interface PagePlaceDialogProps {
  place: PagePlace
  open: boolean
  onOpenChange: (open: boolean) => void
  /** CSS colour of the box, the tint of what opened it. */
  color?: string
  /** An image upload's signed URL, from its thumbnail; the document opens as an image. */
  imageUrl?: string | null
}

export const PagePlaceDialog: FC<PagePlaceDialogProps> = ({ place, open, onOpenChange, color, imageUrl }) => {
  const src = imageUrl ?? placeFileUrl(place) ?? undefined
  return (
    <PdfViewerDialog
      open={open}
      onOpenChange={onOpenChange}
      fileName={place.document.name}
      title={place.document.name}
      src={src}
      page={place.page}
      isImage={Boolean(imageUrl)}
      regions={placeRegions(place)}
      highlightColor={color}
    />
  )
}
