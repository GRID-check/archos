/**
 * Evidence chips: a document chip is the chat's own source chip (project
 * provenance signal, hover peek, the same viewer), and the other evidence is
 * neutral because it is not a document source.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSourcePreviewIndexCache } from '@/features/chat/components/SourcePreview'
import { setDocumentsByNameFetch } from '@/features/documents/lib/documents-by-name'
import type { ProfileEvidence } from '@/lib/project-intake/types'
import { citationOfEvidence, EvidenceChips, EvidenceProjectContext } from './evidence-chips'

const viewer = vi.hoisted(() => vi.fn())
vi.mock('@/features/knowledge/components/pdf-viewer-dialog', () => ({
  PdfViewerDialog: (props: { open: boolean; fileName: string; page?: number | null; highlight?: string | null; highlightColor?: string }) => {
    viewer(props)
    return props.open ? <div role="dialog" aria-label="viewer" /> : null
  },
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const QUOTE = 'Das Gebäude erhält nach der Aufstockung insgesamt sechs oberirdische Geschoße.'
const document: ProfileEvidence = { kind: 'document', fileName: 'Baubeschreibung.pdf', page: 3, quote: QUOTE }
const byName = vi.fn()

function ui(evidence: readonly ProfileEvidence[]) {
  return (
    <EvidenceProjectContext.Provider value="project-1">
      <EvidenceChips evidence={evidence} />
    </EvidenceProjectContext.Provider>
  )
}

describe('EvidenceChips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSourcePreviewIndexCache()
    byName.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          documents: [
            { id: 'doc-1', filename: 'Baubeschreibung.pdf', createdAt: '2026-10-14T08:30:00.000Z', contentType: 'application/pdf' },
          ],
        }),
        { status: 200 }
      )
    )
    setDocumentsByNameFetch(async (path, init) => (path === '/api/documents/by-name' ? byName(path, init) : new Response('{"documents":[]}')))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ url: 'https://files.example/doc-1' }), { status: 200 }))
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setDocumentsByNameFetch()
  })

  it('opens the document at its page with the quote marked, in the chat\'s viewer', async () => {
    render(ui([document]))

    await userEvent.click(await screen.findByRole('button', { name: /Baubeschreibung\.pdf, p\. 3/ }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'viewer' })).toBeInTheDocument())
    expect(viewer).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, fileName: 'Baubeschreibung.pdf', page: 3, highlight: QUOTE })
    )
    // Resolved by name in the page's own project, not in whatever chat was last open.
    expect(JSON.parse(String(byName.mock.calls[0][1].body))).toEqual({ projectId: 'project-1', names: ['Baubeschreibung.pdf'] })
  })

  it('shows the quote on hover without opening anything', async () => {
    render(ui([document]))

    await userEvent.hover(await screen.findByRole('button', { name: /Baubeschreibung\.pdf, p\. 3/ }))

    expect(await screen.findByText(QUOTE)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'viewer' })).toBeNull()
  })

  it('is the chat\'s project source chip: icon and words, and the viewer marks in the project colour', async () => {
    render(ui([document]))
    const chip = await screen.findByRole('button', { name: /Baubeschreibung\.pdf, p\. 3/ })

    expect(chip.querySelector('svg')).not.toBeNull()
    expect(chip).toHaveTextContent('Baubeschreibung.pdf, p. 3')
    // Not the neutral chip the other evidence wears.
    expect(chip.closest('[data-slot="chip"]')).toBeNull()

    await userEvent.click(chip)
    await waitFor(() =>
      expect(viewer).toHaveBeenLastCalledWith(expect.objectContaining({ highlightColor: 'var(--source-project)' }))
    )
  })

  it('keeps the address search, a derivation and the person\'s own answer neutral', () => {
    render(
      ui([
        { kind: 'geocoder', provider: 'photon', label: 'Lacknergasse 12, 1170 Wien', resolvedAt: '2026-10-14T08:30:00.000Z' },
        { kind: 'derivation', rule: 'gebaeudeklasse', citation: 'OIB', inputs: [] },
        { kind: 'person', userId: 'u', at: '2026-10-14T08:30:00.000Z' },
      ])
    )

    const chips = screen.getByTestId('evidence-chips').querySelectorAll('[data-slot="chip"]')
    expect(chips).toHaveLength(3)
    for (const chip of chips) {
      expect(chip.getAttribute('style') ?? '').not.toContain('--source-')
      expect(chip.className).toMatch(/bg-muted/)
    }
  })

  it('cites a project file at the page and passage, and a page-less one by its passage alone', () => {
    const withPage = citationOfEvidence(document as Extract<ProfileEvidence, { kind: 'document' }>)
    expect(withPage.document).toMatchObject({ kind: 'projekt', tint: 'project', shelf: 'project', fileName: 'Baubeschreibung.pdf' })
    expect(withPage.locus).toMatchObject({ page: 3, snippet: QUOTE, isCited: true })

    const noPage = citationOfEvidence({ kind: 'document', fileName: 'Wohnungsliste.xlsx', page: null, quote: 'Top 1 bis Top 14' })
    expect(noPage.locus?.page).toBeUndefined()
    expect(noPage.locus?.snippet).toBe('Top 1 bis Top 14')
  })
})
