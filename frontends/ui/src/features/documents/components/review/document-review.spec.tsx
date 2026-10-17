/**
 * The full-screen review around the page layer: the tools as the reader first
 * meets them, the walk through Piloti's proposals, the way out to a window of
 * its own, and the tool the review is opened with.
 *
 * The viewer is a stand-in that lays page 1's overlay and the tools it is
 * handed into its pill, as the real one does: what is pinned here is the
 * review's side of that contract, not PDF rendering.
 */

import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { act, fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { server } from '@/mocks/server'
import type { RoomFrame } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import { useDocumentReview, type ReviewTool } from '../../hooks/use-document-review'
import type { RoomTransport } from '../../hooks/use-document-room'
import { DocumentReviewMode, TOOLS_INTRO_KEY } from './document-review'

vi.mock('@/features/chat', () => ({
  useChatStore: (selector: (state: { currentUserId: string }) => unknown) => selector({ currentUserId: 'user_me' }),
}))

vi.mock('@/features/knowledge/components/pdf-document-view', () => ({
  PdfDocumentView: ({ pageOverlay, toolbarLead }: { pageOverlay?: (page: number) => ReactNode; toolbarLead?: ReactNode }) => (
    <div>
      <div data-testid="pdf-floating-toolbar">{toolbarLead}</div>
      <div style={{ position: 'relative', width: 800, height: 600 }}>
        <div>{pageOverlay?.(1)}</div>
      </div>
    </div>
  ),
}))

const view = (overrides: Partial<AnnotationView>): AnnotationView => ({
  id: 'ann_1',
  documentId: 'doc_1',
  number: 1,
  page: 1,
  shape: 'point',
  x: 0.25,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Tür ohne Feuerwiderstandsklasse',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  fassungNumber: 2,
  onCurrentFassung: true,
  createdBy: 'user_me',
  createdByName: 'Miriam Hofer',
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
  ...overrides,
})

const room = (): RoomTransport => ({
  connect({ onFrame, onOpen }) {
    onOpen()
    onFrame({ kind: 'welcome', self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } } as RoomFrame)
    return () => {}
  },
  post: () => {},
})

function Host({
  popoutHref,
  initialTool,
  onOpenChange = () => {},
}: {
  popoutHref?: string | null
  initialTool?: ReviewTool
  onOpenChange?: (open: boolean) => void
}) {
  const [transport] = useState(room)
  const review = useDocumentReview('doc_1', { enabled: true, transport })
  return (
    <DocumentReviewMode
      open
      onOpenChange={onOpenChange}
      review={review}
      documentName="Grundriss.pdf"
      canPickAssignee={false}
      popoutHref={popoutHref}
      initialTool={initialTool}
    />
  )
}

const serve = (annotations: AnnotationView[]) =>
  server.use(
    http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations, canAnnotate: true, pilotiWakes: false }))
  )

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the tools', () => {
  it('are spelled out the first time a browser opens a review, and fold for good', async () => {
    serve([])
    const { unmount } = render(<Host />)
    const tools = await screen.findByTestId('review-tools')
    // In the viewer's own pill: one bar at the foot, not two.
    expect(within(screen.getByTestId('pdf-floating-toolbar')).getByTestId('review-tools')).toBe(tools)
    await waitFor(() => expect(tools).toHaveAttribute('data-variant', 'intro'))
    expect(within(tools).getByText('Comment')).toBeInTheDocument()
    expect(within(tools).getByText('Area')).toBeInTheDocument()
    expect(within(tools).getByText('R')).toBeInTheDocument()

    await userEvent.click(within(tools).getByTestId('review-tools-fold'))
    expect(screen.getByTestId('review-tools')).toHaveAttribute('data-variant', 'icons')
    expect(window.localStorage.getItem(TOOLS_INTRO_KEY)).toBe('1')

    unmount()
    render(<Host />)
    expect(await screen.findByTestId('review-tools')).toHaveAttribute('data-variant', 'icons')
  })

  it('arms the tool the review was opened with, and says what it does next', async () => {
    serve([])
    render(<Host initialTool="point" />)
    await waitFor(() => expect(screen.getByTestId('review-tool-point')).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByTestId('review-tool-hint')).toHaveTextContent('Click the place · Esc cancels')
  })

  it('keeps the cursor chat apart from the comment tool: its own glyph, and no pointer to open at from its button', async () => {
    serve([])
    render(<Host />)
    await userEvent.click(await screen.findByTestId('review-tool-chat'))
    const bubble = screen.getByTestId('cursor-chat')
    // Opened from the button, not at the corner of the toolbar it was pressed in: a plain bubble.
    expect(bubble.className).not.toContain('rounded-tl-sm')
    const glyph = (testId: string) => screen.getByTestId(testId).querySelector('svg')?.getAttribute('class')
    expect(glyph('review-tool-chat')).not.toEqual(glyph('review-tool-point'))
  })
})

describe('going through the proposals', () => {
  it('says where the proposal in hand stands, and moves on once it is decided', async () => {
    let marks = [
      view({ id: 'p1', number: 1, authorKind: 'piloti', status: 'proposed', body: 'Erster Befund' }),
      view({ id: 'p2', number: 2, authorKind: 'piloti', status: 'proposed', body: 'Zweiter Befund' }),
      view({ id: 'p3', number: 3, authorKind: 'piloti', status: 'proposed', body: 'Dritter Befund' }),
    ]
    serve(marks)
    server.use(
      http.patch('/api/documents/:id/annotations/:annotationId', ({ params }) => {
        marks = marks.map((mark) => (mark.id === params.annotationId ? { ...mark, status: 'open', acceptedBy: 'user_me' } : mark))
        return HttpResponse.json({ annotation: marks.find((mark) => mark.id === params.annotationId) })
      })
    )
    render(<Host />)

    await userEvent.click(await screen.findByTestId('review-walk-proposals'))
    let thread = await screen.findByTestId('review-thread')
    expect(within(thread).getByTestId('thread-walk')).toHaveTextContent('1/3')
    expect(within(thread).getByText('Erster Befund')).toBeInTheDocument()

    await userEvent.click(within(thread).getByTestId('thread-accept'))
    await waitFor(() => expect(within(screen.getByTestId('review-thread')).getByText('Zweiter Befund')).toBeInTheDocument())
    thread = screen.getByTestId('review-thread')
    expect(within(thread).getByTestId('thread-walk')).toHaveTextContent('1/2')

    await userEvent.click(within(thread).getByTestId('thread-walk-next'))
    expect(within(screen.getByTestId('review-thread')).getByText('Dritter Befund')).toBeInTheDocument()
    expect(screen.getByTestId('thread-walk')).toHaveTextContent('2/2')
  })
})

describe('the review on a page of its own', () => {
  it('opens in a window of its own, and copies its link', async () => {
    serve([])
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<Host popoutHref="/projects/p1/files?doc=doc_1&review=1" />)

    await userEvent.click(await screen.findByTestId('review-popout'))
    expect(opened).toHaveBeenCalledWith('/projects/p1/files?doc=doc_1&review=1', '_blank', 'popup,width=1440,height=900')

    await act(async () => {
      await userEvent.click(screen.getByTestId('review-copy-link'))
    })
    expect(writeText).toHaveBeenCalledWith(new URL('/projects/p1/files?doc=doc_1&review=1', window.location.href).toString())
  })

  it('offers neither without a page to open', async () => {
    serve([])
    render(<Host />)
    await screen.findByTestId('review-tools')
    expect(screen.queryByTestId('review-popout')).toBeNull()
    expect(screen.queryByTestId('review-copy-link')).toBeNull()
  })
})

describe('Escape', () => {
  it('steps back one thing at a time through the real dialog: the draft, the tool, the card, then the review', async () => {
    serve([view({ id: 'ann_1' })])
    const onOpenChange = vi.fn()
    render(<Host onOpenChange={onOpenChange} />)
    await screen.findByTestId('review-row')

    await userEvent.keyboard('c')
    const capture = await screen.findByTestId('review-capture')
    vi.spyOn(capture, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    capture.setPointerCapture = () => {}
    fireEvent.pointerDown(capture, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(capture, { clientX: 100, clientY: 100, pointerId: 1 })
    expect(await screen.findByTestId('review-draft')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('review-draft')).toBeNull())
    expect(screen.getByTestId('review-tool-point')).toHaveAttribute('aria-pressed', 'true')

    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('review-tool-point')).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(screen.getByTestId('review-row'))
    expect(await screen.findByTestId('review-thread')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('review-thread')).toBeNull())
    expect(onOpenChange).not.toHaveBeenCalled()

    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
