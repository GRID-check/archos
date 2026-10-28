/**
 * Render tests for the DocumentAnswerCard — the chat surfacing card that presents
 * REAL project/Büroablage files. Focus: surfaced file names resolve to their
 * live document rows (project + Archiv), the card shows the human summary
 * (never the retrieval snippet / score), and a file that no longer resolves
 * degrades to a lean "not available" card instead of vanishing or crashing.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { DocumentAnswerCard, documentAnswerSearchHref } from './DocumentAnswerCard'
import { resetSurfacedDocumentsCache } from '@/features/documents/hooks/use-surfaced-documents'
import { resetThumbnailCache } from '@/features/documents/components/file-card'
import { resetFilePeekBinding } from '@/features/documents/lib/open-file-peek'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import { useChatStore } from '@/features/chat/store'
import { shelfPost } from '@/test-utils/shelf-handlers'

function row(id: string, filename: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    filename,
    fileSize: 1024,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    ...extra,
  }
}

afterEach(() => {
  resetSurfacedDocumentsCache()
  resetThumbnailCache()
  resetFilePeekBinding()
  useFilePreviewStore.setState({ file: null, hidden: false, mode: 'modal', context: {} })
  useChatStore.setState({ composerSubject: null })
})

describe('DocumentAnswerCard', () => {
  it('resolves surfaced files to project + Archiv rows and shows the human summary', async () => {
    server.use(
      shelfPost('project', '/api/documents/by-name', () =>
        HttpResponse.json({
          documents: [row('p1', 'Fluchtwegplan.pdf', { summary: 'Fluchtwegplan EG mit zweitem Ausgang.' })],
        }),
      ),
      shelfPost('office_shelf', '/api/documents/by-name', () =>
        HttpResponse.json({
          documents: [row('a1', 'Referenzprojekt.pdf', { summary: 'Vergleichbarer Grundriss aus dem Archiv.' })],
          collectionName: 'archiv_o',
          canManage: false,
        }),
      ),
      // Thumbnails fail → deterministic SVG sketch fallback (no backend needed).
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 })),
    )

    render(
      <DocumentAnswerCard
        title="Relevante Dokumente – Fluchtwege"
        query="Fluchtwege"
        projectId="proj-1"
        documents={[
          {
            file_name: 'Fluchtwegplan.pdf',
            snippet: '[DRAWING from page 1] ZEICHNUNGSTYP: Fluchtwegplan',
            page: 2,
            score: 0.83,
            source: 'project',
          },
          { file_name: 'Referenzprojekt.pdf', snippet: 'Ähnlicher Grundriss…', page: null, score: 0.6, source: 'office' },
        ]}
      />,
    )

    await waitFor(() =>
      expect(screen.getByText('Relevante Dokumente – Fluchtwege')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('document-answer-card')).toHaveAttribute('data-layout', 'choice')

    await waitFor(() => expect(screen.getByText('Fluchtwegplan.pdf')).toBeInTheDocument())
    expect(screen.getByText('Referenzprojekt.pdf')).toBeInTheDocument()
    expect(screen.getByText('Fluchtwegplan EG mit zweitem Ausgang.')).toBeInTheDocument()
    expect(screen.getByText('Vergleichbarer Grundriss aus dem Archiv.')).toBeInTheDocument()
    // Ranking leftovers stay off the card — they belong in Files search.
    expect(screen.queryByTestId('semantic-match')).not.toBeInTheDocument()
    expect(screen.queryByText(/DRAWING from page/)).not.toBeInTheDocument()
    expect(screen.queryByText('83%')).not.toBeInTheDocument()
    expect(screen.queryByText('60%')).not.toBeInTheDocument()
    expect(screen.queryByText(/2\.4 MB|1 KB|yesterday/i)).not.toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(screen.getByText('Office')).toBeInTheDocument()
  })

  it('degrades an unresolvable file to an honest, actionable card (not a dead tile)', async () => {
    server.use(
      shelfPost('project', '/api/documents/by-name', () => HttpResponse.json({ documents: [] })),
      // 403 = feature gate, fail-open — NOT a fetch error, so no retry state.
      shelfPost('office_shelf', '/api/documents/by-name', () => HttpResponse.json({}, { status: 403 }))
    )

    render(
      <DocumentAnswerCard
        title="Dokumente"
        documents={[{ file_name: 'Verschwunden.pdf', snippet: 'war mal da', source: 'project' }]}
        projectId="proj-1"
      />
    )

    await waitFor(() => expect(screen.getByText('Verschwunden.pdf')).toBeInTheDocument())
    // Honest explanation + a REAL action linking into the project files.
    expect(screen.getByText('The assistant referenced this file.')).toBeInTheDocument()
    const link = screen.getByTestId('document-answer-unresolved')
    expect(link).toHaveAttribute('href', '/app/projects/proj-1/files')
    expect(screen.getByText('Open in project files')).toBeInTheDocument()
    // Not the old dead "no longer available" grey box.
    expect(screen.queryByText('No longer available')).not.toBeInTheDocument()
  })

  it('shows a retry affordance (not dead tiles) when the resolve fetch genuinely fails', async () => {
    let projectCalls = 0
    server.use(
      shelfPost('project', '/api/documents/by-name', () => {
        projectCalls += 1
        // First load fails (5xx = genuine error); the retry succeeds.
        return projectCalls === 1
          ? HttpResponse.json({}, { status: 500 })
          : HttpResponse.json({ documents: [row('p1', 'Fluchtwegplan.pdf')] })
      }),
      shelfPost('office_shelf', '/api/documents/by-name', () => HttpResponse.json({}, { status: 403 })),
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 }))
    )

    render(
      <DocumentAnswerCard
        title="Dokumente"
        documents={[{ file_name: 'Fluchtwegplan.pdf', source: 'project' }]}
        projectId="proj-1"
      />
    )

    // Genuine failure → retry state, never a permanent dead tile.
    await waitFor(() => expect(screen.getByTestId('document-answer-error')).toBeInTheDocument())
    expect(screen.getByText('Documents couldn’t be loaded.')).toBeInTheDocument()
    expect(screen.queryByTestId('document-answer-unresolved')).not.toBeInTheDocument()

    // Retrying refetches and now resolves the file.
    await userEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(screen.getByText(/Fluchtwegplan\.pdf/)).toBeInTheDocument())
    expect(screen.getByTestId('document-answer-card')).toHaveAttribute('data-layout', 'receipt')
    expect(screen.queryByTestId('document-answer-error')).not.toBeInTheDocument()
  })

  it('renders nothing when there are no documents', () => {
    const { container } = render(<DocumentAnswerCard title="Leer" documents={[]} projectId="proj-1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('one file is a receipt that peeks; several files stay a choice', async () => {
    server.use(
      shelfPost('project', '/api/documents/by-name', () =>
        HttpResponse.json({ documents: [row('p1', 'Plan.dwg', { contentType: 'application/acad' })] })
      ),
      shelfPost('office_shelf', '/api/documents/by-name', () => HttpResponse.json({}, { status: 403 })),
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 })),
      http.get('/api/documents/:id/preview', () => HttpResponse.json({ url: null })),
      http.get('/api/documents/:id/visual-details', () => HttpResponse.json({ details: [] }))
    )

    render(
      <DocumentAnswerCard title="CAD" documents={[{ file_name: 'Plan.dwg', source: 'project' }]} projectId="proj-1" />
    )

    await waitFor(() => expect(screen.getByTestId('document-answer-card')).toHaveAttribute('data-layout', 'receipt'))
    expect(screen.getByText(/Plan\.dwg/)).toBeInTheDocument()
    await waitFor(() => expect(useFilePreviewStore.getState().file?.filename).toBe('Plan.dwg'))
    await userEvent.click(screen.getByText(/Plan\.dwg/))
    expect(useFilePreviewStore.getState().file?.filename).toBe('Plan.dwg')
  })

  it('does NOT cross corpora when the backend tagged a source (avoids opening a same-named file)', async () => {
    // Same filename in BOTH corpora; the surfaced hit is tagged 'office' but the
    // Archiv list is empty — it must resolve to nothing, never the project file.
    server.use(
      shelfPost('project', '/api/documents/by-name', () => HttpResponse.json({ documents: [row('p1', 'Bericht.pdf')] })),
      shelfPost('office_shelf', '/api/documents/by-name', () => HttpResponse.json({ documents: [] }))
    )

    render(
      <DocumentAnswerCard
        title="Test"
        documents={[{ file_name: 'Bericht.pdf', source: 'office' }]}
        projectId="proj-1"
      />
    )

    await waitFor(() => expect(screen.getByText('Bericht.pdf')).toBeInTheDocument())
    // Resolved to nothing → honest unresolved card linking to the ARCHIV (buero
    // source), never the same-named project file's card.
    expect(screen.getByText('The assistant referenced this file.')).toBeInTheDocument()
    expect(screen.getByTestId('document-answer-unresolved')).toHaveAttribute('href', '/app/office-shelf')
    expect(screen.getByText('Open in Office filing')).toBeInTheDocument()
    expect(screen.queryByText('Project')).not.toBeInTheDocument()
  })

  it('offers the workspace search with the same question when the files came from it', async () => {
    server.use(
      shelfPost('project', '/api/documents/by-name', () =>
        HttpResponse.json({ documents: [row('p1', 'Grundriss EG.pdf'), row('p2', 'Grundriss OG.pdf')] }),
      ),
      shelfPost('office_shelf', '/api/documents/by-name', () => HttpResponse.json({}, { status: 403 })),
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 })),
    )

    render(
      <DocumentAnswerCard
        title="Grundrisse"
        query="Grundriss"
        search={{ text: 'Grundriss', scope: 'project' }}
        documents={[
          { file_name: 'Grundriss EG.pdf', source: 'project' },
          { file_name: 'Grundriss OG.pdf', source: 'project' },
        ]}
        projectId="0d7b3a5e-7c1c-4a4e-9a63-6a4a1f5f1c11"
      />,
    )

    const link = await screen.findByTestId('document-answer-open-search')
    expect(link).toHaveTextContent('Open in search')
    expect(link).toHaveAttribute('href', '/app/search?q=Grundriss&project=0d7b3a5e-7c1c-4a4e-9a63-6a4a1f5f1c11')
  })

  it('offers no search when the files did not come from one', async () => {
    server.use(
      shelfPost('project', '/api/documents/by-name', () => HttpResponse.json({ documents: [row('p1', 'Plan.pdf')] })),
      shelfPost('office_shelf', '/api/documents/by-name', () => HttpResponse.json({}, { status: 403 })),
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 })),
    )

    render(<DocumentAnswerCard title="Plan" documents={[{ file_name: 'Plan.pdf', source: 'project' }]} projectId="proj-1" />)

    await waitFor(() => expect(screen.getByText(/Plan\.pdf/)).toBeInTheDocument())
    expect(screen.queryByTestId('document-answer-open-search')).not.toBeInTheDocument()
  })
})

describe('documentAnswerSearchHref', () => {
  it('opens the scope the search ran in', () => {
    expect(documentAnswerSearchHref({ text: 'Statik', scope: 'office' }, 'p1')).toBe('/app/search?q=Statik')
    expect(documentAnswerSearchHref({ text: 'Statik', scope: 'office_shelf' }, null)).toBe(
      '/app/office-shelf?q=Statik&mode=search',
    )
  })

  it('widens a project search to the office when the card knows no project', () => {
    expect(documentAnswerSearchHref({ text: 'Statik', scope: 'project' }, null)).toBe('/app/search?q=Statik')
  })
})
