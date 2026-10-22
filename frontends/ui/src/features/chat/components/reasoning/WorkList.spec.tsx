/**
 * The work list as the Herleitung draws it (ADR-0131): rounds with a header,
 * one row per call, bars on the shared axis, an error in the error tone, a
 * click that opens the document, and a listing that opens nothing.
 */
import type { ReactElement } from 'react'
import { render as renderPlain, screen, within } from '@/test-utils'
import { I18nProvider } from '@/i18n/context'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { fakePdfjsRuntime, type FakePdfState } from '@/test-utils/pdfjs-fake'
import { foldScene, northStarLiveScene, northStarScene } from '@/test-utils/work-list-scenes'
import { storedSteps } from '@/test-utils/wire-v2-steps'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import { placedLookIds, workRounds } from '../../lib/work-list'
import { planFan, ReasoningFlow, buildGraph } from './ReasoningFlow'
import { RoundCalls, RoundMeta, placeOfAction } from './WorkList'

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
  test('draws a row per call with its sentence, and a header meta with concurrency and time', () => {
    const restore = installLayoutObservers()
    const [first] = rounds(foldScene(northStarScene()))
    render(
      <>
        <RoundMeta round={first} />
        <RoundCalls round={first} eager />
      </>
    )
    expect(screen.getByTestId('work-round-meta')).toHaveTextContent('3 gleichzeitig · 2,4 s')
    const items = screen.getAllByTestId('work-row')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent(
      'Sucht im Projekt wörtlich „Brandabschnitt“ · 14 Treffer in 3 von 212 Dokumenten'
    )
    expect(items[1]).toHaveTextContent('Öffnet 03 Einreichung › Pläne · 12 Dateien, 2 Ordner')
    expect(items[2]).toHaveTextContent(
      'Sucht im Basiswissen „Brandabschnitte Fläche“ · 6 Treffer in 2 Dokumenten'
    )
    restore()
  })

  test('the look call carries its crop thumbnail, the read call its pages', () => {
    const restore = installLayoutObservers()
    const second = rounds(foldScene(northStarScene()))[1]
    render(<RoundCalls round={second} eager />)
    const items = screen.getAllByTestId('work-row')
    expect(items[0]).toHaveTextContent('Liest Einreichplan EG.pdf, S. 2-3')
    expect(within(items[1]).getByTestId('page-place-button')).toBeInTheDocument()
    restore()
  })

  test('puts each bar where the data says', () => {
    render(<RoundCalls round={rounds(foldScene(northStarScene()))[0]} />)
    const bars = screen.getAllByTestId('work-bar')
    expect(bars[0]).toHaveStyle({ left: '0%' })
    expect(bars[1].style.left).toBe(`${(100 / 2400) * 100}%`)
  })

  test('a running round has no time in its meta and its rows say so', () => {
    const live = rounds(foldScene(northStarLiveScene()))[1]
    render(
      <>
        <RoundMeta round={live} />
        <RoundCalls round={live} />
      </>
    )
    expect(screen.getByTestId('work-round-meta')).toHaveTextContent(/^· 2 gleichzeitig$/)
    const running = screen
      .getAllByTestId('work-row')
      .filter((row) => row.dataset.status === 'running')
    expect(running).toHaveLength(2)
  })

  test('an error row is drawn in the error tone', () => {
    const steps = storedSteps([
      {
        id: 'a',
        call_id: 'c',
        kind: 'action',
        verb: 'read',
        round: 1,
        target: 'EG.pdf',
        status: 'error',
        elapsed_ms: 300,
      },
    ])
    render(<RoundCalls round={rounds(steps)[0]} />)
    expect(screen.getByTestId('work-row')).toHaveTextContent('Liest EG.pdf · fehlgeschlagen')
    expect(screen.getByText(/fehlgeschlagen/)).toHaveClass('text-error')
  })

  test('a document row opens the document; a listing opens nothing', async () => {
    const restore = installLayoutObservers()
    render(<RoundCalls round={rounds(foldScene(northStarScene()))[0]} />)
    const [list] = screen.getAllByTestId('work-row').filter((row) => row.dataset.verb === 'list')
    expect(within(list).queryByRole('button')).toBeNull()
    restore()
    const restoreSecond = installLayoutObservers()
    render(<RoundCalls round={rounds(foldScene(northStarScene()))[1]} />)
    await userEvent.click(screen.getAllByRole('button', { name: 'Einreichplan EG.pdf öffnen' })[0])
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    restoreSecond()
  })
})

describe('the calls inside the graph', () => {
  test("buildGraph puts each round's calls on its round node, even for a single round", () => {
    const t = createTranslator(de, 'chat')
    const steps = foldScene(northStarScene())
    const graph = buildGraph({ steps, userQuestion: 'Frage?' }, t, planFan(680, 0), [])
    const roundNodes = graph.nodes.filter((node) => node.type === 'round')
    expect(
      roundNodes.map((node) => (node.data as { calls?: { rows: unknown[] } }).calls?.rows.length)
    ).toEqual([3, 2])
    // the looks are drawn by their round, so the bare look rows have nothing left
    expect(placedLookIds(workRounds(steps)).size).toBe(1)
  })

  test('ReasoningFlow draws the rows in the graph and no second look block', () => {
    const restore = installLayoutObservers()
    render(<ReasoningFlow steps={foldScene(northStarScene())} userQuestion="Frage?" />)
    expect(screen.getAllByTestId('work-row')).toHaveLength(5)
    expect(screen.queryByTestId('look-step-rows')).toBeNull()
    expect(screen.getAllByTestId('work-round-meta')[0]).toHaveTextContent('3 gleichzeitig')
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
