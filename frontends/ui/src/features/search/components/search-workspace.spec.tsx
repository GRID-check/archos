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
    // What it is and where it sits on one line; the project as its provenance mark.
    expect(concept).toHaveTextContent('Brandschutzkonzept·Brandschutz')
    expect(concept).toHaveTextContent('Wohnhaus Seestadt Baufeld J7')
    expect(concept).toHaveTextContent('S. 7')
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
    expect(routerPush).toHaveBeenCalledWith(CONCEPT_AT_PASSAGE)
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
