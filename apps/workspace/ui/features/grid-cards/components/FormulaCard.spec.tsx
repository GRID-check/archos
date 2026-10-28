/**
 * The formula card mounted: what the reader sees and does (ADR-0143).
 *
 * The arithmetic is `../lib/formulas.spec.ts`'s, against hand-computed cases.
 * What is asserted here is the part only a mounted tree shows:
 *
 *   1. A changed input recomputes once the reader pauses or leaves the field,
 *      never mid-number: typing „19" does not judge „1".
 *   2. A changed input is marked as the reader's assumption beside the field,
 *      beside every verdict resting on it and beside the header's verdict;
 *      „Zurücksetzen" restores the source and stays mounted.
 *   3. The bound is the Richtlinie's row for the case the model named.
 *   4. An unknown input is said, never guessed; a refused entry is said as
 *      refused, not as missing.
 *   5. Nothing leaves the browser: no fetch, no send.
 *   6. Through the real A2UI renderer, the inputs live in the surface's data
 *      model: a variant's what-if survives switching tabs.
 */

import { render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { gridCardSchema, type GridCard } from '@/shared/cards/schemas'
import { A2uiCard } from '@/features/a2ui/A2uiCard'
import cases from '../lib/formula-cases.json'
import type { FormulaCardData } from '../lib/formulas'
import { GridCardView } from './GridCards'
import { FormulaCard } from './FormulaCard'

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

const fixtureCard = (id: string, patch?: (card: Record<string, unknown>) => void): FormulaCardData => {
  const entry = (cases.cases as Array<{ id: string; card?: unknown }>).find((item) => item.id === id)
  const card = structuredClone(entry?.card) as Record<string, unknown>
  patch?.(card)
  return gridCardSchema.parse(card) as FormulaCardData
}

const stair = (going: number | null = 29) =>
  fixtureCard('stair-main-within', (card) => {
    ;((card.formula as Record<string, unknown>).going as Record<string, unknown>).value = going
  })

const mount = (card: FormulaCardData) =>
  render(<FormulaCard title={card.title} formula={card.formula} note={card.note} />)

const riserField = () => screen.getByRole('spinbutton', { name: 'Stufenhöhe s' })
const checks = () => within(screen.getByRole('region', { name: 'Beurteilung' }))
/** A number in the Rechenweg: the result the card computed (the verdict row repeats it). */
const derived = (text: string) => within(screen.getByRole('region', { name: 'Rechenweg' })).getByText(text)
const resetButton = () => screen.getByRole('button', { name: 'Alle Werte auf die Angaben der Quelle zurücksetzen' })

/** Type into a field and leave it, which reports the value at once. */
const enter = async (user: ReturnType<typeof userEvent.setup>, field: HTMLElement, text: string) => {
  await user.clear(field)
  await user.type(field, text)
  await user.tab()
}

describe('FormulaCard', () => {
  it('prints the result it computed and judges it against the Richtlinie’s bound', () => {
    mount(stair())
    expect(derived('63')).toBeInTheDocument()
    expect(checks().getAllByText('erfüllt')).toHaveLength(3)
    expect(checks().getAllByText(/OIB-Richtlinie 4 · Pkt\. 3\.2\.1, Tabelle 3: Haupttreppen, ausgenommen Wohnungstreppen/)).toHaveLength(2)
    expect(screen.getByText('Haupttreppe')).toBeInTheDocument()
    expect(screen.queryByText('Ihre Annahme')).toBeNull()
    expect(resetButton()).toBeDisabled()
  })

  it('recomputes when the reader leaves the field, and marks the value as theirs everywhere it counts', async () => {
    const user = userEvent.setup()
    mount(stair())
    await enter(user, riserField(), '19')

    // 2 × 19 + 29 = 67, outside 59–65; 19 > 18: both verdicts moved with the number.
    expect(derived('67')).toBeInTheDocument()
    expect(checks().getAllByText('nicht erfüllt')).toHaveLength(2)
    expect(screen.getByText('Quelle: 17 cm')).toBeInTheDocument()
    expect(screen.getByText('Gerechnet mit Ihren Annahmen, nicht mit den Werten der Quelle.')).toBeInTheDocument()
    // Beside the field, beside the two verdicts that rest on the riser (not the Auftritt's), and in the header.
    expect(screen.getAllByText('Ihre Annahme')).toHaveLength(3)
    expect(checks().getAllByText('Ihre Annahme')).toHaveLength(2)
    expect(screen.getByText('mit Ihren Annahmen')).toBeInTheDocument()
    expect(riserField().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('does not judge a number while it is being typed', async () => {
    const user = userEvent.setup()
    mount(stair())
    await user.clear(riserField())
    await user.type(riserField(), '1')
    // „1" is below the field's 10, but the reader has not finished: nothing moved, nothing announced.
    expect(derived('63')).toBeInTheDocument()
    expect(screen.queryByText('Zulässig sind 10 bis 25 cm.')).toBeNull()
    await user.type(riserField(), '9')
    await waitFor(() => expect(derived('67')).toBeInTheDocument())
    expect(screen.queryByText('Zulässig sind 10 bis 25 cm.')).toBeNull()
  })

  it('says a refused entry is refused, not that a value is missing', async () => {
    const user = userEvent.setup()
    mount(stair())
    await enter(user, riserField(), '40')
    expect(riserField()).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Zulässig sind 10 bis 25 cm.')).toBeInTheDocument()
    expect(checks().getAllByText('Ein eingegebener Wert ist nicht zulässig: Mit ihm kann die Karte nicht beurteilen.')).toHaveLength(2)
    expect(screen.queryByText('Ein Wert fehlt: Ohne ihn kann die Karte nicht beurteilen.')).toBeNull()

    await enter(user, riserField(), '1x')
    expect(screen.getByText('Keine Zahl.')).toBeInTheDocument()
  })

  it('restores the source values with „Zurücksetzen", which stays mounted for the keyboard', async () => {
    const user = userEvent.setup()
    mount(stair())
    await enter(user, riserField(), '19')
    expect(resetButton()).toBeEnabled()
    await user.click(resetButton())

    expect(riserField()).toHaveValue('17')
    expect(derived('63')).toBeInTheDocument()
    expect(screen.queryByText('Ihre Annahme')).toBeNull()
    expect(resetButton()).toBeInTheDocument()
    expect(resetButton()).toBeDisabled()
  })

  it('clears a refused entry on „Zurücksetzen" even where the source gives no value', async () => {
    // The source has no Auftritt, and „1x" reports null too: a reset that only
    // follows the value would leave the text and its error on screen.
    const user = userEvent.setup()
    mount(stair(null))
    const going = () => screen.getByRole('spinbutton', { name: 'Stufenauftritt a' })
    await enter(user, going(), '1x')
    expect(screen.getByText('Keine Zahl.')).toBeInTheDocument()
    expect(resetButton()).toBeEnabled()
    await user.click(resetButton())
    expect(going()).toHaveValue('')
    expect(going()).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText('Keine Zahl.')).toBeNull()
    expect(resetButton()).toBeDisabled()
  })

  it('steps with the arrow keys by the card’s own step, at once', async () => {
    const user = userEvent.setup()
    mount(stair())
    riserField().focus()
    await user.keyboard('{ArrowUp}')
    // 17 + 0,5 = 17,5; 2 × 17,5 + 29 = 64.
    expect(riserField()).toHaveValue('17,5')
    expect(derived('64')).toBeInTheDocument()
  })

  it('says it cannot judge without an input, and judges once the reader enters one', async () => {
    const user = userEvent.setup()
    mount(stair(null))
    expect(checks().getAllByText('Ein Wert fehlt: Ohne ihn kann die Karte nicht beurteilen.')).toHaveLength(2)
    await enter(user, screen.getByRole('spinbutton', { name: 'Stufenauftritt a' }), '29')
    expect(derived('63')).toBeInTheDocument()
    expect(screen.getByText('Quelle: kein Wert')).toBeInTheDocument()
  })

  it('takes the bound from the row of Tabelle 3 for the stair type the model named', () => {
    mount(fixtureCard('stair-dwelling'))
    // s 19 passes the Wohnungstreppe's 20 cm that a Haupttreppe's 18 cm would fail.
    expect(screen.getByText('Wohnungstreppe')).toBeInTheDocument()
    expect(checks().getByText('≤ 20 cm')).toBeInTheDocument()
    expect(checks().getAllByText(/Tabelle 3: Wohnungstreppen/)).toHaveLength(2)
    expect(checks().getAllByText('erfüllt')).toHaveLength(3)
  })

  it('refuses λ = 0 in the field, in the rule’s own words', async () => {
    const user = userEvent.setup()
    mount(fixtureCard('u-value-roof'))
    await enter(user, screen.getByRole('spinbutton', { name: 'Mineralwolle, Wärmeleitfähigkeit λ' }), '0')
    expect(screen.getByText('λ = 0 ist nicht möglich.')).toBeInTheDocument()
  })

  it('states the Neubau row and Pkt. 4.5 on a U-value, and prints R_T at one precision', () => {
    mount(fixtureCard('u-value-external-wall'))
    expect(screen.getByText(/Zeile 1\)\. Bei der Renovierung mittels Einzelmaßnahmen gilt Pkt\. 4\.5\./)).toBeInTheDocument()
    // R_T printed as its line's result and as the U line's operand, both at four fixed decimals.
    const rechenweg = within(screen.getByRole('region', { name: 'Rechenweg' }))
    expect(rechenweg.getAllByText('5,9911')).toHaveLength(2)
    expect(rechenweg.getAllByText('5,7143')).toHaveLength(2)
    // The source's λ prints as written, not rounded to the house two decimals.
    expect(rechenweg.getByText('0,035')).toBeInTheDocument()
  })

  it('raises the required daylight share under a balcony, and always states the 45° precondition', async () => {
    const user = userEvent.setup()
    mount(fixtureCard('daylight-above-12-percent'))
    expect(screen.getByText(/freier Lichteinfall unter 45°/)).toBeInTheDocument()
    expect(checks().getByText('≥ 12 %')).toBeInTheDocument()
    await enter(user, screen.getByRole('spinbutton', { name: 'Auskragung' }), '2')
    expect(checks().getByText('≥ 15 %')).toBeInTheDocument()
    expect(checks().getByText('nicht erfüllt')).toBeInTheDocument()
    expect(screen.getByText('vorgegeben')).toBeInTheDocument()
  })

  it('holds a renovation to Pkt. 4.5 b), 24 % under the table, and lets the reader find the insulation that meets it', async () => {
    const user = userEvent.setup()
    mount(fixtureCard('u-value-renovation'))
    expect(screen.getByText('Außenwand gegen Außenluft · Renovierung')).toBeInTheDocument()
    expect(checks().getByText('≤ 0,266 W/(m²K)')).toBeInTheDocument()
    expect(checks().getByText(/Pkt\. 4\.5 b\) mit Pkt\. 4\.4\.1, Zeile 1/)).toBeInTheDocument()
    // The row says it is the bound WITHOUT a Sanierungskonzept.
    expect(checks().getByText('U-Wert, ohne Sanierungskonzept')).toBeInTheDocument()
    expect(checks().getByText('nicht erfüllt')).toBeInTheDocument()
    expect(screen.getByText(/ohne Sanierungskonzept \(Pkt\. 4\.5 b\)/)).toBeInTheDocument()
    await enter(user, screen.getByRole('spinbutton', { name: 'EPS-F, Dicke d' }), '14')
    expect(checks().getByText('erfüllt')).toBeInTheDocument()
  })

  it('cannot judge a U-value when neither new build nor renovation is stated, and says why', () => {
    mount(fixtureCard('u-value-measure-unknown'))
    expect(checks().getByText('Neubau oder Renovierung ist nicht angegeben: Ohne das kann die Karte nicht beurteilen.')).toBeInTheDocument()
    expect(checks().getByText('Angabe fehlt')).toBeInTheDocument()
  })

  it('computes a größere Renovierung’s U-value without judging it against a table it is not held to', () => {
    mount(fixtureCard('u-value-major-renovation'))
    expect(screen.getByText('Außenwand gegen Außenluft · Größere Renovierung')).toBeInTheDocument()
    expect(checks().getByText(/Energiekennzahlen gemessen \(Pkt\. 4\.3\)/)).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Rechenweg' })).getByText('0,270')).toBeInTheDocument()
  })

  it('cites ÖNORM EN ISO 6946 by its edition, with no unverified clause', () => {
    mount(fixtureCard('u-value-external-wall'))
    expect(screen.getByText('EN ISO 6946:2017')).toBeInTheDocument()
    expect(screen.queryByText(/Abschnitt 6\.8/)).toBeNull()
  })

  it('writes a percentage line with its × 100, and the daylight card’s scope and light angle', () => {
    mount(fixtureCard('daylight-above-12-percent'))
    expect(within(screen.getByRole('region', { name: 'Rechenweg' })).getByText('× 100')).toBeInTheDocument()
    expect(screen.getByText(/Gilt für Aufenthaltsräume \(Pkt\. 9\.1\.1\)/)).toBeInTheDocument()
    expect(screen.getByText(/seitlich höchstens 30° verschwenkt/)).toBeInTheDocument()
    expect(screen.getByText(/Wintergarten oder eine verglaste Loggia vorgelagert/)).toBeInTheDocument()
  })

  it('says on an escape route that only OIB-RL 2 is modelled', () => {
    mount(fixtureCard('route-within-40-m'))
    expect(screen.getByText(/Abgebildet ist nur OIB-Richtlinie 2\./)).toBeInTheDocument()
  })

  it('tells a screen reader each verdict with its quantity and bound once it is recomputed', async () => {
    const user = userEvent.setup()
    const { container } = mount(stair())
    const live = container.querySelector('[aria-live="polite"].sr-only') as HTMLElement
    expect(live).toHaveTextContent('')
    await enter(user, riserField(), '19')
    expect(live).toHaveTextContent('Schrittmaßregel 62 ± 3 cm: 67 cm, Grenzwert 59–65 cm, nicht erfüllt.')
    expect(live).toHaveTextContent('Stufenhöhe: 19 cm, Grenzwert ≤ 18 cm, nicht erfüllt.')
  })

  it('takes an input without `editable` as editable, as the wire’s default says', () => {
    const raw = {
      title: 'Fluchtweg',
      formula: { name: 'escape_route_length', start: 'room', segments: [{ label: 'Gang', length: { value: 18.5 } }] },
    } as unknown as FormulaCardData
    mount(raw)
    expect(screen.getByRole('spinbutton', { name: 'Gang, Länge' })).toHaveValue('18,5')
  })

  it('writes nothing anywhere: no fetch, no send', async () => {
    const user = userEvent.setup()
    mount(stair())
    await enter(user, riserField(), '19')
    await user.click(resetButton())
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
    await enter(user, field, '19')
    expect(derived('67')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Variante B' }))
    await waitFor(() => expect(derived('64')).toBeInTheDocument()) // 2 × 17 + 30, B untouched
    await user.click(screen.getByRole('tab', { name: 'Variante A' }))
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Stufenhöhe s' })).toHaveValue('19'))
    expect(derived('67')).toBeInTheDocument()
  })
})

describe('the copy', () => {
  it('has every formula key in both dictionaries', () => {
    const keys = (node: unknown, prefix = ''): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node).flatMap(([key, value]) => keys(value, `${prefix}${key}.`))
        : [prefix.slice(0, -1)]
    const formulaOf = (chat: unknown) => (chat as { cards: { formula: unknown } }).cards.formula
    expect(keys(formulaOf(chatCopy.messages.en)).sort()).toEqual(keys(formulaOf(chatCopy.messages.de)).sort())
    expect((chatCopy.messages.de as unknown as { cards: { formula: { eyebrow: string } } }).cards.formula.eyebrow).toBe('Was wäre, wenn')
  })
})
