import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import { render, screen, waitFor, within } from '@/test-utils'
import { server } from '@/mocks/server'
import { I18nProvider } from '@/i18n'
import type { SearchBody } from '@/lib/search/search-wire'
import { SEARCH_FIXTURE_RESPONSE, SEARCH_FIXTURE_SAVED } from '@/app/dev/_fixtures/search'
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
    // What the words were found in, quietly.
    expect(within(concept).getByTestId('search-matched-on')).toHaveTextContent('Gefunden in was Piloti las · Inhalt')
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
    expect(screen.getByTestId('search-note-building')).toBeInTheDocument()
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
    expect(screen.getByTestId('search-note-building')).toBeInTheDocument()
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
    await userEvent.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: {} }))
  })

  it('adds a column from the column menu, in its place', async () => {
    const onChange = vi.fn()
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, view: 'register' }} onChange={onChange} />)
    await userEvent.click(screen.getByTestId('search-register-columns'))
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Ordner' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ columns: ['planNumber', 'planIndex', 'title', 'planDate', 'scale', 'documentType', 'author', 'project', 'folder', 'status'] })
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
