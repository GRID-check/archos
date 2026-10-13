/**
 * The `canvas_activity` card: what Piloti did on a document, and the reader's
 * answer per mark.
 *
 * What this file holds the card to:
 *
 * 1. **One decision per mark**, stored on the message under
 *    `itemDecisionKey`, through the annotations client's PATCH. A stored
 *    decision draws the mark answered and offers nothing again.
 * 2. **The canvas wins.** A mark a colleague answered on the canvas reads as
 *    answered here, and a 409 re-reads instead of recording a decision the
 *    reader never made.
 * 3. **Taking over reads first**, because the API lets a discarded mark be
 *    opened again and a 409 would not stop it.
 * 4. **„Im Dokument zeigen" opens the Prüfansicht at that mark** through
 *    `openReviewAt`, the one way into the review.
 *
 * Rendered without an `I18nProvider`, so the dictionary falls back to `en`.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationView } from '@/lib/annotations/types'
import type { CardInteractions } from '../card-decision'
import type { CanvasActivityItem } from '../lib/canvas-activity'
import { CanvasActivityCard } from './CanvasActivityCard'

let mockCardInteractions: CardInteractions | undefined
const setCardDecision = vi.fn()

const mockStoreState = () => ({
  projectId: 'proj-1',
  currentConversation: { id: 'conv-1', messages: [{ id: 'msg-1', cardInteractions: mockCardInteractions }] },
  conversations: [],
  setCardDecision,
})

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: ReturnType<typeof mockStoreState>) => unknown) => selector(mockStoreState())
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

const openReviewAt = vi.fn(async () => 'beside' as const)
vi.mock('@/features/documents/lib/open-review', () => ({
  openReviewAt: (...args: unknown[]) => openReviewAt(...(args as [])),
}))

const DOC = { id: '00000000-0000-4000-8000-0000000000d1', name: 'Grundriss EG.pdf' }

const STAIR: CanvasActivityItem = {
  action: 'proposed',
  annotation_id: 'ann-7',
  number: 7,
  page: 1,
  shape: 'region',
  x: 0.5,
  y: 0.25,
  w: 0.2,
  h: 0.1,
  kind: 'defect',
  body: 'Laufbreite im Treppenhaus unter 1,20 m.',
}

const DOOR: CanvasActivityItem = {
  action: 'proposed',
  annotation_id: 'ann-8',
  number: 8,
  page: 2,
  shape: 'point',
  x: 0.3,
  y: 0.6,
  kind: 'question',
  body: 'Ist die Tür zum Müllraum EI2 30-C?',
}

const REPLY: CanvasActivityItem = {
  action: 'replied',
  annotation_id: 'ann-4',
  number: 4,
  excerpt: 'Im Türenbuch als EI2 30-C geführt.',
}

const view = (id: string, number: number, patch: Partial<AnnotationView> = {}): AnnotationView => ({
  id,
  documentId: DOC.id,
  number,
  page: 1,
  shape: 'point',
  x: 0.5,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'x',
  basis: null,
  authorKind: 'piloti',
  status: 'proposed',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  fassungNumber: 1,
  onCurrentFassung: true,
  createdBy: 'user_1',
  createdByName: 'Anna',
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  replies: [],
  canEdit: true,
  canDelete: false,
  ...patch,
})

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[] = []

/**
 * The annotations routes: `list` answers GET …/annotations (one value per read,
 * the last repeating), `patch` answers PATCH …/annotations/{id}.
 */
function stubRoutes({
  list = [[view('ann-7', 7), view('ann-8', 8)]],
  patch = (id: string, body: { status: string }) => ({
    status: 200,
    body: { annotation: view(id, 7, { status: body.status as AnnotationView['status'] }) },
  }),
}: {
  list?: AnnotationView[][]
  patch?: (id: string, body: { status: string }) => { status: number; body: unknown }
} = {}) {
  let reads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      const respond = (status: number, payload: unknown) =>
        Promise.resolve({ ok: status < 400, status, json: async () => payload })
      if (url.endsWith('/thumbnail')) return respond(200, { url: null })
      if (method === 'GET' && url.endsWith('/annotations')) {
        const annotations = list[Math.min(reads, list.length - 1)]
        reads += 1
        return respond(200, { annotations, canAnnotate: true })
      }
      if (method === 'PATCH') {
        const id = decodeURIComponent(url.split('/').pop() ?? '')
        const answer = patch(id, body)
        return respond(answer.status, answer.body)
      }
      return respond(404, {})
    })
  )
}

/** An observer that reports the card on screen at once, so its reads start. */
class SeenObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
  unobserve() {}
  disconnect() {}
}

const renderCard = (items: CanvasActivityItem[], messageId: string | undefined = 'msg-1') =>
  render(<CanvasActivityCard document={DOC} items={items} messageId={messageId} cardKey="canvas_activity-0" />)

beforeEach(() => {
  calls = []
  mockCardInteractions = undefined
  setCardDecision.mockReset()
  openReviewAt.mockClear()
  vi.stubGlobal('IntersectionObserver', SeenObserver)
  stubRoutes()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CanvasActivityCard — what it says', () => {
  it('heads the card with what Piloti did and on which document', () => {
    renderCard([STAIR, DOOR])
    expect(screen.getByText('2 annotations proposed')).toBeInTheDocument()
    expect(screen.getByText('Grundriss EG.pdf')).toBeInTheDocument()
  })

  it('names the thread when Piloti only replied', () => {
    renderCard([REPLY])
    expect(screen.getByText('Replied in the thread of #4')).toBeInTheDocument()
    expect(screen.getByText('„Im Türenbuch als EI2 30-C geführt.“')).toBeInTheDocument()
    // A reply asks nothing: no take-over, no discard.
    expect(screen.queryByRole('button', { name: /Take over/ })).toBeNull()
  })

  it('says both in one line when Piloti proposed and replied', () => {
    renderCard([STAIR, REPLY])
    expect(screen.getByText('1 annotation proposed, replied in one thread')).toBeInTheDocument()
  })

  it('draws a box where the region sits on the page, dashed while proposed', () => {
    renderCard([STAIR])
    const region = screen.getByTestId('canvas-activity-region')
    expect(region.style.left).toBe('50%')
    expect(region.style.top).toBe('25%')
    expect(region.style.width).toBe('20%')
    expect(region.className).toContain('border-dashed')
  })

  it('shows number, kind, page and body for each proposed mark', () => {
    renderCard([DOOR])
    expect(screen.getByText('#8')).toBeInTheDocument()
    expect(screen.getByText('Question')).toBeInTheDocument()
    expect(screen.getByText('Page 2')).toBeInTheDocument()
    expect(screen.getByText('Ist die Tür zum Müllraum EI2 30-C?')).toBeInTheDocument()
  })
})

describe('CanvasActivityCard — the answer per mark', () => {
  it('takes a mark over through the PATCH and records it under the mark', async () => {
    const user = userEvent.setup()
    renderCard([STAIR, DOOR])

    await user.click(screen.getByRole('button', { name: 'Take over annotation 7' }))

    await waitFor(() => expect(setCardDecision).toHaveBeenCalled())
    expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'canvas_activity-0#ann-7', 'accepted')
    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch?.url).toBe(`/api/documents/${DOC.id}/annotations/ann-7`)
    expect(patch?.body).toEqual({ status: 'open', expectedStatus: 'proposed' })
    // The other mark still asks.
    expect(screen.getByRole('button', { name: 'Take over annotation 8' })).toBeInTheDocument()
  })

  it('discards a mark with status dismissed and records rejected', async () => {
    const user = userEvent.setup()
    renderCard([STAIR])

    await user.click(screen.getByRole('button', { name: 'Discard annotation 7' }))

    await waitFor(() => expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'canvas_activity-0#ann-7', 'rejected'))
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ status: 'dismissed', expectedStatus: 'proposed' })
  })

  it('answers only the proposal it shows: one a colleague discarded meanwhile is not reopened', async () => {
    stubRoutes({
      list: [
        [view('ann-7', 7)],
        [view('ann-7', 7, { status: 'dismissed', closedByName: 'Ben' })],
      ],
      patch: () => ({ status: 409, body: { error: 'Somebody changed this Anmerkung a moment ago.', code: 'CONFLICT' } }),
    })
    const user = userEvent.setup()
    renderCard([STAIR])
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/annotations'))).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Take over annotation 7' }))

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Discarded'))
    expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Ben')
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ status: 'open', expectedStatus: 'proposed' })
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('shows what happened on a 409 and records nothing', async () => {
    stubRoutes({
      list: [[view('ann-7', 7)], [view('ann-7', 7, { status: 'open', acceptedByName: 'Ben' })]],
      patch: () => ({ status: 409, body: { error: 'Somebody changed this Anmerkung a moment ago.', code: 'CONFLICT' } }),
    })
    const user = userEvent.setup()
    renderCard([STAIR])

    await user.click(screen.getByRole('button', { name: 'Discard annotation 7' }))

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Taken over'))
    expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Ben')
    expect(setCardDecision).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Discard annotation 7' })).toBeNull()
  })

  it('draws a stored decision answered and offers nothing again', () => {
    mockCardInteractions = {
      'canvas_activity-0#ann-7': { decision: 'accepted', decidedAt: '2026-10-13T08:00:00.000Z' },
    }
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    renderCard([STAIR])

    expect(screen.getByTestId('canvas-activity-proposed')).toHaveAttribute('data-state', 'open')
    expect(screen.queryByRole('button', { name: 'Take over annotation 7' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard annotation 7' })).toBeNull()
  })

  it('lets the canvas win over the message: a mark taken over there reads as taken over', async () => {
    stubRoutes({ list: [[view('ann-7', 7, { status: 'resolved', closedByName: 'Ben' })]] })
    renderCard([STAIR])

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Resolved'))
    expect(screen.queryByRole('button', { name: 'Take over annotation 7' })).toBeNull()
  })

  it('offers no answer to a reader who may not change the mark', async () => {
    stubRoutes({ list: [[view('ann-7', 7, { canEdit: false })]] })
    renderCard([STAIR])

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Take over annotation 7' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Show annotation 7 in the document' })).toBeInTheDocument()
  })

  it('says a deleted mark is gone and offers neither answer nor the way to it', async () => {
    stubRoutes({ list: [[]] })
    renderCard([STAIR])

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('No longer there'))
    expect(screen.queryByRole('button', { name: 'Show annotation 7 in the document' })).toBeNull()
  })
})

describe('CanvasActivityCard — into the document', () => {
  it('opens the Prüfansicht at the row’s mark', async () => {
    const user = userEvent.setup()
    renderCard([STAIR, DOOR])

    await user.click(screen.getByRole('button', { name: 'Show annotation 8 in the document' }))

    expect(openReviewAt).toHaveBeenCalledWith(
      { documentId: DOC.id, annotationId: 'ann-8' },
      expect.objectContaining({ projectId: 'proj-1' })
    )
  })

  it('opens it at the first item from the card’s own button', async () => {
    const user = userEvent.setup()
    renderCard([REPLY, STAIR])

    await user.click(screen.getByTestId('canvas-activity-show'))

    expect(openReviewAt).toHaveBeenCalledWith({ documentId: DOC.id, annotationId: 'ann-4' }, expect.anything())
  })

  it('says so when the document could not be opened', async () => {
    openReviewAt.mockResolvedValueOnce('unavailable' as never)
    const user = userEvent.setup()
    renderCard([STAIR])

    await user.click(screen.getByTestId('canvas-activity-show'))

    expect(await screen.findByText('The document could not be opened.')).toBeInTheDocument()
  })
})
