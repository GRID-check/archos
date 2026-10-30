import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import { render, screen, waitFor, within } from '@/test-utils'
import { server } from '@/mocks/server'
import { I18nProvider } from '@/i18n'
import { SEARCH_FIXTURE_RESPONSE } from '@/app/dev/_fixtures/search'
import { readReviewParams } from '@/features/documents/lib/open-review'
import { EMPTY_SEARCH_STATE, type SearchUrlState } from '../lib/search-url'
import { sectionView } from '../lib/sections'
import { SearchReturnProvider } from '../hooks/use-search-return'
import { SearchWorkspaceView } from './search-workspace-view'
import { PRODUCT_NAME } from '@/lib/brand'

const routerPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/search',
  useSearchParams: () => new URLSearchParams('q=Fluchtweg'),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: (message: string) => toastSuccess(message), error: (message: string) => toastError(message) }),
}))

const PROJECT = '0b6f0c1e-3a55-4c0e-9a1d-7f2b5d0e1a01'
const CONCEPT = 'd0000000-0000-4000-8000-000000000001'
const REPLACED = 'd0000000-0000-4000-8000-000000000003'

const SECTIONS = {
  document: sectionView(SEARCH_FIXTURE_RESPONSE.sections.document!),
  annotation: sectionView(SEARCH_FIXTURE_RESPONSE.sections.annotation!),
  conversation: sectionView(SEARCH_FIXTURE_RESPONSE.sections.conversation!),
}

function view(state: SearchUrlState): ReactElement {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <SearchReturnProvider>
      <SearchWorkspaceView
        surface={{ kind: 'office' }}
        state={state}
        onStateChange={() => {}}
        fieldValue={state.text}
        onFieldChange={() => {}}
        response={SEARCH_FIXTURE_RESPONSE}
        sections={SECTIONS}
        loading={false}
        failed={false}
        onRetry={() => {}}
        onLoadMore={() => {}}
      />
      </SearchReturnProvider>
    </I18nProvider>
  )
}

const items = (): string[] => screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')

describe('a document hit’s ⋯', () => {
  beforeEach(() => {
    routerPush.mockClear()
    toastError.mockClear()
    toastSuccess.mockClear()
  })

  it('offers what a Dateien row offers, in its order: open and ask, where it stands, its link', async () => {
    render(view({ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }))
    await userEvent.click(screen.getByTestId(`search-hit-actions-${REPLACED}`))
    expect(items()).toEqual(['Öffnen', `${PRODUCT_NAME} fragen`, 'Aktuelle Fassung öffnen', 'Offene Punkte', 'Im Ordner zeigen', 'Link kopieren'])
  })

  it('opens where the row goes: at the passage, returning to this search', async () => {
    render(view({ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }))
    await userEvent.click(screen.getByTestId(`search-hit-actions-${CONCEPT}`))
    await userEvent.click(screen.getByTestId('search-hit-action-open'))
    const url = new URL(routerPush.mock.calls[0][0] as string, 'https://piloti.test')
    expect(url.pathname).toBe(`/app/projects/${PROJECT}/files`)
    expect(url.searchParams.get('doc')).toBe(CONCEPT)
    expect(url.searchParams.get('page')).toBe('7')
    expect(url.searchParams.get('back')).toBe('/app/search?q=Fluchtweg')
  })

  it('shows the document in its folder on its shelf', async () => {
    render(view({ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }))
    await userEvent.click(screen.getByTestId(`search-hit-actions-${CONCEPT}`))
    await userEvent.click(screen.getByTestId('search-hit-action-showInFolder'))
    const url = new URL(routerPush.mock.calls[0][0] as string, 'https://piloti.test')
    expect(url.pathname).toBe(`/app/projects/${PROJECT}/files`)
    const hit = SEARCH_FIXTURE_RESPONSE.sections.document!.hits.find((entry) => entry.id === CONCEPT)!
    expect(url.searchParams.get('folder')).toBe(hit.folderId)
  })

  it('copies the document’s own absolute link, without this reader’s way here, and says so', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(view({ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }))
    await userEvent.click(screen.getByTestId(`search-hit-actions-${CONCEPT}`))
    await userEvent.click(screen.getByTestId('search-hit-action-copyLink'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Link kopiert'))
    const url = new URL(writeText.mock.calls[0][0])
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe(`/app/projects/${PROJECT}/files`)
    expect(url.searchParams.get('doc')).toBe(CONCEPT)
    expect(url.searchParams.has('back')).toBe(false)
    expect(url.searchParams.has('page')).toBe(false)

    writeText.mockRejectedValueOnce(new Error('denied'))
    await userEvent.click(screen.getByTestId(`search-hit-actions-${CONCEPT}`))
    await userEvent.click(screen.getByTestId('search-hit-action-copyLink'))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Der Link konnte nicht kopiert werden.'))
  })

  it('opens the open points in the document’s Prüfansicht, returning to this search', async () => {
    render(view({ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }))
    await userEvent.click(screen.getByTestId(`search-hit-actions-${CONCEPT}`))
    await userEvent.click(screen.getByTestId('search-hit-action-openPoints'))
    const url = new URL(routerPush.mock.calls[0][0] as string, 'https://piloti.test')
    expect(url.pathname).toBe(`/app/projects/${PROJECT}/files`)
    expect(readReviewParams(url.searchParams)).toMatchObject({ documentId: CONCEPT, open: true, back: '/app/search?q=Fluchtweg' })
  })

  it('asks Piloti about the file in its project chat, the passage’s page in the question', async () => {
    render(view({ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }))
    await userEvent.click(screen.getByTestId(`search-hit-actions-${CONCEPT}`))
    await userEvent.click(screen.getByTestId('search-hit-action-ask'))
    const url = new URL(routerPush.mock.calls[0][0] as string, 'https://piloti.test')
    expect(url.pathname).toBe(`/app/projects/${PROJECT}/chat`)
    expect(url.searchParams.get('doc')).toBe(CONCEPT)
    expect(url.searchParams.get('ask')).toMatch(/^Was steht auf S\. 7 in „.+“\?$/)
  })

  it('opens the current Fassung the document’s status names for this reader, and says so when there is none', async () => {
    const CURRENT = 'd0000000-0000-4000-8000-0000000000aa'
    server.use(
      http.get(`/api/documents/${REPLACED}/status`, () => HttpResponse.json({ id: REPLACED, revision: { supersededBy: { id: CURRENT, filename: 'neu.pdf' } } }))
    )
    render(view({ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }))
    await userEvent.click(screen.getByTestId(`search-hit-actions-${REPLACED}`))
    await userEvent.click(screen.getByTestId('search-hit-action-openCurrent'))
    await waitFor(() => expect(routerPush).toHaveBeenCalled())
    expect(new URL(routerPush.mock.calls[0][0] as string, 'https://piloti.test').searchParams.get('doc')).toBe(CURRENT)

    routerPush.mockClear()
    server.use(http.get(`/api/documents/${REPLACED}/status`, () => HttpResponse.json({ id: REPLACED, revision: null })))
    await userEvent.click(screen.getByTestId(`search-hit-actions-${REPLACED}`))
    await userEvent.click(screen.getByTestId('search-hit-action-openCurrent'))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Die aktuelle Fassung lässt sich nicht öffnen.'))
    expect(routerPush).not.toHaveBeenCalled()
  })

  it('opens on the marked row with Shift+F10 while the focus stays in the field, in the list and in the register', async () => {
    const { unmount } = render(view({ ...EMPTY_SEARCH_STATE, text: 'Fluchtweg' }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Suchen' }))
    await userEvent.keyboard('{ArrowDown}{Shift>}{F10}{/Shift}')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(items()).toContain('Offene Punkte')
    unmount()

    render(view({ ...EMPTY_SEARCH_STATE, view: 'register' }))
    const row = screen.getByTestId(`search-register-row-${CONCEPT}`)
    expect(within(row).getByTestId(`search-hit-actions-${CONCEPT}`)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('combobox', { name: 'Suchen' }))
    await userEvent.keyboard('{ArrowDown}{ContextMenu}')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })
})
