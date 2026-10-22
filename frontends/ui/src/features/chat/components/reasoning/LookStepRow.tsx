'use client'

/**
 * The Herleitung's look rows (ADR-0128): „Angesehen: Grundriss EG.pdf, S. 2,
 * oben rechts“ and a thumbnail of the place, per document Piloti looked at.
 * Consecutive looks at one document fold into one row with a strip of
 * thumbnails. Every thumbnail opens the document at its place with the box
 * glowing, as the look card's items do (`PagePlaceButton`).
 *
 * The words are the step's own (the region in words is computed by the
 * backend, `tools/look/cards.py`); a reading is not repeated here, it belongs
 * to the look card, beside the place it was read from.
 */

import { useMemo, type FC } from 'react'
import { ScanSearch } from 'lucide-react'
import { PagePlaceButton } from '@/features/knowledge/components/page-place-button'
import { useTranslations, type Translator } from '@/i18n'
import { lookStepGroups, type LookStepGroup, type LookStepPlace } from '../../lib/look-steps'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'

/** A strip thumbnail's size, in CSS pixels. */
const STRIP_WIDTH = 132
const STRIP_MAX_HEIGHT = 96

const colorOf = (group: LookStepGroup): string => `var(--source-${group.document.shelf === 'base' ? 'law' : 'project'})`

/** „S. 2, oben rechts“. */
const placeLine = (t: Translator, look: LookStepPlace): string =>
  look.where
    ? t('thinking.look.place', { page: look.place.page, where: look.where })
    : t('thinking.look.placeWhole', { page: look.place.page })

/** „Angesehen: Grundriss EG.pdf, S. 2, oben rechts“, or the document and how many places. */
export const lookRowTitle = (t: Translator, group: LookStepGroup): string => {
  const [first] = group.looks
  const document = group.document.name
  if (group.looks.length > 1) return t('thinking.look.stepMany', { document, count: group.looks.length })
  return first.where
    ? t('thinking.look.step', { document, page: first.place.page, where: first.where })
    : t('thinking.look.stepWhole', { document, page: first.place.page })
}

export const LookStepRow: FC<{ group: LookStepGroup; eager?: boolean }> = ({ group, eager }) => {
  const t = useTranslations('chat')
  const color = colorOf(group)
  return (
    <li data-testid="look-step-row" className="flex min-w-0 flex-col gap-1.5">
      <p className="text-foreground flex min-w-0 items-start gap-1.5 text-xs font-medium">
        <ScanSearch aria-hidden className="text-muted-foreground mt-px size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{lookRowTitle(t, group)}</span>
      </p>
      <div className="flex gap-2 overflow-x-auto pb-1 pl-5">
        {group.looks.map((look) => (
          <PagePlaceButton
            key={look.id}
            place={look.place}
            color={color}
            label={t('cards.look.open', { document: group.document.name, page: look.place.page })}
            thumbnailWidth={STRIP_WIDTH}
            thumbnailMaxHeight={STRIP_MAX_HEIGHT}
            eager={eager}
            className="shrink-0"
          >
            {group.looks.length > 1 && (
              <span className="text-muted-foreground max-w-[132px] truncate px-0.5 text-xs">{placeLine(t, look)}</span>
            )}
          </PagePlaceButton>
        ))}
      </div>
    </li>
  )
}

/** Every look row of a turn, under the graph; nothing when the turn did not look. */
export const LookStepRows: FC<{ steps: readonly StoredThinkingStep[]; eager?: boolean }> = ({ steps, eager }) => {
  const groups = useMemo(() => lookStepGroups(steps), [steps])
  if (groups.length === 0) return null
  return (
    <ul data-testid="look-step-rows" className="flex flex-col gap-3">
      {groups.map((group) => (
        <LookStepRow key={group.key} group={group} eager={eager} />
      ))}
    </ul>
  )
}
