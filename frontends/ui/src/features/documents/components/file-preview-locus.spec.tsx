/**
 * A link that names a place in the document (`?page=` and `?highlight=`,
 * `lib/document-locus.ts`, a search hit's passage) opens the inline viewer
 * there: the pane hands the viewer the page and the passage, as a citation
 * does. Only for the document `doc` names.
 *
 * The viewer is a stand-in: what is pinned is what the pane hands it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import { FilePreviewPane } from './file-preview-pane'

const search = vi.hoisted(() => ({ current: '' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => new URLSearchParams(search.current),
}))

vi.mock('@/features/knowledge/components/pdf-document-view', () => ({
  PdfDocumentView: ({ page, highlight }: { page?: number | null; highlight?: string | null }) => (
    <div data-testid="inline-viewer" data-page={page ?? ''} data-highlight={highlight ?? ''} />
  ),
}))

const FILE = {
  id: 'doc-1',
  filename: 'brandschutz.pdf',
  displayName: null,
  fileSize: 1048576,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body }) as Response

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/annotations')) return json({ annotations: [], canAnnotate: true, pilotiWakes: false })
    if (url.endsWith('/preview')) return json({ url: 'https://example.test/brandschutz.pdf', contentType: 'application/pdf' })
    return json({}, 404)
  })
  // The well mounts its viewer once it has been on screen.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a link to a place in the document', () => {
  it('opens the viewer at the page, with the passage to light up', async () => {
    search.current = 'doc=doc-1&page=7&highlight=Die%20maximale%20Gehwegl%C3%A4nge'
    render(<FilePreviewPane file={FILE} projectId="proj-1" />)
    const viewer = await screen.findByTestId('inline-viewer')
    expect(viewer.dataset.page).toBe('7')
    expect(viewer.dataset.highlight).toBe('Die maximale Gehweglänge')
  })

  it('opens another document at its start', async () => {
    search.current = 'doc=doc-2&page=7&highlight=x'
    render(<FilePreviewPane file={FILE} projectId="proj-1" />)
    const viewer = await screen.findByTestId('inline-viewer')
    expect(viewer.dataset.page).toBe('')
    expect(viewer.dataset.highlight).toBe('')
  })
})
