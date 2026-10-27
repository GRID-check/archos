'use client'

/**
 * Dev preview — the formula card, the what-if on a computing card (ADR-0143).
 *
 * Every card goes through the chat's own path (`GridCardItem` → A2UI on the
 * Piloti catalog), so a changed input lands in the surface's data model exactly
 * as it does in an answer. The four rules, each in the state worth judging:
 *
 *  1. **U-Wert, Außenwand.** The north-star question: change the Dämmstärke and
 *     watch U, the Rechenweg and the verdict against OIB-RL 6 move. Try 4 cm.
 *  2. **Schrittmaßregel, an input missing.** The Auftritt is not in the source:
 *     the card cannot judge the Schrittmaß until the reader assumes one, while
 *     the Stufenhöhe is already judged.
 *  3. **Gehweglänge.** Three legs against OIB-RL 2's 40 m.
 *  4. **Lichteintrittsfläche.** The Bodenfläche is fixed (not a design choice
 *     in this question); only the window can change.
 *  5. **Two variants in tabs.** Each tab keeps its own what-if when you switch.
 *
 * What the screenshot is FOR: that a changed value reads as the reader's
 * assumption at a glance, with the source's value beside it, and that the
 * cited limit has no control. Pinned to German. 404s outside development.
 */

import { I18nProvider } from '@/i18n'
import { GridCardItem } from '@/features/grid-cards/components/GridCards'
import type { GridCard } from '@/shared/cards/schemas'

const OIB = (guideline: string, section: string) => ({ document: `OIB-Richtlinie ${guideline}`, section, edition: 'Ausgabe Mai 2023' })

const WALL = {
  type: 'formula',
  title: 'U-Wert Außenwand AW 01 – 20 cm Dämmung',
  formula: {
    name: 'u_value',
    heat_flow: 'horizontal',
    layers: [
      { label: 'Innenputz', thickness: { value: 1.5, source: 'Wandaufbau AW 01' }, conductivity: { value: 0.7, source: 'Produktdatenblatt' } },
      { label: 'Stahlbeton', thickness: { value: 18, source: 'Wandaufbau AW 01' }, conductivity: { value: 2.3, source: 'Produktdatenblatt' } },
      {
        label: 'EPS-F',
        thickness: { value: 20, min: 0, max: 40, step: 1, source: 'Wandaufbau AW 01' },
        conductivity: { value: 0.035, step: 0.001, source: 'Produktdatenblatt' },
      },
      { label: 'Außenputz', thickness: { value: 0.5, source: 'Wandaufbau AW 01' }, conductivity: { value: 0.7, source: 'Produktdatenblatt' } },
    ],
  },
  limits: [{ target: 'u_value', comparator: '<=', value: 0.35, label: 'Wände gegen Außenluft', reference: OIB('6', 'Pkt. 4.4.1') }],
  note: 'Homogene Schichten, ohne Korrekturen für Befestigungen oder Luftschichten.',
}

const STAIR = {
  type: 'formula',
  title: 'Schrittmaßregel – Stiege Haus B',
  formula: {
    name: 'stair_step_rule',
    riser: { value: 17.5, min: 10, max: 25, step: 0.5, source: 'Einreichplan, Schnitt B-B' },
    going: { value: null, min: 20, max: 40, step: 0.5 },
  },
  limits: [
    { target: 'step_measure', comparator: 'between', value: 59, upper: 65, label: 'Schrittmaßregel', reference: OIB('4', 'Pkt. 3.2.1') },
    { target: 'riser', comparator: '<=', value: 18, label: 'Stufenhöhe', reference: OIB('4', 'Pkt. 3.2.1, Tabelle 3') },
    { target: 'going', comparator: '>=', value: 27, label: 'Stufenauftritt', reference: OIB('4', 'Pkt. 3.2.1, Tabelle 3') },
  ],
}

const ROUTE = {
  type: 'formula',
  title: 'Gehweglänge – Büro 2.14 bis Treppenhaus',
  formula: {
    name: 'escape_route_length',
    segments: [
      { label: 'Büro 2.14 → Gangtür', length: { value: 12, step: 0.5, source: 'Grundriss 2. OG' } },
      { label: 'Gang', length: { value: 18.5, step: 0.5, source: 'Grundriss 2. OG' } },
      { label: 'Vorraum → Treppenhaus', length: { value: 6, step: 0.5, source: 'Grundriss 2. OG' } },
    ],
  },
  limits: [{ target: 'route_length', comparator: '<=', value: 40, label: 'Gehweglänge', reference: OIB('2', 'Pkt. 5.1.1') }],
}

const DAYLIGHT = {
  type: 'formula',
  title: 'Lichteintrittsfläche – Wohnzimmer Top 3',
  formula: {
    name: 'daylight_ratio',
    glazing_area: { value: 3.1, step: 0.05, source: 'Fensterliste, Architekturlichte' },
    floor_area: { value: 25, editable: false, source: 'Raumbuch Top 3' },
  },
  limits: [{ target: 'daylight_ratio', comparator: '>=', value: 12, label: 'Lichteintrittsfläche', reference: OIB('3', 'Pkt. 9.1.1') }],
}

const leaf = (id: string, card: Record<string, unknown>) => {
  const { type, ...props } = card
  return { id, component: type, ...props }
}

const VARIANTS = {
  type: 'surface',
  title: 'Außenwand – zwei Varianten',
  components: [
    {
      id: 'root',
      component: 'Tabs',
      tabs: [
        { title: 'EPS 20 cm', child: 'eps' },
        { title: 'Mineralwolle 16 cm', child: 'mw' },
      ],
    },
    leaf('eps', WALL),
    leaf('mw', {
      ...WALL,
      title: 'U-Wert Außenwand AW 01 – 16 cm Mineralwolle',
      formula: {
        ...WALL.formula,
        layers: WALL.formula.layers.map((layer, index) =>
          index === 2
            ? {
                label: 'Mineralwolle',
                thickness: { value: 16, min: 0, max: 40, step: 1, source: 'Variante B' },
                conductivity: { value: 0.035, step: 0.001, source: 'Produktdatenblatt' },
              }
            : layer
        ),
      },
    }),
  ],
}

const CARDS = [WALL, STAIR, ROUTE, DAYLIGHT, VARIANTS] as unknown as GridCard[]

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
