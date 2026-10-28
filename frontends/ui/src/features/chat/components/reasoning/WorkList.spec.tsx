/**
 * The work list as the Herleitung draws it (ADR-0132): one row per call, the
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
  filesystemEdgesScene,
  filesystemScene,
  foldScene,
  mockupCitations,
  mockupScene,
  northStarLiveScene,
  northStarScene,
} from '@/test-utils/work-list-scenes'
import { storedSteps } from '@/test-utils/wire-v2-steps'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries'
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

/** The no-break space the copy binds a number to its noun with. */
const NB = '\u00A0'

describe('RoundCalls', () => {
  test('a row is verb, object and result; no time and no bar', () => {
    const restore = installLayoutObservers()
    const [first] = rounds(foldScene(northStarScene()))
    render(<RoundCalls round={first} eager />)
    const items = screen.getAllByTestId('work-row')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent(
      'Sucht wörtlich „Brandabschnitt“ im Projekt14 Treffer in 3 Dokumenten'
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
    // The right edge holds the word alone; what it means sits under the object.
    expect(result.textContent).toBe('fehlgeschlagen')
    expect(result.querySelector('svg')).not.toBeNull()
    expect(result.querySelector('svg')!.getAttribute('class')).toMatch(/inline-block/)
    expect(result.className).not.toMatch(/text-error|inline-flex|whitespace-nowrap/)
    const note = screen.getByTestId('work-row-failed-note')
    expect(note).toHaveTextContent('die Antwort stützt sich nicht darauf')
    expect(result).not.toContainElement(note)
    expect(screen.getByTestId('work-row')).toHaveTextContent(
      'Sucht im RIS: „Wiener Garagengesetz 2008“die Antwort stützt sich nicht darauffehlgeschlagen'
    )
  })

  test('a call stored as running after its turn ended reads as interrupted, not as found', () => {
    const steps = storedSteps([
      {
        id: 'a',
        call_id: 'c',
        kind: 'action',
        verb: 'search',
        round: 1,
        query: 'Fluchtweg',
        status: 'running',
      },
    ]).map((step) => ({ ...step, isComplete: true }))
    render(<RoundCalls round={rounds(steps)[0]} />)
    const row = screen.getByTestId('work-row')
    expect(row.dataset.status).toBe('interrupted')
    expect(screen.getByTestId('work-row-result')).toHaveTextContent('abgebrochen')
  })

  test('a running look holds the crop’s place, so settling does not move the rows below', () => {
    const steps = storedSteps([
      {
        id: 'a',
        call_id: 'c',
        kind: 'action',
        verb: 'look',
        round: 1,
        target: 'Grundriss EG.pdf',
        pages: '2',
        status: 'running',
      },
    ]).map((step) => ({ ...step, isComplete: false }))
    render(<RoundCalls round={rounds(steps)[0]} />)
    const skeleton = screen.getByTestId('work-row-look-skeleton')
    expect(skeleton.style.width).toBe('132px')
    expect(skeleton.style.height).toBe('96px')
  })

  test('the rows are ruled off only under a sentence; without one the node edge parts them', () => {
    const [first] = rounds(foldScene(northStarScene()))
    const { unmount } = render(<RoundCalls round={first} />)
    expect(screen.getByTestId('work-round').className).toMatch(/border-t/)
    unmount()
    render(<RoundCalls round={first} ruled={false} />)
    expect(screen.getByTestId('work-round').className).not.toMatch(/border-t/)
  })

  test('„+N weitere“ turns its chevron when it opens', async () => {
    const steps = storedSteps(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({
        id,
        call_id: id,
        kind: 'action',
        verb: index % 2 ? 'web' : 'law',
        round: 1,
        query: `q${id}`,
        status: index < 3 ? 'ok' : 'empty',
      }))
    )
    render(<RoundCalls round={rounds(steps)[0]} />)
    const more = screen.getByTestId('work-round-more')
    const chevron = more.querySelector('svg')!
    expect(chevron.getAttribute('class')).not.toMatch(/rotate-180/)
    await userEvent.click(more)
    expect(more.querySelector('svg')!.getAttribute('class')).toMatch(/rotate-180/)
    expect(more.className).toMatch(/pointer-coarse:min-h-11/)
  })

  test('a look no call explains is drawn as a look row, not as a second kind of line', () => {
    const steps = storedSteps([
      { id: 'a', call_id: 'c', kind: 'action', verb: 'search', round: 1, query: 'x', status: 'ok' },
      {
        id: 'look:1',
        kind: 'look',
        round: 1,
        document_name: 'Schnitt A-A.pdf',
        page: 3,
        where: 'oben rechts',
      },
    ])
    render(<RoundCalls round={rounds(steps)[0]} />)
    const look = screen.getAllByTestId('work-row').find((row) => row.dataset.verb === 'look')!
    // toHaveTextContent reads a no-break space as a space.
    expect(look).toHaveTextContent('Betrachtet Schnitt A-A.pdf, S. 3, oben rechts')
    expect(look.textContent).toContain(`S.${NB}3`)
    expect(screen.queryByTestId('look-step-row')).toBeNull()
  })

  test('a filesystem search that could not search everything shows a dashed ring, the word and what it means', () => {
    const [first] = rounds(foldScene(filesystemEdgesScene()))
    render(<RoundCalls round={first} eager />)
    const incomplete = screen
      .getAllByTestId('work-row')
      .filter((row) => row.getAttribute('data-incomplete') === 'true')
    expect(incomplete).toHaveLength(2)
    expect(incomplete[0]).toHaveTextContent(
      'Durchsucht alle Ablagen wörtlich nach „Brandabschnitt“nicht alles durchsucht – es kann weitere Treffer geben3 Treffer in 1 Datei'
    )
    expect(within(incomplete[0]).getByTestId('work-row-note')).toHaveTextContent(
      'nicht alles durchsucht – es kann weitere Treffer geben'
    )
    expect(within(incomplete[1]).getByTestId('work-row-note')).toHaveTextContent('das ist kein Nein')
    // Never the failure note: most of it WAS searched.
    expect(screen.queryByTestId('work-row-failed-note')).toBeNull()
  })

  test('only a row whose call returned a card links; a listing or a search for files is no button', () => {
    const [, second] = rounds(foldScene(filesystemScene()))
    const onSelect = vi.fn()
    render(
      <RoundCalls
        round={second}
        linking={{ selection: null, onSelect, carded: new Set(['call:fs4', 'call:fs6']) }}
      />
    )
    const links = screen.getAllByTestId('work-row-link')
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      `Liest Baubeschreibung.pdf, S.${NB}4–6: 3${NB}Stellen`,
      `Durchsucht alle Ablagen wörtlich nach „Fluchtweg“: 3${NB}Treffer in 1${NB}Datei`,
    ])
    const listing = screen.getAllByTestId('work-row').find((row) => row.dataset.verb === 'list')!
    expect(within(listing).queryByRole('button')).toBeNull()
    expect(listing).toHaveTextContent('Öffnet 03 Einreichung › Pläne9 Dateien')
  })

  test('a row with a call id is a button that links; its name is the sentence', async () => {
    const onSelect = vi.fn()
    const [first] = rounds(foldScene(mockupScene()))
    const { rerender } = render(
      <RoundCalls round={first} linking={{ selection: null, onSelect }} />
    )
    const button = screen.getByRole('button', {
      name: `Sucht wörtlich „Brandabschnitt“ im Projekt: 14${NB}Treffer in 3${NB}Dokumenten`,
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
    // Its name is the row's own sentence, then what a tap does.
    await userEvent.click(
      screen.getAllByRole('button', { name: /^Liest Einreichplan EG\.pdf, S\.\u00A02–3.* – öffnen$/ })[0]
    )
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
    // The row names the document as its card does, not by its file name.
    const read = screen.getByRole('button', { name: /^Liest Einreichplan EG, S\./ })
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

describe('a row and its card call one document one thing', () => {
  test('the search the model wrote as „OIB-RL 2, Ausgabe 2023“ reads as the card names it', () => {
    const restore = installLayoutObservers()
    render(
      <ReasoningFlow
        steps={foldScene(mockupScene())}
        userQuestion="Frage?"
        citations={mockupCitations()}
      />
    )
    const rows = screen.getByTestId('reasoning-flow').textContent ?? ''
    expect(rows).toContain('OIB-Richtlinie 2, Ausgabe Mai 2023')
    expect(rows).not.toMatch(/OIB.RL 2, Ausgabe 2023/)
    restore()
  })
})
