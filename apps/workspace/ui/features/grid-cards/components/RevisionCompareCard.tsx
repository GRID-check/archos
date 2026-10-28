'use client'

/**
 * RevisionCompareCard — two Fassungen of a document side by side, the changes
 * boxed on each (ADR-0128, slice V10).
 *
 * System-emitted when Piloti compared two Fassungen through the workspace door
 * (`agent/tools/workspace/cards.py`, from the result of
 * `document-revision-compare`). The card is an ADDRESS: the two documents' ids,
 * the page, the boxes. Each side is the whole page drawn from that document's
 * own routes (`PageRegionThumbnail`), so only a reader who may open both sees
 * the pages. The boxes were found on the newer page and are drawn at the same
 * place on the older one: the compare view reads a pair the same way. Pressing a
 * side opens that Fassung at the page with every box on it.
 */

import type { FC } from 'react'
import { GitCompareArrows } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { SectionLabel } from '@/components/ui/section-label'
import { MARK_INK, rgbCss } from '@/features/documents/components/revision-compare/lib/tint'
import { PagePlaceButton } from '@/features/knowledge/components/page-place-button'
import type { PagePlace } from '@/features/knowledge/lib/page-place'
import type { PageRegion } from '@/features/knowledge/lib/page-region'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { cn } from '@/lib/utils'
import type { GridCard } from '@/shared/cards/schemas'
import { CARD_SHELL } from './card-chrome'

type RevisionCompareData = Extract<GridCard, { type: 'revision_compare' }>

interface RevisionCompareCardProps {
  olderId: RevisionCompareData['older_id']
  newerId: RevisionCompareData['newer_id']
  /** The Fassungen's file names, when the comparison named them; a side without one is labelled by its role. */
  olderName?: RevisionCompareData['older_name']
  newerName?: RevisionCompareData['newer_name']
  page: RevisionCompareData['page']
  changes: RevisionCompareData['changes']
  summary: RevisionCompareData['summary']
  /** For a dev preview: draw the thumbnails at once, not when on screen. */
  eager?: boolean
}

/** The tallest a page is drawn, in CSS pixels: two pages in a card stay thumbnails. */
const THUMBNAIL_MAX_HEIGHT = 260

/**
 * The compare view's mark gold (`MARK_INK`), so a change reads the same on the
 * card as in the compare view. Piloti's paper ink vanished on a black stair core.
 */
const MARK_COLOR = rgbCss(MARK_INK)

/** The boxes as the viewer's regions: `[x, y, w, h]` to `[x0, y0, x1, y1]`. */
export const changeRegions = (changes: RevisionCompareData['changes']): PageRegion[] =>
  (changes ?? []).flatMap(({ region }) => {
    const [x, y, w, h] = region
    return [{ box: [x, y, Math.min(1, x + w), Math.min(1, y + h)] as PageRegion['box'] }]
  })

/** One Fassung's page as a place; `name` is the file name when the comparison carried it, else the side's own word. */
export const sidePlace = (id: string, name: string, page: number): PagePlace => ({
  document: { id, name, shelf: 'stored' },
  page,
  frame: 'page',
  region: null,
})

export const RevisionCompareCard: FC<RevisionCompareCardProps> = ({
  olderId,
  newerId,
  olderName,
  newerName,
  page,
  changes,
  summary,
  eager,
}) => {
  const t = useTranslations(chatCopy)
  const marks = changeRegions(changes)
  const sides = [
    { key: 'older', id: olderId, name: olderName || t('cards.revisionCompare.older') },
    { key: 'newer', id: newerId, name: newerName || t('cards.revisionCompare.newer') },
  ] as const

  return (
    <Card data-testid="revision-compare-card" className={cn(CARD_SHELL, 'gap-3 p-4 sm:p-5')}>
      <div className="flex flex-col gap-1">
        <SectionLabel icon={GitCompareArrows}>{t('cards.revisionCompare.eyebrow')}</SectionLabel>
        <p className="card-title text-foreground">{t('cards.revisionCompare.page', { page })}</p>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {sides.map((side) => (
          <li key={side.key} data-testid="revision-compare-side" data-side={side.key} className="min-w-0">
            <PagePlaceButton
              place={sidePlace(side.id, side.name, page)}
              marks={marks}
              color={MARK_COLOR}
              label={t('cards.revisionCompare.open', { side: side.name, page })}
              thumbnailMaxHeight={THUMBNAIL_MAX_HEIGHT}
              eager={eager}
              className="w-full"
            >
              <span className="card-caption text-muted-foreground px-0.5">{side.name}</span>
            </PagePlaceButton>
          </li>
        ))}
      </ul>
      <ul data-testid="revision-compare-summary" className="card-caption text-foreground flex list-disc flex-col gap-0.5 pl-5">
        {summary.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </Card>
  )
}
