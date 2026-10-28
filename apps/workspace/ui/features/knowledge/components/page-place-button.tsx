'use client'

/**
 * A place on a document as a control (ADR-0128): its thumbnail and a caption,
 * one button, and pressing it (click, Enter, Space) opens the document at the
 * place with the box glowing (`PagePlaceDialog`). The look card's items and
 * the Herleitung's look row are this, so the two open the same way.
 *
 * A reader who may not open the document sees the tile saying so, and the
 * button is disabled: there is nothing behind it for them.
 */

import { useState, type FC, type ReactNode } from 'react'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { cn } from '@/lib/utils'
import type { PagePlace } from '../lib/page-place'
import type { PageRegion } from '../lib/page-region'
import { PagePlaceDialog } from './page-place-dialog'
import { PageRegionThumbnail } from './page-region-thumbnail'

export interface PagePlaceButtonProps {
  place: PagePlace
  /** What pressing it does, for a screen reader: „Grundriss EG.pdf, Seite 2, oben rechts öffnen“. */
  label: string
  /** CSS colour of the box, on the thumbnail and in the viewer. */
  color?: string
  /** The thumbnail's width in CSS pixels; the button's own width when unset. */
  thumbnailWidth?: number
  thumbnailMaxHeight?: number
  /**
   * Several boxes on the page instead of the place's own: the thumbnail then draws the
   * whole page with all of them, and the viewer opens with all of them (a comparison's changes).
   */
  marks?: readonly PageRegion[]
  /** Shown under the thumbnail. */
  children?: ReactNode
  className?: string
  /** For a dev preview: draw at once, not when on screen. */
  eager?: boolean
}

export const PagePlaceButton: FC<PagePlaceButtonProps> = ({
  place,
  label,
  color,
  thumbnailWidth,
  thumbnailMaxHeight,
  marks,
  children,
  className,
  eager,
}) => {
  const [open, setOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)

  return (
    <>
      <button
        type="button"
        data-testid="page-place-button"
        aria-label={label}
        disabled={denied}
        onClick={() => setOpen(true)}
        className={cn(
          'group/place flex min-w-0 flex-col gap-1.5 rounded-md p-1 text-left transition-colors duration-quick ease-out',
          'hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent',
          FOCUS_RING,
          'outline-none',
          className
        )}
      >
        <PageRegionThumbnail
          place={place}
          color={color}
          width={thumbnailWidth}
          maxHeight={thumbnailMaxHeight}
          clip={marks ? false : undefined}
          marks={marks}
          lazy={!eager}
          label={label}
          onDrawn={({ image }) => setImageUrl(image?.url ?? null)}
          onDenied={() => setDenied(true)}
        />
        {children}
      </button>
      {open && (
        <PagePlaceDialog place={place} open={open} onOpenChange={setOpen} color={color} imageUrl={imageUrl} regions={marks} />
      )}
    </>
  )
}
