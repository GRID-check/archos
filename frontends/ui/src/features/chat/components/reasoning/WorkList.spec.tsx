/**
 * The work list as the Herleitung draws it (ADR-0131): one row per call, the
 * verb muted before its object and the result beside it; status as a shape and
 * a word, never a colour; a tap that links a row to its cards; a row stored
 * before call ids opening its document as it did; no time anywhere.
 */
import type { ReactElement } from 'react'
import { render as renderPlain, screen, within } from '@/test-utils'
import { I18nProvider } from '@/i18n/context'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { fakePdfjsRuntime, type FakePdfState } from '@/test-utils/pdfjs-fake'
import {
  foldScene,
  mockupCitations,
  mockupScene,
  northStarLiveScene,
  northStarScene,
} from '@/test-utils/work-list-scenes'
import { storedSteps } from '@/test-utils/wire-v2-steps'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import { placedLookIds, workRounds } from '../../lib/work-list'
import { planFan, ReasoningFlow, buildGraph } from './ReasoningFlow'
import { RoundCalls, placeOfAction } from './WorkList'

const state = vi.hoisted((): FakePdfState => ({
  fail: false,
  pages: [{ items: [] }, { items: [] }],
  destroyed: 0,
}))
vi.mock('@/features/knowledge/lib/pdfjs-runtime', () => fakePdfjsRuntime(state))

/** The Herleitung in German, as the office reads it. */
const render = (ui: ReactElement) =>
  renderPlain(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

const rounds = (steps: ReturnType<typeof foldScene>) => workRounds(steps)

describe('RoundCalls', () => {
  test('a row is verb, object and result; no time and no bar', () => {
    const restore = installLayoutObservers()
    const [first] = rounds(foldScene(northStarScene()))
    render(<RoundCalls round={first} eager />)
    const items = screen.getAllByTestId('work-row')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent(
      'Sucht wörtlich „Brandabschnitt“ im Projekt14 Treffer · 3 Dokumente'
    )
    expect(items[1]).toHaveTextContent('Öffnet 03 Einreichung › Pläne12 Dateien, 2 Ordner')
    expect(screen.queryByTestId('work-bar')).toBeNull()
    expect(document.body).not.toHaveTextContent(/\d,\d s|gleichzeitig/)
    restore()
  })

  test('the look call carries its crop, read off and not measured; the read its pages', () => {
    const restore = installLayoutObservers()
    const second = rounds(foldScene(northStarScene()))[1]
    render(<RoundCalls round={second} eager />)
    const items = screen.getAllByTestId('work-row')
    expect(items[0]).toHaveTextContent('Liest Einreichplan EG.pdf, S. 2–3')
    expect(within(items[1]).getByTestId('page-place-button')).toBeInTheDocument()
    expect(items[1]).toHaveTextContent('abgelesen, nicht gemessen')
    restore()
  })

  test('a running row says so in a word', () => {
    const live = rounds(foldScene(northStarLiveScene()))[1]
    render(<RoundCalls round={live} />)
    const running = screen
      .getAllByTestId('work-row')
      .filter((row) => row.dataset.status === 'running')
    expect(running).toHaveLength(2)
    expect(running[0]).toHaveTextContent('läuft')
  })

  test('a failed row says so with a shape and a word, never the error colour', () => {
    const steps = storedSteps([
      {
        id: 'a',
        call_id: 'c',
        kind: 'action',
        verb: 'law',
        round: 1,
        query: 'Wiener Garagengesetz 2008',
        status: 'error',
        elapsed_ms: 300,
      },
    ])
    render(<RoundCalls round={rounds(steps)[0]} />)
    const result = screen.getByTestId('work-row-result')
    expect(result).toHaveTextContent('fehlgeschlagen · die Antwort stützt sich nicht darauf')
    expect(result.querySelector('svg')).not.toBeNull()
    expect(result.className).not.toMatch(/text-error/)
  })

  test('a row with a call id is a button that links; its name is the sentence', async () => {
    const onSelect = vi.fn()
    const [first] = rounds(foldScene(mockupScene()))
    const { rerender } = render(
      <RoundCalls round={first} linking={{ selection: null, onSelect }} />
    )
    const button = screen.getByRole('button', {
      name: 'Sucht wörtlich „Brandabschnitt“ im Projekt: 14 Treffer · 3 Dokumente',
    })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith({ key: 'call:c1', callIds: ['call:c1'] })
    rerender(
      <I18nProvider initialLocale="de" fixedLocale>
        <RoundCalls
          round={first}
          linking={{ selection: { key: 'call:c1', callIds: ['call:c1'] }, onSelect }}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('button', { name: /^Sucht wörtlich/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    // a second tap clears it
    await userEvent.click(screen.getByRole('button', { name: /^Sucht wörtlich/ }))
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  test('a row stored before call ids opens its document; a listing opens nothing', async () => {
    const restore = installLayoutObservers()
    const old = foldScene(northStarScene()).map((step) => ({ ...step, callId: undefined }))
    render(<RoundCalls round={rounds(old)[0]} linking={{ selection: null, onSelect: () => {} }} />)
    const [list] = screen.getAllByTestId('work-row').filter((row) => row.dataset.verb === 'list')
    expect(within(list).queryByRole('button')).toBeNull()
    restore()
    const restoreSecond = installLayoutObservers()
    render(<RoundCalls round={rounds(old)[1]} />)
    await userEvent.click(screen.getAllByRole('button', { name: 'Einreichplan EG.pdf öffnen' })[0])
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    restoreSecond()
  })
})

describe('the calls inside the graph', () => {
  const t = createTranslator(de, 'chat')

  test("buildGraph puts each round's calls on its round node, even for a single round", () => {
    const steps = foldScene(northStarScene())
    const graph = buildGraph({ steps, userQuestion: 'Frage?' }, t, planFan(680, 0), [])
    const roundNodes = graph.nodes.filter((node) => node.type === 'round')
    expect(
      roundNodes.map((node) => (node.data as { calls?: { rows: unknown[] } }).calls?.rows.length)
    ).toEqual([3, 2])
    // the looks are drawn by their round, so the bare look rows have nothing left
    expect(placedLookIds(workRounds(steps)).size).toBe(1)
  })

  test('ReasoningFlow draws the rows in the graph, no second look block, and no round time', () => {
    const restore = installLayoutObservers()
    render(<ReasoningFlow steps={foldScene(northStarScene())} userQuestion="Frage?" />)
    expect(screen.getAllByTestId('work-row')).toHaveLength(5)
    expect(screen.queryByTestId('look-step-rows')).toBeNull()
    expect(screen.queryByTestId('work-round-meta')).toBeNull()
    restore()
  })

  test('tapping a row keeps its cards bright and sets the others back; tapping it again clears it', async () => {
    const restore = installLayoutObservers()
    render(
      <ReasoningFlow
        steps={foldScene(mockupScene())}
        userQuestion="Frage?"
        citations={mockupCitations()}
      />
    )
    const read = screen.getByRole('button', { name: /^Liest Einreichplan EG\.pdf/ })
    await userEvent.click(read)
    const cards = screen
      .getAllByRole('listitem')
      .filter((el) => el.hasAttribute('data-source-card'))
    const linkOf = (name: RegExp) =>
      cards.find((card) => name.test(card.textContent ?? ''))?.dataset.link
    expect(linkOf(/Einreichplan EG/)).toBe('linked')
    expect(linkOf(/Brandschutzkonzept/)).toBe('receded')
    expect(read).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(read)
    expect(linkOf(/Einreichplan EG/)).toBeUndefined()
    restore()
  })

  test('tapping a card lights up the row of the call that returned it', async () => {
    const restore = installLayoutObservers()
    render(
      <ReasoningFlow
        steps={foldScene(mockupScene())}
        userQuestion="Frage?"
        citations={mockupCitations()}
      />
    )
    const concept = screen
      .getAllByRole('listitem')
      .find(
        (el) =>
          el.hasAttribute('data-source-card') && /Brandschutzkonzept/.test(el.textContent ?? '')
      )!
    // The preview chip inside is the button; the tap bubbles to the card.
    await userEvent.click(concept)
    expect(screen.getByRole('button', { name: /^Sucht wörtlich/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: /^Liest Einreichplan/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    restore()
  })
})

describe('placeOfAction', () => {
  test('addresses a stored document by id and a corpus document by name; a folder or an unknown document by nothing', () => {
    expect(
      placeOfAction({ verb: 'read', status: 'ok', target: 'A.pdf', documentId: 'd1', pages: '4' })
    ).toMatchObject({
      document: { id: 'd1', name: 'A.pdf', shelf: 'stored' },
      page: 4,
    })
    expect(
      placeOfAction({
        verb: 'read',
        status: 'ok',
        target: 'OIB 2',
        shelf: 'base',
        pages: 'Pkt. 3.5',
      })
    ).toMatchObject({
      document: { id: null, shelf: 'base' },
      page: 1,
    })
    expect(placeOfAction({ verb: 'list', status: 'ok', target: 'A', documentId: 'd1' })).toBeNull()
    expect(placeOfAction({ verb: 'read', status: 'ok', target: 'A.pdf' })).toBeNull()
  })
})
