import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import { render, screen, waitFor, within } from '@/test-utils'
import { server } from '@/mocks/server'
import { I18nProvider } from '@/i18n'
import type { SearchBody } from '@/lib/search/search-wire'
import { SEARCH_FIXTURE_RESPONSE, SEARCH_FIXTURE_SAVED } from '@/app/dev/_fixtures/search'
import { RECENT_SEARCHES_KEY } from '@/features/search/lib/recent-searches'
import { CommandPalette } from './command-palette'

const push = vi.fn()
let pathname = '/app/projects'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
}))
vi.mock('@/adapters/auth/use-auth', () => ({ useAuth: () => ({ signOut: vi.fn() }) }))

// cmdk scrolls the selected item into view; happy-dom may not implement it.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

const PROJECT = '0b6f0c1e-3a55-4c0e-9a1d-7f2b5d0e1a01'
const CONCEPT = 'd0000000-0000-4000-8000-000000000001'

let asked: Array<{ query: string; body: SearchBody }> = []

function palette(): ReactElement {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <CommandPalette open onOpenChange={() => {}} authRequired canViewOrganization />
    </I18nProvider>
  )
}

const field = (): HTMLElement => screen.getByPlaceholderText(/./)

describe('CommandPalette: the workspace search', () => {
  beforeEach(() => {
    asked = []
    push.mockClear()
    pathname = '/app/projects'
    window.localStorage.removeItem(RECENT_SEARCHES_KEY)
    server.use(
      http.post('*/api/search', async ({ request }) => {
        asked.push({ query: new URL(request.url).search, body: (await request.json()) as SearchBody })
        return HttpResponse.json(SEARCH_FIXTURE_RESPONSE)
      }),
      http.get('*/api/search/saved', () => HttpResponse.json({ savedSearches: SEARCH_FIXTURE_SAVED, nextCursor: null })),
      http.get('*/api/projects', () => HttpResponse.json([{ id: PROJECT, name: 'Wohnhaus Seestadt Baufeld J7' }]))
    )
  })

  it('asks once typing pauses, for three hits of each kind without facet counts, across the office', async () => {
    render(palette())
    await userEvent.type(field(), 'Fluchtweg GK 4')
    await waitFor(() => expect(asked).toHaveLength(1))
    expect(asked[0]).toEqual({ query: '', body: { text: 'Fluchtweg GK 4', limit: 3, facets: false } })
    // The keystrokes before the pause asked nothing of their own.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(asked).toHaveLength(1)
  })

  it('scopes the search to the project the reader is in', async () => {
    pathname = `/app/projects/${PROJECT}/files`
    render(palette())
    await userEvent.type(field(), 'EP-03')
    await waitFor(() => expect(asked).toHaveLength(1))
    expect(asked[0].query).toBe(`?scope=project&projectId=${PROJECT}`)
  })

  it('groups the hits by kind, draws them as the search page does, and ends with all of them', async () => {
    render(palette())
    await userEvent.type(field(), 'Fluchtweg')
    const documents = await screen.findByTestId('palette-group-document')
    expect(within(documents).getByText('Dokumente')).toBeInTheDocument()
    // At most three of a kind, though the answer holds more.
    expect(SEARCH_FIXTURE_RESPONSE.sections.document!.hits.length).toBeGreaterThan(3)
    expect(within(documents).getAllByRole('option')).toHaveLength(3)
    // The page's own row, compact: the name, then one line of where it lives and what it is; the passage with its page.
    const concept = screen.getByTestId(`palette-search-hit-document-${CONCEPT}`)
    expect(concept).toHaveTextContent('Brandschutzkonzept Wohnhaus Seestadt J7')
    expect(concept).toHaveTextContent('S. 7')
    expect(concept).toHaveTextContent('Wohnhaus Seestadt Baufeld J7')
    expect(within(concept).getAllByText('Fluchtweg', { selector: 'mark' }).length).toBeGreaterThan(0)
    expect(screen.getByTestId('palette-group-annotation')).toBeInTheDocument()
    expect(screen.getByTestId('palette-group-conversation')).toBeInTheDocument()

    // The search rows come first, in the contract's order, „Alle Treffer“ last among them.
    const options = screen.getAllByRole('option')
    const all = screen.getByTestId('palette-workspace-search')
    expect(all).toHaveTextContent('Alle Treffer für „Fluchtweg“')
    const lastHit = options.findLastIndex((option) => option.dataset.testid?.startsWith('palette-search-hit-'))
    expect(options.indexOf(all)).toBe(lastHit + 1)
    expect(options[0]).toBe(concept)
  })

  it('opens the first hit on Enter, and remembers what was searched', async () => {
    render(palette())
    await userEvent.type(field(), 'Fluchtweg')
    const concept = await screen.findByTestId(`palette-search-hit-document-${CONCEPT}`)
    await waitFor(() => expect(concept).toHaveAttribute('aria-selected', 'true'))
    await userEvent.keyboard('{Enter}')
    expect(push).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^/app/projects/${PROJECT}/files\\?doc=${CONCEPT}&page=7&highlight=`)))
    expect(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY) ?? '[]')).toEqual(['Fluchtweg'])
  })

  it('opens every hit on the search page from the last search row', async () => {
    render(palette())
    await userEvent.type(field(), 'Fluchtweg')
    await screen.findByTestId('palette-group-document')
    await userEvent.click(screen.getByTestId('palette-workspace-search'))
    expect(push).toHaveBeenCalledWith('/app/search?q=Fluchtweg')
  })

  it('opens every hit on the search page with Ctrl+Enter, from whichever row the arrows are on', async () => {
    render(palette())
    await userEvent.type(field(), 'Fluchtweg')
    const concept = await screen.findByTestId(`palette-search-hit-document-${CONCEPT}`)
    await waitFor(() => expect(concept).toHaveAttribute('aria-selected', 'true'))
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith('/app/search?q=Fluchtweg')
  })

  it('says when nothing was found, and still offers the search page', async () => {
    server.use(http.post('*/api/search', () => HttpResponse.json({ ...SEARCH_FIXTURE_RESPONSE, sections: {} })))
    render(palette())
    await userEvent.type(field(), 'xyz')
    await waitFor(() => expect(screen.getByTestId('palette-search-status')).toHaveTextContent('Nichts gefunden für „xyz“'))
    expect(screen.getByTestId('palette-workspace-search')).toHaveTextContent('In der Suche weitersuchen')
  })

  it('before anything is typed: what the search reaches, the recent searches and the saved ones, and the commands', async () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(['EP-05', 'Fluchtweg']))
    render(palette())
    expect(screen.getByTestId('palette-search-hint')).toHaveTextContent('Name, Plankopf, Art und Inhalt')
    const recent = screen.getByTestId('palette-recent')
    expect(within(recent).getAllByRole('option').map((row) => row.textContent)).toEqual(['EP-05', 'Fluchtweg'])
    const saved = await screen.findByTestId('palette-saved')
    expect(saved).toHaveTextContent('Einreichpläne, aktuell')
    // A colleague's search names who shared it, as the saved searches' popover does.
    expect(saved).toHaveTextContent('Geteilt von Max Gruber')
    expect(screen.getByText('Profil')).toBeInTheDocument()
    expect(asked).toHaveLength(0)

    // A recent search is asked again, in place.
    await userEvent.click(within(recent).getByText('EP-05'))
    expect(field()).toHaveValue('EP-05')
    await waitFor(() => expect(asked.at(-1)?.body.text).toBe('EP-05'))
  })

  it('runs a saved search where it was saved', async () => {
    render(palette())
    const saved = await screen.findByTestId('palette-saved')
    await userEvent.click(within(saved).getByText('Einreichpläne, aktuell'))
    expect(push).toHaveBeenCalledWith(`/app/search?view=register&sort=plan_number&dir=asc&project=${PROJECT}&type=submission_drawing`)
  })

  it('keeps the commands: typing a command’s name still finds it below the search rows', async () => {
    render(palette())
    await userEvent.type(field(), 'Profil')
    expect(await screen.findByText('Profil')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Profil'))
    expect(push).toHaveBeenCalledWith('/app/profile')
  })
})
