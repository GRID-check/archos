/**
 * The excerpt of a cited page: drawn only once asked for, with the quote
 * marked where the viewer would mark it; the whole page, saying so, when the
 * quote is not in its text; a line instead of a broken frame when there is
 * nothing to draw. pdf.js is the shared fake, so this is the real path from
 * the file's name to the drawn page.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDocumentsByNameCache, setDocumentsByNameFetch } from '@/features/documents/lib/documents-by-name'
import type { ProfileEvidence } from '@/lib/project-intake/types'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { fakePdfjsRuntime, fakeTextRun, type FakePdfState } from '@/test-utils/pdfjs-fake'
import { EvidenceProjectContext } from '../evidence-chips'
import { resetExcerptDocuments } from './excerpt-loader'
import { ValueEvidence } from './value-evidence'

const state = vi.hoisted((): FakePdfState => ({ fail: false, pages: [], destroyed: 0 }))
vi.mock('@/features/knowledge/lib/pdfjs-runtime', () => fakePdfjsRuntime(state))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const QUOTE = 'Fluchtniveau +18,40 m über Gelände'
const byName = vi.fn()
let restoreObservers: () => void = () => undefined

const evidence = (fileName: string, page: number | null, quote = QUOTE): ProfileEvidence => ({
  kind: 'document',
  fileName,
  page,
  quote,
})

function ui(entries: ProfileEvidence[], excerptOpen = false) {
  return (
    <EvidenceProjectContext.Provider value="project-1">
      <ValueEvidence item={{ state: 'suggested', evidence: entries, alternatives: [] }} excerptOpen={excerptOpen} />
    </EvidenceProjectContext.Provider>
  )
}

describe('PageExcerpt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetExcerptDocuments()
    restoreObservers = installLayoutObservers()
    resetDocumentsByNameCache()
    state.fail = false
    state.destroyed = 0
    state.pages = [{ items: [fakeTextRun('Schnitt A-A', 760, 120) ] }, { items: [fakeTextRun(QUOTE, 400, 220)] }]
    byName.mockImplementation(async (_path: string, init?: RequestInit) => {
      const names = (JSON.parse(String(init?.body ?? '{}')) as { names?: string[] }).names ?? []
      return new Response(
        JSON.stringify({
          documents: names
            .filter((name) => name === 'E-02 Schnitt.pdf')
            .map((name) => ({ id: 'doc-schnitt', filename: name, createdAt: '2026-10-14T08:30:00.000Z', contentType: 'application/pdf' })),
        }),
        { status: 200 }
      )
    })
    // One route answers both shelves; only the project's own is counted, the office shelf answers empty.
    setDocumentsByNameFetch(async (path, init) =>
      path === '/api/documents/by-name' && !String(init?.body).includes('"office_shelf"')
        ? byName(path, init)
        : new Response('{"documents":[]}')
    )
  })
  afterEach(() => {
    setDocumentsByNameFetch()
    restoreObservers()
  })

  it('fetches nothing until the excerpt is asked for, then draws the page with the quote marked', async () => {
    render(ui([evidence('E-02 Schnitt.pdf', 2)]))
    expect(screen.queryByTestId('page-excerpt')).toBeNull()
    expect(byName).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Show the excerpt of E-02 Schnitt.pdf, page 2' }))

    await waitFor(() => expect(screen.getByTestId('page-excerpt')).toHaveAttribute('data-state', 'drawn'))
    expect(screen.getByRole('img', { name: 'Excerpt of E-02 Schnitt.pdf, page 2' })).toBeInTheDocument()
    expect(screen.getAllByTestId('region-mark')).toHaveLength(1)
    expect(screen.queryByText(/whole page/)).toBeNull()
  })

  it('shows the whole page, and says so, when the quote is not in its text', async () => {
    render(ui([evidence('E-02 Schnitt.pdf', 1)], true))
    await waitFor(() => expect(screen.getByTestId('page-excerpt')).toHaveAttribute('data-state', 'drawn'))
    expect(screen.queryByTestId('region-mark')).toBeNull()
    expect(screen.getByText('The passage cannot be marked on this page. You are seeing the whole page.')).toBeInTheDocument()
  })

  it('says there is no excerpt for a file the project does not hold, or a page it does not have', async () => {
    render(ui([evidence('Verschwunden.pdf', 1)], true))
    await waitFor(() => expect(screen.getByTestId('page-excerpt')).toHaveAttribute('data-state', 'unavailable'))
    expect(screen.getByText(/There is no excerpt for this page/)).toBeInTheDocument()
  })

  it('says so when pdf.js will not load, rather than showing a broken frame', async () => {
    state.fail = true
    render(ui([evidence('E-02 Schnitt.pdf', 2)], true))
    await waitFor(() => expect(screen.getByTestId('page-excerpt')).toHaveAttribute('data-state', 'unavailable'))
  })

  it('offers no excerpt for a file with no page or one that is not a PDF', () => {
    render(ui([evidence('Wohnungsliste.xlsx', null), evidence('Baubeschreibung.docx', 2)]))
    expect(screen.queryByTestId('page-excerpt-toggle')).toBeNull()
  })

  it('opens one document once for several excerpts of it', async () => {
    const { unmount } = render(ui([evidence('E-02 Schnitt.pdf', 2)], true))
    await waitFor(() => expect(screen.getByTestId('page-excerpt')).toHaveAttribute('data-state', 'drawn'))
    unmount()
    render(ui([evidence('E-02 Schnitt.pdf', 1)], true))
    await waitFor(() => expect(screen.getByTestId('page-excerpt')).toHaveAttribute('data-state', 'drawn'))
    expect(state.destroyed).toBe(0)
    expect(byName).toHaveBeenCalledTimes(1)
  })
})
