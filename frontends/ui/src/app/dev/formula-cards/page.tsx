'use client'

/**
 * Dev preview — the formula card, the what-if on a computing card (ADR-0143).
 *
 * The cards are the fixture's own (`features/grid-cards/lib/formula-cases.json`,
 * the cases marked `preview`), the ones `formulas.spec.ts` computes by hand, so
 * this page cannot drift into showing a card the tests do not cover. Each goes
 * through the chat's own path (`GridCardItem` → A2UI on the Piloti catalog), so
 * a changed input lands in the surface's data model exactly as in an answer.
 * The last panel puts two of them in tabs: each keeps its own what-if when you
 * switch.
 *
 * What the screenshot is FOR: that a changed value reads as the reader's
 * assumption at a glance (beside the field, beside each verdict resting on it,
 * beside the header's verdict), with the source's value beside it, and that the
 * bound names its Punkt and row and has no control. Pinned to German. 404s
 * outside development.
 */

import { I18nProvider } from '@/i18n'
import { GridCardItem } from '@/features/grid-cards/components/GridCards'
import cases from '@/features/grid-cards/lib/formula-cases.json'
import type { GridCard } from '@/shared/cards/schemas'

type Card = Record<string, unknown> & { type: string }

const previews = (cases.cases as Array<{ id: string; preview?: boolean; card?: unknown }>)
  .filter((entry) => entry.preview && entry.card)
  .map((entry) => ({ id: entry.id, card: entry.card as Card }))

const leaf = (id: string, card: Card) => {
  const { type, ...props } = card
  return { id, component: type, ...props }
}

const byId = (id: string): Card => previews.find((entry) => entry.id === id)?.card as Card

const VARIANTS = {
  type: 'surface',
  title: 'Zwei Fälle in Tabs',
  components: [
    {
      id: 'root',
      component: 'Tabs',
      tabs: [
        { title: 'Außenwand', child: 'wall' },
        { title: 'Stiege', child: 'stair' },
      ],
    },
    leaf('wall', byId('u-value-external-wall')),
    leaf('stair', byId('stair-main-within')),
  ],
}

const CARDS = [...previews.map((entry) => entry.card), VARIANTS] as unknown as GridCard[]

export default function FormulaCardsPreview() {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div data-testid="formula-cards-preview" className="flex min-h-screen flex-col items-center gap-8 bg-background px-4 py-8 sm:p-10">
        {CARDS.map((card, index) => (
          <section key={index} className="flex w-[680px] max-w-full flex-col gap-2" data-preview-index={index}>
            <GridCardItem card={card} index={index} messageId={`preview-${index}`} />
          </section>
        ))}
      </div>
    </I18nProvider>
  )
}
