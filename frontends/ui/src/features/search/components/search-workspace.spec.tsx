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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

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

describe('SearchWorkspaceView', () => {
  it('shows each kind with where it lives, and a document’s passage with its page', () => {
    german(<Harness initial={{ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg GK 4' }} onChange={() => {}} />)
    const concept = screen.getByTestId('search-hit-document-d0000000-0000-4000-8000-000000000001')
    expect(concept).toHaveTextContent('Brandschutzkonzept Wohnhaus Seestadt J7')
    // What it is and where it sits on one line; the project as its provenance mark.
    expect(concept).toHaveTextContent('Brandschutzkonzept·Brandschutz')
    expect(concept).toHaveTextContent('Wohnhaus Seestadt Baufeld J7')
    expect(concept).toHaveTextContent('S. 7')
    // The words searched for are set apart in the passage.
    expect(within(concept).getAllByText('Fluchtweg', { selector: 'mark' }).length).toBeGreaterThan(0)
    expect(concept).toHaveAttribute('href', `/app/projects/${PROJECT}/files?doc=d0000000-0000-4000-8000-000000000001`)
    expect(screen.getByTestId('search-hit-document-d0000000-0000-4000-8000-000000000006')).toHaveAttribute(
      'href',
      '/app/office-shelf?doc=d0000000-0000-4000-8000-000000000006'
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
    const field = screen.getByRole('searchbox', { name: 'Suchen' })
    await userEvent.click(field)
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(screen.getByTestId('search-hit-document-d0000000-0000-4000-8000-000000000002')).toHaveAttribute('aria-current', 'true')
    await userEvent.keyboard('{ArrowUp}{Enter}')
    expect(routerPush).toHaveBeenCalledWith(`/app/projects/${PROJECT}/files?doc=d0000000-0000-4000-8000-000000000001`)
    await userEvent.keyboard('{Escape}')
    expect(onField).toHaveBeenCalledWith('')
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

    await userEvent.click(within(register).getByRole('button', { name: 'Nach Plannummer sortieren' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'plan_number', dir: 'asc' }))
    await userEvent.click(within(register).getByRole('button', { name: 'Nach Plannummer sortieren' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'plan_number', dir: 'desc' }))
    // Maßstab is shown, not ordered by.
    expect(within(register).queryByRole('button', { name: 'Nach Maßstab sortieren' })).toBeNull()
    expect(within(register).getByText('Ersetzt')).toBeInTheDocument()
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
    await userEvent.type(screen.getByRole('searchbox', { name: 'Suchen' }), 'EP-03')
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
      `/app/search?view=register&sort=plan_number&dir=asc&project=${PROJECT}&type=submission_drawing&current=1`,
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
    expect(screen.getByRole('searchbox', { name: 'Suchen' })).toHaveAttribute('placeholder', 'Suchen…')
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

  it('folds the saved searches and the export into one „Mehr“', async () => {
    server.use(
      http.post('*/api/search', () => HttpResponse.json(SEARCH_FIXTURE_RESPONSE)),
      http.get('*/api/search/saved', () => HttpResponse.json({ savedSearches: SEARCH_FIXTURE_SAVED }))
    )
    currentSearch = ''
    german(<SearchWorkspace surface={{ kind: 'office' }} />)
    expect(screen.queryByTestId('saved-searches')).toBeNull()
    expect(screen.queryByTestId('search-export')).toBeNull()
    await userEvent.click(screen.getByTestId('search-more'))
    expect(await screen.findByTestId('search-export-csv')).toHaveTextContent('Planliste als CSV')
    expect(screen.getByTestId('search-more-save')).toHaveTextContent('Diese Suche speichern')
    await userEvent.click(screen.getByTestId('search-more-saved'))
    const list = await screen.findByRole('dialog', { name: 'Gespeicherte Suchen' })
    expect(await within(list).findAllByTestId('saved-search-apply')).toHaveLength(SEARCH_FIXTURE_SAVED.length)
  })
})
