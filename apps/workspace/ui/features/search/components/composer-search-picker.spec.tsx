import { describe, expect, it, vi } from 'vitest'
import { createRef, type ReactElement } from 'react'
import { act } from '@testing-library/react'
import { http, HttpResponse } from 'msw'

import { render, renderHook, screen, waitFor } from '@/test-utils'
import { server } from '@/mocks/server'
import { I18nProvider } from '@/i18n'
import { SEARCH_FIXTURE_RESPONSE } from '@/app/dev/_fixtures/search'
import type { SearchBody } from '@/lib/search/search-wire'
import type { PaletteSearch } from '../hooks/use-palette-search'
import { useDocumentReference } from '../hooks/use-document-reference'
import { ComposerSearchPicker, type ComposerSearchPickerHandle } from './composer-search-picker'

const DOCUMENTS_ONLY = { ...SEARCH_FIXTURE_RESPONSE, sections: { document: SEARCH_FIXTURE_RESPONSE.sections.document } }
const answered = (words: string): PaletteSearch => ({ answered: words, response: DOCUMENTS_ONLY, loading: false, failed: false })

const german = (ui: ReactElement): ReactElement => (
  <I18nProvider initialLocale="de" fixedLocale>
    {ui}
  </I18nProvider>
)

describe('ComposerSearchPicker', () => {
  it('says what to type before anything is typed', () => {
    render(german(<ComposerSearchPicker query="" search={answered('')} onPick={() => {}} />))
    expect(screen.getByTestId('composer-search-hint')).toHaveTextContent('Name, Plannummer oder ein Wort aus dem Inhalt eingeben')
  })

  it('draws the hits with the search’s own rows and picks the one the arrows are on', () => {
    const onPick = vi.fn()
    const ref = createRef<ComposerSearchPickerHandle>()
    render(german(<ComposerSearchPicker ref={ref} query="Flucht" search={answered('Flucht')} onPick={onPick} />))
    const hits = DOCUMENTS_ONLY.sections.document!.hits
    expect(screen.getByTestId(`palette-search-hit-document-${hits[0].id}`)).toBeInTheDocument()
    // No „Alle Treffer“ row: the composer picks, it does not leave for the search page.
    expect(screen.queryByTestId('palette-workspace-search')).toBeNull()
    act(() => ref.current?.move(1))
    act(() => {
      expect(ref.current?.selectActive()).toBe(true)
    })
    expect(onPick).toHaveBeenCalledWith(hits[1])
  })

  it('says it is searching while the answer is for older words', () => {
    render(german(<ComposerSearchPicker query="Fluchtweg" search={{ ...answered('Flucht'), loading: true }} onPick={() => {}} />))
    expect(screen.getByTestId('palette-search-status')).toHaveTextContent('Sucht…')
  })
})

describe('useDocumentReference', () => {
  it('asks the search for documents in the chat’s project, and a pick writes the name and hands over the hit', async () => {
    const asked: Array<{ url: string; body: SearchBody }> = []
    server.use(
      http.post('/api/search', async ({ request }) => {
        asked.push({ url: request.url, body: (await request.json()) as SearchBody })
        return HttpResponse.json(DOCUMENTS_ONLY)
      })
    )
    const onReplaceText = vi.fn()
    const onPick = vi.fn()
    const text = 'Was steht in #Flucht'
    const { result } = renderHook(() =>
      useDocumentReference({ text, enabled: true, scope: { scope: 'project', projectId: 'p1' }, onReplaceText, onPick })
    )
    act(() => result.current.syncQuery(text, text.length))
    expect(result.current.open).toBe(true)
    expect(result.current.query).toBe('Flucht')
    await waitFor(() => expect(result.current.search.response).not.toBeNull())
    expect(asked[0].body).toMatchObject({ text: 'Flucht', kinds: ['document'], facets: false })
    expect(new URL(asked[0].url).searchParams.get('projectId')).toBe('p1')

    const hit = DOCUMENTS_ONLY.sections.document!.hits[0]
    act(() => result.current.select(hit))
    expect(onReplaceText).toHaveBeenCalledWith(`Was steht in „${hit.title ?? hit.name}“ `, expect.any(Number))
    expect(onPick).toHaveBeenCalledWith(hit)
    expect(result.current.open).toBe(false)
  })

  it('stays out of the way when it is off, and Escape closes it until a fresh #', () => {
    const off = renderHook(() => useDocumentReference({ text: '#a', enabled: false, scope: {}, onReplaceText: vi.fn(), onPick: vi.fn() }))
    act(() => off.result.current.syncQuery('#a', 2))
    expect(off.result.current.open).toBe(false)

    const { result } = renderHook(() => useDocumentReference({ text: '#a', enabled: true, scope: {}, onReplaceText: vi.fn(), onPick: vi.fn() }))
    act(() => result.current.syncQuery('#a', 2))
    const escape = { key: 'Escape', shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    act(() => {
      expect(result.current.handleKeyDown(escape as never, vi.fn())).toBe(true)
    })
    expect(result.current.open).toBe(false)
    act(() => result.current.syncQuery('#a ', 3))
    act(() => result.current.syncQuery('#a #', 4))
    expect(result.current.open).toBe(true)
  })
})
