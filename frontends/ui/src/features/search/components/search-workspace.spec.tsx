import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import { render, screen, waitFor, within } from '@/test-utils'
import { server } from '@/mocks/server'
import { I18nProvider } from '@/i18n'
import type { SearchBody } from '@/lib/search/search-wire'
import { SEARCH_FIXTURE_RESPONSE, SEARCH_FIXTURE_SAVED } from '@/app/dev/_fixtures/search'
import { searchFixtureAnswer } from '@/app/dev/_fixtures/search-answer'
import { EMPTY_SEARCH_STATE, type SearchUrlState } from '../lib/search-url'
import { sectionView } from '../lib/sections'
import { SearchWorkspace } from './search-workspace'
import { SearchWorkspaceView } from './search-workspace-view'

/** The URL the organism reads; a test sets it before rendering, the router writes it. */
let currentSearch = ''
const routerPush = vi.fn((href: string) => {
  currentSearch = href.split('?')[1] ?? ''
})
const routerReplace = vi.fn((href: string) => {
  currentSearch = href.split('?')[1] ?? ''
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: vi.fn() }),
  usePathname: () => '/app/search',
  useSearchParams: () => new URLSearchParams(currentSearch),
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

const PROJECT = '0b6f0c1e-3a55-4c0e-9a1d-7f2b5d0e1a01'

function german(ui: ReactElement): ReturnType<typeof render> {
  return render(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )
}

const SECTIONS = {
  document: sectionView(SEARCH_FIXTURE_RESPONSE.sections.document!),
  annotation: sectionView(SEARCH_FIXTURE_RESPONSE.sections.annotation!),
  conversation: sectionView(SEARCH_FIXTURE_RESPONSE.sections.conversation!),
}

/** The view over the fixture, its question held in memory and reported on every change. */
function Harness({ initial, onChange }: { initial: SearchUrlState; onChange: (next: SearchUrlState) => void }): ReactElement {
  const [state, setState] = useState(initial)
  return (
    <SearchWorkspaceView
      surface={{ kind: 'office' }}
      state={state}
      onStateChange={(next) => {
        setState(next)
        onChange(next)
      }}
      fieldValue={state.text}
      onFieldChange={() => {}}
      response={SEARCH_FIXTURE_RESPONSE}
      sections={SECTIONS}
      loading={false}
      failed={false}
      onRetry={() => {}}
      onLoadMore={() => {}}
    />
  )
}

/** A document hit's link: its shelf preview at the passage's page, the passage to light up there. */
const atPassage = (base: string, page: number, passage: string): string =>
  `${base}&${new URLSearchParams({ page: String(page), highlight: passage }).toString()}`
const CONCEPT_AT_PASSAGE = atPassage(
  `/app/projects/${PROJECT}/files?doc=d0000000-0000-4000-8000-000000000001`,
  7,
  'Die Fluchtweglänge beträgt max. 40 m bis zum nächsten gesicherten Stiegenhaus (GK 4, OIB-RL 2, Pkt. 5.1.1)'
)

describe('SearchWorkspaceView', () => {
  it('shows each kind with where it lives, and a document’s passage with its page', () => {
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg GK 4' }} onChange={() => {}} />)
    const concept = screen.getByTestId('search-hit-document-d0000000-0000-4000-8000-000000000001')
    expect(concept).toHaveTextContent('Brandschutzkonzept Wohnhaus Seestadt J7')
    // Where it lives on its own line: the project as its provenance mark, whole, then the folder.
    expect(concept).toHaveTextContent('Wohnhaus Seestadt Baufeld J7Ordner Brandschutz')
    expect(concept).toHaveTextContent('S. 7')
    // What the words were found in that the row does not show: the passage under it already says „Inhalt“.
    expect(within(concept).getByTestId('search-matched-on')).toHaveTextContent(/^Gefunden in was Piloti las$/)
    // The words searched for are set apart in the passage.
    expect(within(concept).getAllByText('Fluchtweg', { selector: 'mark' }).length).toBeGreaterThan(0)
    // It opens at the passage's page, the passage to light up there.
    expect(concept).toHaveAttribute('href', CONCEPT_AT_PASSAGE)
    expect(screen.getByTestId('search-hit-document-d0000000-0000-4000-8000-000000000006')).toHaveAttribute(
      'href',
      atPassage('/app/office-shelf?doc=d0000000-0000-4000-8000-000000000006', 9, 'Die Fluchtweglänge darf 40 m nicht überschreiten')
    )
    expect(screen.getByTestId('search-hit-annotation-a0000000-0000-4000-8000-000000000001')).toHaveAttribute(
      'href',
      `/app/projects/${PROJECT}/files?doc=d0000000-0000-4000-8000-000000000002&review=1&mark=a0000000-0000-4000-8000-000000000001`
    )
    expect(screen.getByTestId('search-section-conversation')).toHaveTextContent('Fluchtweglängen nach OIB-RL 2 für GK 4')
    // The shelf still being read is said once, in the status line; the long
    // note waits for a filter that depends on it.
    expect(screen.getByTestId('search-status')).toHaveTextContent('eine Ablage wird noch gelesen')
    expect(screen.queryByTestId('search-note-building')).toBeNull()
  })

  it('shows the kinds a document filter cannot narrow as not searched, and why, rather than unfiltered rows', () => {
    const state: SearchUrlState = {
      ...EMPTY_SEARCH_STATE,
      text: 'Fluchtweg GK 4',
      filters: { documentTypes: ['submission_drawing'], planNumber: 'EP-0' },
    }
    const answer = searchFixtureAnswer(state)
    const sections = Object.fromEntries(Object.entries(answer.sections).map(([kind, section]) => [kind, sectionView(section!)]))
    german(
      <SearchWorkspaceView
        surface={{ kind: 'office' }}
        state={state}
        onStateChange={() => {}}
        fieldValue={state.text}
        onFieldChange={() => {}}
        response={answer}
        sections={sections}
        loading={false}
        failed={false}
        onRetry={() => {}}
        onLoadMore={() => {}}
      />
    )
    for (const kind of ['folder', 'project', 'conversation']) {
      expect(screen.getByTestId(`search-kind-${kind}`)).toBeDisabled()
      expect(screen.getByTestId(`search-kind-${kind}`)).toHaveAttribute('title', 'Mit diesen Filtern nicht durchsucht')
    }
    expect(screen.getByTestId('search-kind-annotation')).toBeEnabled()
    expect(screen.getByTestId('search-note-set-aside')).toHaveTextContent(
      'Die Filter gelten für Dokumente und ihre Anmerkungen. Ordner, Projekte und Chats werden so lange nicht durchsucht.'
    )
    // The mark on the Einreichplan EP-03 stays: an annotation narrows through its document.
    expect(screen.getAllByTestId(/^search-hit-annotation-/)).toHaveLength(1)
    expect(searchFixtureAnswer({ ...state, filters: { documentTypes: ['fire_safety_concept'] } }).sections.annotation?.hits).toEqual([])
    expect(screen.queryByTestId(/^search-hit-folder-/)).toBeNull()
    expect(screen.queryByTestId(/^search-hit-conversation-/)).toBeNull()
  })

  it('explains the shelf still being read where a filter set depends on what it holds', () => {
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg', filters: { documentTypes: ['submission_drawing'] } }} onChange={() => {}} />)
    expect(screen.getByTestId('search-note-building')).toHaveTextContent('Piloti liest noch')
  })

  it('leads the rail with Plannummer, Index and the current Fassung, always open', async () => {
    const onChange = vi.fn()
    german(<Harness initial={EMPTY_SEARCH_STATE} onChange={onChange} />)
    const rail = screen.getByTestId('search-rail')
    const groups = within(rail).getAllByRole('heading', { level: 3 })
    expect(groups[0]).toHaveTextContent('Plannummer und Fassung')
    const key = screen.getByTestId('search-key-filters')
    expect(within(key).queryByRole('button', { name: /Plannummer und Fassung/ })).toBeNull()
    await userEvent.type(within(key).getByTestId('filter-plan-number'), 'EP-0{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { planNumber: 'EP-0' } }))
    await userEvent.click(within(key).getByTestId('filter-current'))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { planNumber: 'EP-0', currentOnly: true } }))
  })

  it('gives each filter one control: the counted ones in their group, a party’s name typed inside Beteiligte', async () => {
    const onChange = vi.fn()
    german(<Harness initial={EMPTY_SEARCH_STATE} onChange={onChange} />)
    const rail = screen.getByTestId('search-rail')
    expect(within(rail).queryByTestId('filter-cites')).toBeNull()
    expect(within(rail).queryByTestId('filter-file-type')).toBeNull()
    expect(within(rail).queryByTestId('filter-party-role')).toBeNull()
    const parties = screen.getByTestId('search-facet-partyRole')
    await userEvent.type(within(parties).getByTestId('filter-party-name'), 'Haas{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { parties: [{ name: 'Haas' }] } }))
    expect(within(parties).getByTestId('filter-party-name')).toHaveValue('')
  })

  it('says „Nur aktuelle Fassung“ in the register with its switch alone, never also as a chip', () => {
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, view: 'register', filters: { currentOnly: true, planNumber: 'EP' } }} onChange={() => {}} />)
    expect(screen.getByTestId('search-register-current')).toBeChecked()
    expect(screen.queryByTestId('filter-current')).toBeNull()
    const chips = screen.getByTestId('search-active-filters')
    expect(chips).toHaveTextContent('Plannummer')
    expect(chips).not.toHaveTextContent('Nur aktuelle Fassung')
  })

  it('marks a replaced Fassung on its name in the register, and spends no default column on „Gelesen“', () => {
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, view: 'register' }} onChange={() => {}} />)
    const register = screen.getByTestId('search-register')
    expect(within(register).queryByRole('button', { name: 'Nach Status sortieren' })).toBeNull()
    expect(register).not.toHaveTextContent('Gelesen')
    const replaced = screen.getByTestId('search-register-row-d0000000-0000-4000-8000-000000000003')
    expect(within(replaced).getByTestId('superseded-mark')).toBeInTheDocument()
  })

  it('offers the ways out of an empty answer while shelves are read: archived, and the whole office from a project', () => {
    const empty = { ...SEARCH_FIXTURE_RESPONSE, sections: { document: { hits: [], total: 0, totalIsLowerBound: false, nextCursor: null } }, building: ['p1', 'p2'] }
    german(
      <SearchWorkspaceView
        surface={{ kind: 'project', projectId: PROJECT }}
        state={{ ...EMPTY_SEARCH_STATE, text: 'Stiege', kinds: ['document'] }}
        onStateChange={() => {}}
        fieldValue="Stiege"
        onFieldChange={() => {}}
        response={empty}
        sections={{ document: sectionView(empty.sections.document) }}
        loading={false}
        failed={false}
        onRetry={() => {}}
        onLoadMore={() => {}}
      />
    )
    expect(screen.getByTestId('search-empty')).toHaveTextContent('Noch nichts gefunden')
    expect(screen.getByTestId('search-empty')).toHaveTextContent('Piloti liest noch 2 Ablagen, dort können noch Treffer dazukommen.')
    expect(screen.getByTestId('search-empty-archived')).toHaveTextContent('Archivierte einschließen')
    expect(screen.getByTestId('search-empty-all-kinds')).toHaveTextContent('Alles zeigen')
    expect(screen.getByTestId('search-empty-office')).toHaveAttribute('href', '/app/search?q=Stiege&kind=document')
    expect(screen.queryByTestId('search-note-building')).toBeNull()
  })

  it('says what a Fassung changed against the one it replaced, in the dossier’s words', () => {
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg GK 4' }} onChange={() => {}} />)
    const indexC = screen.getByTestId('search-hit-document-d0000000-0000-4000-8000-000000000002')
    expect(within(indexC).getByTestId('search-changed-facts')).toHaveTextContent(
      'Gegenüber der Vorfassung: Fluchtweglänge 38,50 m → 42,10 m · Oberirdische Geschosse 4 → 5'
    )
    const unchanged = screen.getByTestId('search-hit-document-d0000000-0000-4000-8000-000000000001')
    expect(within(unchanged).queryByTestId('search-changed-facts')).toBeNull()
  })

  it('counts the changed facts as a facet, and says under the facets how many documents are not read yet', async () => {
    const onChange = vi.fn()
    german(<Harness initial={EMPTY_SEARCH_STATE} onChange={onChange} />)
    expect(screen.getByTestId('search-facets-unread')).toHaveTextContent('3 Dokumente noch nicht gelesen, in den Zahlen oben nicht enthalten.')
    const facet = screen.getByTestId('search-facet-changedFact')
    expect(facet).toHaveTextContent('Geänderte Angaben')
    await userEvent.click(within(facet).getByTestId('search-facet-changedFact-escape_route_length'))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { changedFacts: ['escape_route_length'] } }))
  })

  it('marks a replaced Fassung in ink with its icon and word, never in the Büroablage’s amber', () => {
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg GK 4' }} onChange={() => {}} />)
    const replaced = screen.getByTestId('search-hit-document-d0000000-0000-4000-8000-000000000003')
    const mark = within(replaced).getByTestId('superseded-mark')
    expect(mark).toHaveTextContent('Ersetzt')
    expect(mark).toHaveAttribute('title', 'Eine neuere Fassung ersetzt dieses Dokument')
    expect(mark.className).not.toMatch(/warning/)
    expect(mark.querySelector('svg')).not.toBeNull()
  })

  it('walks the results with the arrow keys, opens one with Enter and clears the words with Escape', async () => {
    const onField = vi.fn()
    routerPush.mockClear()
    german(
      <SearchWorkspaceView
        surface={{ kind: 'office' }}
        state={{ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }}
        onStateChange={() => {}}
        fieldValue="Fluchtweg"
        onFieldChange={onField}
        response={SEARCH_FIXTURE_RESPONSE}
        sections={SECTIONS}
        loading={false}
        failed={false}
        onRetry={() => {}}
        onLoadMore={() => {}}
      />
    )
    const field = screen.getByRole('combobox', { name: 'Suchen' })
    await userEvent.click(field)
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    const second = screen.getByTestId('search-hit-document-d0000000-0000-4000-8000-000000000002')
    expect(second).toHaveAttribute('aria-selected', 'true')
    // Focus stays in the field; a screen reader follows the active option through it.
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('aria-activedescendant', second.id)
    await userEvent.keyboard('{ArrowUp}{Enter}')
    expect(routerPush).toHaveBeenCalledWith(CONCEPT_AT_PASSAGE)
    await userEvent.keyboard('{Escape}')
    expect(onField).toHaveBeenCalledWith('')
  })

  it('is a combobox over one listbox per kind, each hit an option with a stable id', () => {
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }} onChange={() => {}} />)
    const field = screen.getByRole('combobox', { name: 'Suchen' })
    expect(field).toHaveAttribute('aria-autocomplete', 'list')
    expect(field).toHaveAttribute('aria-expanded', 'true')
    expect(field).not.toHaveAttribute('aria-activedescendant')
    const lists = screen.getAllByRole('listbox')
    expect(lists.map((list) => list.getAttribute('aria-label'))).toEqual(['Dokumente', 'Anmerkungen', 'Chats'])
    expect(field.getAttribute('aria-controls')?.split(' ')).toEqual(lists.map((list) => list.id))
    const options = within(lists[0]).getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[0].id).not.toBe('')
    expect(new Set(screen.getAllByRole('option').map((option) => option.id)).size).toBe(screen.getAllByRole('option').length)
  })

  it('in the register, the combobox controls the table and names the active row', async () => {
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, view: 'register' }} onChange={() => {}} />)
    const field = screen.getByRole('combobox', { name: 'Suchen' })
    const register = screen.getByTestId('search-register')
    expect(field).toHaveAttribute('aria-controls', register.id)
    await userEvent.click(field)
    await userEvent.keyboard('{ArrowDown}')
    const row = screen.getByTestId('search-register-row-d0000000-0000-4000-8000-000000000001')
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(field).toHaveAttribute('aria-activedescendant', row.id)
  })

  it('offers to clear the filters when they exclude everything, and keeps the words on a failed search', async () => {
    const onChange = vi.fn()
    const empty = { ...SEARCH_FIXTURE_RESPONSE, sections: { document: { hits: [], total: 0, totalIsLowerBound: false, nextCursor: null } } }
    const { rerender } = german(
      <SearchWorkspaceView
        surface={{ kind: 'office' }}
        state={{ ...EMPTY_SEARCH_STATE, text: 'x', filters: { currentOnly: true } }}
        onStateChange={onChange}
        fieldValue="x"
        onFieldChange={() => {}}
        response={empty}
        sections={{ document: sectionView(empty.sections.document) }}
        loading={false}
        failed={false}
        onRetry={() => {}}
        onLoadMore={() => {}}
      />
    )
    expect(screen.getByTestId('search-empty')).toHaveTextContent('Piloti liest noch eine Ablage')
    await userEvent.click(screen.getByTestId('search-empty-clear'))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'x', filters: {} }))
    const onRetry = vi.fn()
    rerender(
      <I18nProvider initialLocale="de" fixedLocale>
        <SearchWorkspaceView
          surface={{ kind: 'office' }}
          state={EMPTY_SEARCH_STATE}
          onStateChange={onChange}
          fieldValue=""
          onFieldChange={() => {}}
          response={null}
          sections={{}}
          loading={false}
          failed
          onRetry={onRetry}
          onLoadMore={() => {}}
        />
      </I18nProvider>
    )
    expect(screen.getByText('Begriffe und Filter bleiben erhalten. Bitte gleich noch einmal versuchen.')).toBeInTheDocument()
  })

  it('names the document types in the dossier’s words and toggles one with a click', async () => {
    const onChange = vi.fn()
    german(<Harness initial={EMPTY_SEARCH_STATE} onChange={onChange} />)
    const permit = screen.getByTestId('search-facet-documentType-submission_drawing')
    expect(permit).toHaveTextContent('Einreichplan')
    expect(permit).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(permit)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { documentTypes: ['submission_drawing'] } }))
    expect(screen.getByTestId('search-facet-documentType-submission_drawing')).toHaveAttribute('aria-pressed', 'true')
    // The chip over the results takes it off again.
    await userEvent.click(within(screen.getByTestId('search-active-filters')).getByRole('button', { name: /Einreichplan/ }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: {} }))
  })

  it('sorts the register by the header clicked, and flips it on a second click', async () => {
    const onChange = vi.fn()
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, view: 'register' }} onChange={onChange} />)
    const register = screen.getByTestId('search-register')
    expect(within(register).getAllByRole('row')).toHaveLength(1 + SEARCH_FIXTURE_RESPONSE.sections.document!.hits.length)

    // The register reads by Plannummer from the start: the first click turns it round.
    await userEvent.click(within(register).getByRole('button', { name: 'Nach Plannummer sortieren' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'plan_number', dir: 'desc' }))
    await userEvent.click(within(register).getByRole('button', { name: 'Nach Plannummer sortieren' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'plan_number', dir: 'asc' }))
    // Every column orders the search, Maßstab and Verfasser among them.
    await userEvent.click(within(register).getByRole('button', { name: 'Nach Maßstab sortieren' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'scale', dir: 'asc' }))
    await userEvent.click(within(register).getByRole('button', { name: 'Nach Verfasser sortieren' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'author', dir: 'asc' }))
    // Ordner is a column the reader asks for.
    expect(within(register).queryByRole('button', { name: 'Nach Ordner sortieren' })).toBeNull()
    expect(within(register).getByText('Ersetzt')).toBeInTheDocument()
  })

  it('shows „Nur aktuelle Fassung“ above the register, and switches it off into the URL state', async () => {
    const onChange = vi.fn()
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, view: 'register', filters: { currentOnly: true } }} onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Nur aktuelle Fassung' })
    expect(toggle).toBeChecked()
    // One switch for one setting: the rail leaves it to the bar above the table.
    expect(screen.queryByTestId('filter-current')).toBeNull()
    await userEvent.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: {} }))
  })

  it('adds a column from the column menu, in its place', async () => {
    const onChange = vi.fn()
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, view: 'register' }} onChange={onChange} />)
    await userEvent.click(screen.getByTestId('search-register-columns'))
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Ordner' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ columns: ['planNumber', 'planIndex', 'title', 'planDate', 'scale', 'documentType', 'author', 'project', 'folder'] })
    )
    // The menu stays open for the next pick; Escape closes it.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Ordner' })).toBeChecked()
    await userEvent.keyboard('{Escape}')
    expect(within(screen.getByTestId('search-register')).getByRole('button', { name: 'Nach Ordner sortieren' })).toBeInTheDocument()
  })
})

describe('SearchWorkspace', () => {
  let asked: Array<{ query: string; body: SearchBody }>

  beforeEach(() => {
    asked = []
    routerPush.mockClear()
    routerReplace.mockClear()
    server.use(
      http.post('*/api/search', async ({ request }) => {
        asked.push({ query: new URL(request.url).search, body: (await request.json()) as SearchBody })
        return HttpResponse.json(SEARCH_FIXTURE_RESPONSE)
      }),
      http.get('*/api/search/saved', () => HttpResponse.json({ savedSearches: SEARCH_FIXTURE_SAVED }))
    )
  })

  it('asks the question the URL names, at the surface’s scope', async () => {
    currentSearch = 'q=Fluchtweg&type=submission_drawing&current=1&view=register&sort=plan_number&dir=asc&folder=f1'
    german(<SearchWorkspace surface={{ kind: 'project', projectId: PROJECT, folderId: '5d1a2c3b-1111-4a2b-8c3d-000000000001' }} />)
    await waitFor(() => expect(asked).toHaveLength(1))
    expect(asked[0].query).toBe(`?scope=project&projectId=${PROJECT}&folderId=5d1a2c3b-1111-4a2b-8c3d-000000000001`)
    expect(asked[0].body).toEqual({
      text: 'Fluchtweg',
      kinds: ['document'],
      filters: { documentTypes: ['submission_drawing'], currentOnly: true },
      sort: 'plan_number',
      dir: 'asc',
      limit: 100,
      facets: true,
    })
  })

  it('writes the words to the URL once the reader stops typing, and keeps the shelf’s own parameters', async () => {
    currentSearch = 'folder=f1'
    german(<SearchWorkspace surface={{ kind: 'office' }} />)
    await waitFor(() => expect(asked).toHaveLength(1))
    await userEvent.type(screen.getByRole('combobox', { name: 'Suchen' }), 'EP-03')
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/app/search?folder=f1&q=EP-03', { scroll: false }))
    expect(routerReplace).toHaveBeenCalledTimes(1)
  })

  it('applies a saved search as the search it saved', async () => {
    currentSearch = ''
    german(<SearchWorkspace surface={{ kind: 'office' }} />)
    await userEvent.click(screen.getByTestId('saved-searches'))
    const rows = await screen.findAllByTestId('saved-search-apply')
    await userEvent.click(rows[0])
    expect(routerPush).toHaveBeenCalledWith(
      `/app/search?view=register&sort=plan_number&dir=asc&project=${PROJECT}&type=submission_drawing`,
      { scroll: false }
    )
  })
})

describe('SearchWorkspaceView on a phone', () => {
  beforeEach(() => {
    // Every layout query matches: below `md`, phone-sized.
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query !== '(pointer: coarse)',
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('keeps the rail out of the page and opens it as a sheet, with the answer’s size and „Alle entfernen“ at the thumb', async () => {
    const onChange = vi.fn()
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, filters: { currentOnly: true } }} onChange={onChange} />)
    expect(screen.getByRole('combobox', { name: 'Suchen' })).toHaveAttribute('placeholder', 'Suchen…')
    expect(screen.queryByTestId('search-rail')).toBeNull()

    await userEvent.click(screen.getByTestId('search-rail-toggle'))
    const sheet = await screen.findByRole('dialog', { name: 'Filter' })
    expect(within(sheet).getByTestId('search-key-filters')).toBeInTheDocument()
    expect(within(sheet).getByTestId('search-sheet-show')).toHaveTextContent('16 Treffer zeigen')
    await userEvent.click(within(sheet).getByTestId('search-sheet-clear'))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: {} }))
    expect(within(sheet).getByTestId('search-sheet-clear')).toBeDisabled()
    await userEvent.click(within(sheet).getByTestId('search-sheet-show'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Filter' })).toBeNull())
  })

  it('keeps one saved-searches button, its list a sheet with saving inside, and the export only in the Planliste', async () => {
    server.use(
      http.post('*/api/search', () => HttpResponse.json(SEARCH_FIXTURE_RESPONSE)),
      http.get('*/api/search/saved', () => HttpResponse.json({ savedSearches: SEARCH_FIXTURE_SAVED }))
    )
    currentSearch = ''
    german(<SearchWorkspace surface={{ kind: 'office' }} />)
    expect(screen.queryByTestId('search-more')).toBeNull()
    expect(screen.queryByTestId('search-export')).toBeNull()
    await userEvent.click(screen.getByTestId('saved-searches'))
    const list = await screen.findByRole('dialog', { name: 'Gespeicherte Suchen' })
    expect(await within(list).findAllByTestId('saved-search-apply')).toHaveLength(SEARCH_FIXTURE_SAVED.length)
    expect(within(list).getByTestId('saved-search-save')).toHaveTextContent('Diese Suche speichern')
  })
})
