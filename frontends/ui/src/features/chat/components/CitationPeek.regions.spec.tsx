/**
 * A citation peek whose locus carries a region shows the cited page with the
 * place marked (ADR-0128, "Citations become places"). Drawing the page is
 * pdf.js's business and is replaced by a recorder; the claims are which page,
 * which box, and that a peek without a region or without a drawable PDF is
 * what it always was.
 */

import { render, screen, waitFor } from '@/test-utils'
import { describe, expect, test, vi } from 'vitest'
import { buildCitationModel, resolveCitationTarget, type CitationRef } from '../lib/citations'
import type { CitationSource } from '../types'
import { CitationPeek } from './CitationPeek'
import { thumbnailDocumentId } from './CitationPageThumbnail'

const pdf = vi.hoisted(() => ({
  getPage: vi.fn(),
  fail: false,
}))

vi.mock('@/features/knowledge/lib/pdfjs-runtime', () => ({
  documentParameters: (url: string) => ({ url }),
  loadPdfjs: async () => ({
    getDocument: ({ url }: { url: string }) => ({
      promise: pdf.fail
        ? Promise.reject(new Error('gone'))
        : Promise.resolve({
            numPages: 6,
            getPage: async (page: number) => {
              pdf.getPage(url, page)
              return {
                getViewport: ({ scale }: { scale: number }) => ({
                  width: 600 * scale,
                  height: 400 * scale,
                }),
                render: () => ({ cancel: () => {}, promise: Promise.resolve() }),
              }
            },
          }),
      destroy: async () => {},
    }),
  }),
}))

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: (s: unknown) => unknown) => {
    const state = { projectId: null }
    return selector ? selector(state) : state
  }),
}))

const REGION = {
  box: [0.1, 0.2, 0.6, 0.7] as [number, number, number, number],
  label: 'Grundriss 1. OG',
}

const citationWith = (overrides: Partial<CitationSource>): CitationRef => {
  const [document] = buildCitationModel({
    citations: [
      {
        id: 'c-1',
        content: '[KB] plan.pdf, p.4',
        timestamp: new Date('2026-10-01T10:00:00Z'),
        citationKey: 'plan.pdf, p.4',
        fileName: 'plan.pdf',
        kind: 'project',
        page: 4,
        isCited: true,
        snippet: '[DRAWING from page 4] Grundriss 1. OG.',
        ...overrides,
      },
    ],
  })
  return { document: document!, locus: document!.loci[0] }
}

const storedPdf = (citation: CitationRef) =>
  thumbnailDocumentId(
    resolveCitationTarget(citation.document, {
      locus: citation.locus,
      storedDocuments: [{ id: 'doc-9', filename: 'plan.pdf', contentType: 'application/pdf' }],
    })
  )

describe('CitationPeek page thumbnail', () => {
  test('draws the cited page and marks the region', async () => {
    pdf.fail = false
    const citation = citationWith({ regions: [REGION] })
    const documentId = storedPdf(citation)
    expect(documentId).toBe('doc-9')

    render(
      <CitationPeek
        citation={citation}
        snippet="x"
        onOpen={() => {}}
        thumbnailDocumentId={documentId}
      />
    )

    await waitFor(() => expect(screen.getByTestId('region-mark')).toBeInTheDocument())
    expect(pdf.getPage).toHaveBeenCalledWith(expect.stringContaining('doc-9'), 4)
    expect(screen.getByRole('img', { name: 'Grundriss 1. OG' })).toBeInTheDocument()
  })

  test('no region, no thumbnail', () => {
    const citation = citationWith({})
    render(
      <CitationPeek
        citation={citation}
        snippet="x"
        onOpen={() => {}}
        thumbnailDocumentId={storedPdf(citation)}
      />
    )
    expect(document.querySelector('[data-citation-thumbnail]')).toBeNull()
  })

  test('a page that cannot be drawn leaves the peek as it was', async () => {
    pdf.fail = true
    const citation = citationWith({ regions: [REGION] })
    render(
      <CitationPeek
        citation={citation}
        snippet="x"
        onOpen={() => {}}
        thumbnailDocumentId={storedPdf(citation)}
      />
    )
    await waitFor(() => expect(document.querySelector('[data-citation-thumbnail]')).toBeNull())
    expect(screen.queryByTestId('region-mark')).toBeNull()
  })

  test('only a stored PDF is drawn', () => {
    const citation = citationWith({
      regions: [REGION],
      fileName: 'plan.docx',
      citationKey: 'plan.docx, p.4',
    })
    const target = resolveCitationTarget(citation.document, {
      locus: citation.locus,
      storedDocuments: [
        {
          id: 'doc-9',
          filename: 'plan.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
    })
    expect(thumbnailDocumentId(target)).toBeUndefined()
  })
})
