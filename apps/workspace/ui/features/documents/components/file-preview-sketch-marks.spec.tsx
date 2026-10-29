/**
 * A Skizze's Anmerkungen in the Files preview (migration 0192): drawn over its
 * one sheet as a PDF page's are, and its review is the sketch editor, which the
 * preview's action slot owns. So a link with `?review=1&mark=` opens the
 * action at that mark, never the PDF review, and hands it the preview's review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import type { AnnotationView } from '@/lib/annotations/types'
import { PreviewDocumentActionProvider, type PreviewDocumentActionProps } from '../preview-actions'
import { FilePreviewPane } from './file-preview-pane'

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => nav.params,
}))
vi.mock('./review/document-review', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DocumentReviewMode: ({ open }: { open: boolean }) => (open ? <div data-testid="review-mode" /> : null),
}))

const SKETCH = {
  id: 'doc-svg',
  filename: 'Stiege.svg',
  displayName: null,
  fileSize: 2048,
  contentType: 'image/svg+xml',
  authoredBy: 'agent' as const,
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

const pinned = {
  id: 'ann-1',
  documentId: 'doc-svg',
  number: 1,
  page: 1,
  shape: 'region',
  x: 0.1,
  y: 0.1,
  w: 0.3,
  h: 0.2,
  elementIds: ['stair'],
  anchorLost: false,
  kind: 'hint',
  body: 'Breite prüfen',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  revisionNumber: 2,
  onCurrentRevision: true,
  createdBy: 'user_anna',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  delegatedBy: null,
  delegatedByName: null,
  delegatedAt: null,
  replies: [],
  canEdit: true,
  canDelete: true,
} satisfies AnnotationView

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as Response

let restoreLayout = () => {}
beforeEach(() => {
  restoreLayout = installLayoutObservers({ frameWidth: 800, intersecting: true })
  nav.params = new URLSearchParams('doc=doc-svg')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/annotations')) return json({ annotations: [pinned], canAnnotate: true, pilotiWakes: false })
    if (url.endsWith('/preview')) return json({ url: 'https://example.test/stiege.svg' })
    return json({}, 404)
  })
})
afterEach(() => {
  restoreLayout()
  vi.restoreAllMocks()
})

const seen: PreviewDocumentActionProps[] = []
function RecordingAction(props: PreviewDocumentActionProps) {
  seen.push(props)
  return <div data-testid="sketch-action" data-open={String(props.reviewRequest?.open ?? false)} data-mark={props.reviewRequest?.annotationId ?? ''} />
}

const pane = () => (
  <PreviewDocumentActionProvider action={RecordingAction}>
    <FilePreviewPane file={SKETCH} projectId="proj-1" />
  </PreviewDocumentActionProvider>
)

describe('a Skizze in the Files preview', () => {
  it('draws its marks over its sheet', async () => {
    render(pane())
    const sheet = await screen.findByTestId('sketch-sheet')
    await waitFor(() => expect(sheet.querySelector('[data-testid="review-layer-1"]')).not.toBeNull())
  })

  it('opens a review link in the sketch editor at its mark, not in the PDF review', async () => {
    nav.params = new URLSearchParams('doc=doc-svg&review=1&mark=ann-1')
    render(pane())
    await waitFor(() => expect(screen.getByTestId('sketch-action').dataset.open).toBe('true'))
    expect(screen.getByTestId('sketch-action').dataset.mark).toBe('ann-1')
    expect(screen.queryByTestId('review-mode')).toBeNull()
    expect(seen.at(-1)?.review?.annotations.map((mark) => mark.id)).toEqual(['ann-1'])
  })
})
