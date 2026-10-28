'use client'

/**
 * LookCard — where Piloti looked on one document in this turn (ADR-0128).
 *
 * System-emitted once the answer is final (`aiq_agent/tools/look/cards.py`):
 * one card per document, an item per look the answer relies on and a
 * `reference` item per box or pointer Piloti showed the room. An item is an
 * ADDRESS (page, region, Fassung), never pixels.
 *
 * Each item is the page clip with the place marked (`PagePlaceButton`, drawn
 * from the document's own routes, so only a reader who may open the document
 * sees it), the page and the place in words, what Piloti looked for, and what
 * it read there, marked as a reading: what Piloti read off the page, never a
 * measurement. Pressing an item opens the document at the place with the box
 * glowing. A look is in the document's tint; a reference in Piloti's ink, the
 * colour its box has on the canvas.
 */

import type { FC } from 'react'
import { ScanSearch } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { SectionLabel } from '@/components/ui/section-label'
import { PagePlaceButton } from '@/features/knowledge/components/page-place-button'
import type { PagePlace } from '@/features/knowledge/lib/page-place'
import { useTranslations, type Translator } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { cn } from '@/lib/utils'
import { Quote } from '@/components/ui/quote'
import type { GridCard } from '@/shared/cards/schemas'
import { CARD_SHELL } from './card-chrome'

type LookCardData = Extract<GridCard, { type: 'look' }>
type LookItem = LookCardData['items'][number]

interface LookCardProps {
  document: LookCardData['document']
  items: LookCardData['items']
  /** For a dev preview: draw the thumbnails at once, not when on screen. */
  eager?: boolean
}

/** The tallest a thumbnail is drawn, in CSS pixels: a portrait page in a card stays a thumbnail. */
const THUMBNAIL_MAX_HEIGHT = 180

/** The place an item addresses, as the thumbnail and the viewer take it. */
export const lookItemPlace = (document: LookCardData['document'], item: LookItem): PagePlace => ({
  document: { id: document.id ?? null, name: document.name, shelf: document.shelf ?? 'stored' },
  page: item.page,
  frame: item.frame ?? 'page',
  region: item.region ?? null,
  point: item.point ?? null,
  imageIndex: item.image_index ?? null,
  revisionId: item.revision_id ?? null,
  label: item.origin === 'reference' ? (item.label ?? null) : null,
})

/** The colour of a place: the document's source tint for a look, Piloti's ink for what it showed. */
export const lookItemColor = (shelf: 'stored' | 'base' | undefined, origin: LookItem['origin']): string =>
  origin === 'reference' ? 'var(--paper-ink)' : `var(--source-${shelf === 'base' ? 'law' : 'project'})`

/** „ganze Seite“, „oben rechts“, „Bild 2“: where on the page, in words; null when nothing says. */
const placeWords = (t: Translator, item: LookItem): string | null => {
  if (item.frame === 'image' && item.image_index != null) return t('cards.look.embeddedImage', { index: item.image_index + 1 })
  return item.where ?? (item.scope === 'overview' ? t('cards.look.wholePage') : null)
}

export const LookCard: FC<LookCardProps> = ({ document, items, eager }) => {
  const t = useTranslations(chatCopy)
  const hasReading = items.some((item) => item.origin !== 'reference' && item.reading)

  return (
    <Card data-testid="look-card" className={cn(CARD_SHELL, 'gap-3 p-4 sm:p-5')}>
      <div className="flex flex-col gap-1">
        <SectionLabel icon={ScanSearch}>{t('cards.look.eyebrow')}</SectionLabel>
        <p className="card-title text-foreground break-all">{document.name}</p>
      </div>
      <ul className={cn('grid grid-cols-1 gap-3', items.length > 1 && 'sm:grid-cols-2')}>
        {items.map((item, index) => {
          const reference = item.origin === 'reference'
          const place = placeWords(t, item)
          const said = reference ? item.label : item.question
          return (
            <li key={index} data-testid="look-item" data-origin={item.origin ?? 'look'} className="min-w-0">
              <PagePlaceButton
                place={lookItemPlace(document, item)}
                color={lookItemColor(document.shelf, item.origin)}
                label={t('cards.look.open', { document: document.name, page: item.page })}
                thumbnailMaxHeight={THUMBNAIL_MAX_HEIGHT}
                eager={eager}
                className="w-full"
              >
                <span className="card-caption flex flex-col gap-0.5 px-0.5">
                  <span className="text-muted-foreground">
                    {t(reference ? 'cards.look.shown' : 'cards.look.looked', { page: item.page })}
                    {place && ` · ${place}`}
                  </span>
                  {said && <span className="text-foreground">{said}</span>}
                  {!reference && item.reading && (
                    <Quote
                      as="span"
                      data-testid="look-reading"
                      title={t('cards.look.readingNote')}
                      className="text-foreground"
                    >
                      {t('cards.look.reading', { reading: item.reading })}
                    </Quote>
                  )}
                </span>
              </PagePlaceButton>
            </li>
          )
        })}
      </ul>
      {hasReading && (
        <p data-testid="look-reading-note" className="card-caption text-muted-foreground">
          {t('cards.look.readingNote')}
        </p>
      )}
    </Card>
  )
}
