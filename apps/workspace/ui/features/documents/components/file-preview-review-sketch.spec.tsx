/**
 * A page has one canvas, its review (slice 1 of `docs/roadmap/working-on-a-plan.md`):
 *
 *   - the preview's PDF toolbar carries no sketch entry of its own, even with
 *     the diagrams feature's page action provided: that entry is the review's;
 *   - what the review's page menu made (a Skizze) opens as its own document,
 *     with its review, the way every Skizze opens (`?doc=…&review=1`), so its
 *     Anmerkungen work from the first open;
 *   - a link to a page's review (`?review=1&page=4`, a Skizze's „Zur Seite 4“)
 *     opens the review at that page.
 *
 * The viewer and the review are stand-ins: what is pinned is the pane's side.
 */

import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'
import type * as ReviewModule from './review/document-review'
import { PreviewDocumentActionProvider } from '../preview-actions'
import { FilePreviewPane } from './file-preview-pane'

const nav = vi.hoisted(() => ({ params: new URLSearchParams('doc=doc-1'), push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => nav.params,
}))

vi.mock('@/features/knowledge/components/pdf-document-view', () => ({
  PdfDocumentView: ({ toolbarLead }: { toolbarLead?: ReactNode | ((page: number) => ReactNode) }) => (
    <div data-testid="inline-viewer">{typeof toolbarLead === 'function' ? toolbarLead(1) : toolbarLead}</div>
  ),
}))

type ReviewModeProps = ComponentProps<typeof ReviewModule.DocumentReviewMode>
vi.mock('./review/document-review', async (importOriginal) => {
  const actual = await importOriginal<typeof ReviewModule>()
  return {
    ...actual,
    DocumentReviewMode: (props: ReviewModeProps) =>
      props.open ? (
        <div data-testid="review-mode" data-page={props.focusRequest?.page ?? ''}>
          {props.openCreated && (
            <button type="button" onClick={() => props.openCreated?.('sketch-9')}>
              made a sketch
            </button>
          )}
        </div>
      ) : null,
  }
})

const FILE = {
  id: 'doc-1',
  filename: 'plan.pdf',
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

const PageAction = () => <span data-testid="page-action" />
const pane = () =>
  render(
    <PreviewDocumentActionProvider action={() => null} pageAction={PageAction}>
      <FilePreviewPane file={FILE} projectId="proj-1" />
    </PreviewDocumentActionProvider>
  )

beforeEach(() => {
  nav.params = new URLSearchParams('doc=doc-1')
  nav.push.mockReset()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/annotations')) return json({ annotations: [], canAnnotate: true })
    if (url.endsWith('/preview')) return json({ url: 'https://example.test/plan.pdf', contentType: 'application/pdf' })
    return json({}, 404)
  })
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

describe('one canvas per page', () => {
  it('puts no sketch entry in the preview’s toolbar', async () => {
    pane()
    await screen.findByTestId('inline-viewer')
    expect(screen.queryByTestId('page-action')).toBeNull()
  })

  it('opens the Skizze the review made as its own document, with its review', async () => {
    pane()
    fireEvent.click(await screen.findByRole('button', { name: 'Open review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'made a sketch' }))
    await waitFor(() => expect(nav.push).toHaveBeenCalled())
    const href = new URL(nav.push.mock.calls.at(-1)?.[0] as string, 'https://app.test')
    expect(href.pathname).toBe('/app/projects/proj-1/files')
    expect(href.searchParams.get('doc')).toBe('sketch-9')
    expect(href.searchParams.get('review')).toBe('1')
  })

  it('opens the review at the page a link names', async () => {
    nav.params = new URLSearchParams('doc=doc-1&review=1&page=4')
    pane()
    expect((await screen.findByTestId('review-mode')).dataset.page).toBe('4')
  })
})
