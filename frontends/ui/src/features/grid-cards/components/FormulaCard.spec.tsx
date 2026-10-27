/**
 * The formula card mounted: what the reader sees and does (ADR-0141).
 *
 * The arithmetic is `../lib/formulas.spec.ts`'s, against hand-computed cases.
 * What is asserted here is the part only a mounted tree shows:
 *
 *   1. A changed input recomputes the result and the verdict on the spot.
 *   2. A changed input is marked as the reader's assumption, with the source's
 *      value beside it, and „Zurücksetzen" restores the source.
 *   3. An unknown input is said, never guessed, and the card cannot judge.
 *   4. Nothing leaves the browser: no fetch, no send.
 *   5. Through the real A2UI renderer, the inputs live in the surface's data
 *      model: a variant's what-if survives switching tabs, which a component's
 *      own state would not.
 */

import { render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { gridCardSchema, type GridCard } from '@/shared/cards/schemas'
import { A2uiCard } from '@/features/a2ui/A2uiCard'
import { GridCardView } from './GridCards'
import { FormulaCard } from './FormulaCard'
import type { FormulaCardData } from '../lib/formulas'

const chatSendFn = vi.fn()
vi.mock('@/features/chat/store', () => {
  const state = () => ({ setComposerPrefill: vi.fn(), chatSendFn })
  const useChatStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state())
  useChatStore.getState = () => state()
  return { useChatStore }
})

const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => vi.unstubAllGlobals())

const OIB4 = { document: 'OIB-Richtlinie 4', section: 'Pkt. 3.2.1', edition: 'Ausgabe Mai 2023' }

const stair = (going: number | null = 29): FormulaCardData =>
  gridCardSchema.parse({
    type: 'formula',
    title: 'Schrittmaßregel – Stiege Haus A',
    formula: {
      name: 'stair_step_rule',
      riser: { value: 17, min: 10, max: 25, step: 0.5, source: 'Einreichplan, Schnitt A-A' },
      going: { value: going, min: 20, max: 40, step: 0.5, source: 'Einreichplan, Schnitt A-A' },
    },
    limits: [{ target: 'step_measure', comparator: 'between', value: 59, upper: 65, label: 'Schrittmaßregel', reference: OIB4 }],
  }) as FormulaCardData

const mount = (card: FormulaCardData) =>
  render(<FormulaCard title={card.title} formula={card.formula} limits={card.limits} note={card.note} />)

const riserField = () => screen.getByRole('spinbutton', { name: 'Stufenhöhe s' })
const checks = () => within(screen.getByRole('region', { name: 'Beurteilung' }))
/** A number in the Rechenweg: the result the card computed (the verdict row repeats it). */
const derived = (text: string) => within(screen.getByRole('region', { name: 'Rechenweg' })).getByText(text)

describe('FormulaCard', () => {
  it('prints the result it computed and judges it against the cited limit', () => {
    mount(stair())
    expect(derived('63')).toBeInTheDocument()
    expect(checks().getByText('erfüllt')).toBeInTheDocument()
    expect(checks().getByText(/OIB-Richtlinie 4 · Pkt\. 3\.2\.1/)).toBeInTheDocument()
    expect(screen.queryByText('Ihre Annahme')).toBeNull()
    expect(screen.queryByRole('button', { name: /zurücksetzen/i })).toBeNull()
  })

  it('recomputes on the spot when the reader changes an input, and marks it as theirs', async () => {
    const user = userEvent.setup()
    mount(stair())
    await user.clear(riserField())
    await user.type(riserField(), '19')

    // 2 × 19 + 29 = 67, outside 59–65: the verdict moved with the number.
    expect(derived('67')).toBeInTheDocument()
    expect(checks().getByText('nicht erfüllt')).toBeInTheDocument()
    expect(screen.getByText('Ihre Annahme')).toBeInTheDocument()
    expect(screen.getByText('Quelle: 17 cm')).toBeInTheDocument()
    expect(screen.getByText('Gerechnet mit Ihren Annahmen, nicht mit den Werten der Quelle.')).toBeInTheDocument()
    // The marker is part of the field's description, so a screen reader hears it.
    expect(riserField().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('restores the source values with „Zurücksetzen"', async () => {
    const user = userEvent.setup()
    mount(stair())
    await user.clear(riserField())
    await user.type(riserField(), '19')
    await user.click(screen.getByRole('button', { name: 'Alle Werte auf die Angaben der Quelle zurücksetzen' }))

    expect(riserField()).toHaveValue('17')
    expect(derived('63')).toBeInTheDocument()
    expect(screen.queryByText('Ihre Annahme')).toBeNull()
  })

  it('steps with the arrow keys by the card’s own step', async () => {
    const user = userEvent.setup()
    mount(stair())
    riserField().focus()
    await user.keyboard('{ArrowUp}')
    // 17 + 0,5 = 17,5; 2 × 17,5 + 29 = 64.
    expect(riserField()).toHaveValue('17,5')
    expect(derived('64')).toBeInTheDocument()
  })

  it('says it cannot judge without an input, and judges once the reader assumes one', async () => {
    const user = userEvent.setup()
    mount(stair(null))
    expect(checks().getByText('Ein Wert fehlt: Ohne ihn kann die Karte nicht beurteilen.')).toBeInTheDocument()

    await user.type(screen.getByRole('spinbutton', { name: 'Stufenauftritt a' }), '29')
    expect(derived('63')).toBeInTheDocument()
    expect(screen.getByText('Quelle: kein Wert')).toBeInTheDocument()
  })

  it('refuses text that is not a number, and a value outside the card’s bounds', async () => {
    const user = userEvent.setup()
    mount(stair())
    await user.clear(riserField())
    await user.type(riserField(), '1x')
    expect(riserField()).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Keine Zahl.')

    await user.clear(riserField())
    await user.type(riserField(), '40')
    expect(screen.getByRole('alert')).toHaveTextContent('Zulässig sind 10 bis 25 cm.')
  })

  it('shows an input the reader may not change as fixed, with no field', () => {
    const card = gridCardSchema.parse({
      type: 'formula',
      title: 'Lichteintrittsfläche – Wohnzimmer',
      formula: {
        name: 'daylight_ratio',
        glazing_area: { value: 3.1 },
        floor_area: { value: 25, editable: false, source: 'Raumbuch Top 3' },
      },
    }) as FormulaCardData
    mount(card)
    expect(screen.queryByRole('spinbutton', { name: 'Bodenfläche' })).toBeNull()
    expect(screen.getByText('fest')).toBeInTheDocument()
    expect(screen.getByText('Kein zitierter Grenzwert: Die Karte rechnet, beurteilt aber nichts.')).toBeInTheDocument()
  })

  it('takes an input without `editable` as editable, as the wire’s default says', () => {
    // A2UI hands a card component its props as written, without the schema's
    // defaults: only an explicit `false` may fix a value.
    const raw = {
      title: 'Gehweglänge',
      formula: { name: 'escape_route_length', segments: [{ label: 'Gang', length: { value: 18.5 } }] },
    } as unknown as FormulaCardData
    mount(raw)
    expect(screen.getByRole('spinbutton', { name: 'Gang, Länge' })).toHaveValue('18,5')
  })

  it('writes nothing anywhere: no fetch, no send', async () => {
    const user = userEvent.setup()
    mount(stair())
    await user.clear(riserField())
    await user.type(riserField(), '19')
    await user.click(screen.getByRole('button', { name: 'Alle Werte auf die Angaben der Quelle zurücksetzen' }))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(chatSendFn).not.toHaveBeenCalled()
  })
})

describe('reader inputs in the A2UI data model', () => {
  const asLeaf = (id: string, card: FormulaCardData) => {
    const { type, ...props } = card
    return { id, component: type, ...props }
  }
  const variants = {
    type: 'surface',
    components: [
      {
        id: 'root',
        component: 'Tabs',
        tabs: [
          { title: 'Variante A', child: 'a' },
          { title: 'Variante B', child: 'b' },
        ],
      },
      asLeaf('a', stair()),
      asLeaf('b', stair(30)),
    ],
  } as unknown as GridCard

  it('keeps a variant’s what-if across a tab switch, because the surface holds it', async () => {
    const user = userEvent.setup()
    render(
      <A2uiCard
        card={variants}
        surfaceKey="m1:formula"
        render={(leaf, leafId) => <GridCardView card={leaf} index={0} messageId="m1" leafId={leafId} />}
      />
    )
    const field = await screen.findByRole('spinbutton', { name: 'Stufenhöhe s' })
    await user.clear(field)
    await user.type(field, '19')
    expect(derived('67')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Variante B' }))
    await waitFor(() => expect(derived('64')).toBeInTheDocument()) // 2 × 17 + 30, B untouched
    await user.click(screen.getByRole('tab', { name: 'Variante A' }))
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Stufenhöhe s' })).toHaveValue('19'))
    expect(derived('67')).toBeInTheDocument()
    expect(screen.getByText('Ihre Annahme')).toBeInTheDocument()
  })
})

describe('the copy', () => {
  it('has every formula key in both dictionaries', () => {
    const keys = (node: unknown, prefix = ''): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node).flatMap(([key, value]) => keys(value, `${prefix}${key}.`))
        : [prefix.slice(0, -1)]
    const formulaOf = (dictionary: unknown) =>
      (dictionary as { chat: { cards: { formula: unknown } } }).chat.cards.formula
    expect(keys(formulaOf(en)).sort()).toEqual(keys(formulaOf(de)).sort())
    expect(keys(formulaOf(de))).toContain('yourAssumption')
    expect(keys(formulaOf(de))).toContain('reset')
  })
})
