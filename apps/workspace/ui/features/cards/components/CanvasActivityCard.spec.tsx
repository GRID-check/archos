/**
 * The `canvas_activity` card: what Piloti did on a document, and the reader's
 * answer per mark.
 *
 * What this file holds the card to:
 *
 * 1. **One decision per mark**, a PATCH through the annotations client. The
 *    mark is the record (the card is `live`): nothing is written to the
 *    message. A decision a message stored before that still draws the mark
 *    answered, read-only, and offers nothing again.
 * 2. **The canvas wins.** A mark a colleague answered on the canvas reads as
 *    answered here, and a 409 re-reads instead of recording a decision the
 *    reader never made.
 * 3. **Taking over reads first**, because the API lets a discarded mark be
 *    opened again and a 409 would not stop it.
 * 4. **„Im Dokument zeigen" opens the Prüfansicht at that mark** through
 *    `openReviewAt`, the one way into the review.
 * 5. **What the person asked for reads as done, and can be undone.** A mark set
 *    on request reads like a person's open mark; a change reads in the
 *    reader's words with Piloti's note, and „Rückgängig" PATCHes the inverse
 *    with the status Piloti left as `expectedStatus`, never undoing a
 *    colleague's later move; a deletion only says so.
 * 6. **The server's record wins** (ADR-0109): a row with a `agent_changes`
 *    row draws from it (who it was for, undone and by whom, `canUndo`) and
 *    undoes through `undoChange`; a row without one, or a request that
 *    failed, keeps the card's own copy and its browser-side replay.
 *    `moved-on` and `already-undone` answer calmly, and a live change to one
 *    of the card's marks reads the record again.
 * 7. **Several proposals answer at once**: „Alle übernehmen" and „Übrige
 *    verwerfen" are the per-mark write on each mark still proposed, a mark
 *    somebody decided meanwhile is skipped and its row says who, and
 *    discarding asks first.
 * 8. **Each row tells its thread at a glance**: the reply count and the
 *    newest reply's author and first words, from the live list.
 *
 * Rendered without an `I18nProvider`, so the dictionary falls back to `en`.
 */
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationView } from '@/lib/annotations/types'
import { ChangeRequestError, getTurnChanges, undoChange } from '@/lib/changes/client'
import type { AgentChangeView } from '@/lib/changes/types'
import type { CardInteractions } from '../card-decision'
import type { CanvasActivityItem } from '../lib/canvas-activity'
import { CanvasActivityCard } from './CanvasActivityCard'
import { PRODUCT_NAME } from '@/lib/brand'

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

vi.mock('@/lib/changes/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/changes/client')>()),
  getTurnChanges: vi.fn(),
  undoChange: vi.fn(),
}))

// The document's live store, scripted: a test moves `touched` to say a hint named one of the card's marks.
let mockTouched = 0
vi.mock('../hooks/use-canvas-document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-canvas-document')>()
  return {
    ...actual,
    useLiveMarks: (...args: Parameters<typeof actual.useLiveMarks>) => ({
      ...actual.useLiveMarks(...args),
      touched: mockTouched,
    }),
  }
})

const turnChanges = vi.mocked(getTurnChanges)
const undo = vi.mocked(undoChange)

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

const SET: CanvasActivityItem = { ...(STAIR as Extract<CanvasActivityItem, { action: 'proposed' }>), action: 'created' }

const RESOLVED: CanvasActivityItem = {
  action: 'changed',
  annotation_id: 'ann-4',
  number: 4,
  status: 'resolved',
  changes: [{ field: 'status', before: 'open', after: 'resolved' }],
  note: 'Erledigt: Die lichte Breite ist im Schnitt B-B mit 1,25 m kotiert.',
}

const ASSIGNED: CanvasActivityItem = {
  action: 'changed',
  annotation_id: 'ann-4',
  number: 4,
  status: 'open',
  changes: [{ field: 'assignee', after: 'user_anna', after_label: 'Anna Berger' }],
  note: 'Anna übernimmt die Prüfung.',
}

const DELETED: CanvasActivityItem = { action: 'deleted', number: 9, body: 'Doppelt gesetzt.' }

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
  revisionNumber: 1,
  onCurrentRevision: true,
  createdBy: 'user_1',
  createdByName: 'Anna',
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
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
  mockTouched = 0
  turnChanges.mockReset()
  turnChanges.mockResolvedValue({ changes: [] })
  undo.mockReset()
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

  it('names every act the card holds in one line', () => {
    renderCard([SET, RESOLVED, DELETED, REPLY])
    expect(
      screen.getByText('1 annotation set, 1 annotation changed, 1 annotation deleted, replied in one thread')
    ).toBeInTheDocument()
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
  it('takes a mark over through the PATCH, and the mark is the record', async () => {
    const user = userEvent.setup()
    renderCard([STAIR, DOOR])

    await user.click(screen.getByRole('button', { name: 'Take over annotation 7' }))

    await waitFor(() => expect(screen.getAllByTestId('canvas-activity-state')).toHaveLength(1))
    expect(screen.getAllByTestId('canvas-activity-proposed')[0]).toHaveAttribute('data-state', 'open')
    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch?.url).toBe(`/api/documents/${DOC.id}/annotations/ann-7`)
    expect(patch?.body).toEqual({ status: 'open', expectedStatus: 'proposed' })
    // Nothing is written to the message: the mark holds the answer.
    expect(setCardDecision).not.toHaveBeenCalled()
    // The other mark still asks.
    expect(screen.getByRole('button', { name: 'Take over annotation 8' })).toBeInTheDocument()
  })

  it('discards a mark with status dismissed', async () => {
    const user = userEvent.setup()
    renderCard([STAIR])

    await user.click(screen.getByRole('button', { name: 'Discard annotation 7' }))

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Discarded'))
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ status: 'dismissed', expectedStatus: 'proposed' })
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('offers the answer without an owning message too: the mark needs no place to be kept', async () => {
    const user = userEvent.setup()
    render(<CanvasActivityCard document={DOC} items={[STAIR]} cardKey="canvas_activity-0" />)

    await user.click(screen.getByRole('button', { name: 'Take over annotation 7' }))

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Taken over'))
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('offers no answer on a read-only surface where nothing owns the card', () => {
    render(<CanvasActivityCard document={DOC} items={[STAIR, DOOR]} cardKey="canvas_activity-0" decisionsMustPersist />)

    expect(screen.queryByRole('button', { name: /Take over/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull()
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

describe('CanvasActivityCard — what the person asked for', () => {
  it('draws a mark set on request like a person’s open mark: solid, no answer to give', async () => {
    stubRoutes({ list: [[view('ann-7', 7, { status: 'open', acceptedByName: 'Anna' })]] })
    renderCard([SET])

    expect(screen.getByText('1 annotation set')).toBeInTheDocument()
    const row = screen.getByTestId('canvas-activity-created')
    expect(row).toHaveAttribute('data-state', 'open')
    expect(screen.getByTestId('canvas-activity-region').className).not.toContain('border-dashed')
    expect(screen.queryByRole('button', { name: /Take over/ })).toBeNull()
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/annotations'))).toBe(true))
    expect(screen.queryByTestId('canvas-activity-state')).toBeNull()
  })

  it('reads a change in the reader’s words, with Piloti’s note under it', () => {
    renderCard([RESOLVED, ASSIGNED])
    expect(screen.getByText('resolved')).toBeInTheDocument()
    expect(screen.getByText('assigned to Anna Berger')).toBeInTheDocument()
    expect(screen.getByText('„Erledigt: Die lichte Breite ist im Schnitt B-B mit 1,25 m kotiert.“')).toBeInTheDocument()
  })

  it('undoes a change through the reader’s PATCH, guarded by the status Piloti left, and keeps nothing on the message', async () => {
    stubRoutes({
      list: [[view('ann-4', 4, { status: 'resolved', authorKind: 'person', closedBy: 'user_1', closedByName: 'Anna' })]],
      patch: (id) => ({ status: 200, body: { annotation: view(id, 4, { status: 'open', authorKind: 'person' }) } }),
    })
    const user = userEvent.setup()
    renderCard([RESOLVED])

    await user.click(await screen.findByRole('button', { name: 'Undo the change to annotation 4' }))

    await waitFor(() => expect(screen.getByTestId('canvas-activity-changed')).toHaveAttribute('data-undone', 'true'))
    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch?.url).toBe(`/api/documents/${DOC.id}/annotations/ann-4`)
    expect(patch?.body).toEqual({ status: 'open', expectedStatus: 'resolved' })
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('puts an assignee back as it was: none', async () => {
    stubRoutes({
      list: [[view('ann-4', 4, { status: 'open', authorKind: 'person', assigneeUserId: 'user_anna' })]],
      patch: (id) => ({ status: 200, body: { annotation: view(id, 4, { status: 'open', authorKind: 'person' }) } }),
    })
    const user = userEvent.setup()
    renderCard([ASSIGNED])

    await user.click(await screen.findByRole('button', { name: 'Undo the change to annotation 4' }))

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true))
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ assigneeUserId: null, expectedStatus: 'open' })
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('never undoes a colleague’s later move: a mark that moved on shows where it stands', async () => {
    stubRoutes({ list: [[view('ann-4', 4, { status: 'open', authorKind: 'person' })]] })
    renderCard([RESOLVED])

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Changed since, now open'))
    expect(screen.queryByRole('button', { name: 'Undo the change to annotation 4' })).toBeNull()
  })

  it('shows the current state on a 409 and records nothing', async () => {
    stubRoutes({
      list: [
        [view('ann-4', 4, { status: 'resolved', authorKind: 'person', closedBy: 'user_1' })],
        [view('ann-4', 4, { status: 'resolved', authorKind: 'person', closedBy: 'user_1' })],
        [view('ann-4', 4, { status: 'open', authorKind: 'person' })],
      ],
      patch: () => ({ status: 409, body: { error: 'Somebody changed this Anmerkung a moment ago.', code: 'CONFLICT' } }),
    })
    const user = userEvent.setup()
    renderCard([RESOLVED])

    await user.click(await screen.findByRole('button', { name: 'Undo the change to annotation 4' }))

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Changed since, now open'))
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('offers no undo where a person’s PATCH has no way back: a proposal Piloti took over', () => {
    renderCard([
      { ...RESOLVED, status: 'open', changes: [{ field: 'status', before: 'proposed', after: 'open' }], note: 'Übernommen.' },
    ])
    expect(screen.getByText('taken over')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo the change to annotation 4' })).toBeNull()
  })

  it('draws a stored undo as undone and offers it no more', () => {
    mockCardInteractions = {
      'canvas_activity-0#ann-4@0': { decision: 'rejected', decidedAt: '2026-10-13T08:00:00.000Z' },
    }
    renderCard([RESOLVED])

    expect(screen.getByTestId('canvas-activity-changed')).toHaveAttribute('data-undone', 'true')
    expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Undone')
    expect(screen.queryByRole('button', { name: 'Undo the change to annotation 4' })).toBeNull()
  })

  it('says a deleted mark is deleted, with what it said, and offers nothing', () => {
    renderCard([DELETED])

    expect(screen.getByText('1 annotation deleted')).toBeInTheDocument()
    expect(screen.getByText('Annotation #9 deleted')).toBeInTheDocument()
    expect(screen.getByText('Doppelt gesetzt.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
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

// ── The server's record (ADR-0109) ──────────────────────────────────────────

const ANN4 = '00000000-0000-4000-8000-0000000000a4'

/** One applied change as the server answers it; tests override what they test. */
const change = (patch: Partial<AgentChangeView> = {}): AgentChangeView => ({
  id: '00000000-0000-4000-8000-0000000000b1',
  documentId: DOC.id,
  annotationId: ANN4,
  annotationNumber: 4,
  objectKind: 'annotation',
  objectId: ANN4,
  op: 'update',
  before: { status: 'open' },
  after: { status: 'resolved' },
  onBehalfOf: 'user_miriam',
  onBehalfOfName: 'Miriam',
  createdAt: '2026-10-13T08:00:00.000Z',
  undoneAt: null,
  undoneBy: null,
  undoneByName: null,
  canUndo: true,
  ...patch,
})

const RECORDED: CanvasActivityItem = { ...(RESOLVED as Extract<CanvasActivityItem, { action: 'changed' }>), annotation_id: ANN4 }

/** The canvas still holds the recorded mark, resolved, as Piloti left it. */
const RECORDED_MARK = view(ANN4, 4, { status: 'resolved', authorKind: 'person' })

const UNDO_BUTTON = 'Undo the change to annotation 4'

describe('CanvasActivityCard — the server’s record wins', () => {
  beforeEach(() => stubRoutes({ list: [[RECORDED_MARK]] }))

  it('asks the server for the changes of this answer', async () => {
    turnChanges.mockResolvedValue({ changes: [change()] })
    renderCard([RECORDED])

    await waitFor(() => expect(turnChanges).toHaveBeenCalledWith('conv-1', 'msg-1'))
    expect(await screen.findByText('for Miriam')).toBeInTheDocument()
  })

  it('draws undo-ability from the record, not from the card’s copy', async () => {
    // The live list says the mark moved on (open again) — the record still says it may be undone:
    // the server compares, the card does not guess.
    stubRoutes({ list: [[view(ANN4, 4, { status: 'resolved', authorKind: 'person' })]] })
    turnChanges.mockResolvedValue({ changes: [change({ canUndo: true })] })
    renderCard([RECORDED])

    expect(await screen.findByRole('button', { name: UNDO_BUTTON })).toBeInTheDocument()
  })

  it('offers no undo when the record says the reader may not', async () => {
    turnChanges.mockResolvedValue({ changes: [change({ canUndo: false })] })
    renderCard([RECORDED])

    await screen.findByText('for Miriam')
    expect(screen.queryByRole('button', { name: UNDO_BUTTON })).toBeNull()
  })

  it('says who undid a change, from the record, and offers it no more', async () => {
    turnChanges.mockResolvedValue({
      changes: [change({ undoneAt: '2026-10-13T09:00:00.000Z', undoneBy: 'user_anna', undoneByName: 'Anna', canUndo: false })],
    })
    renderCard([RECORDED])

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Undone'))
    expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Anna')
    expect(screen.getByTestId('canvas-activity-changed')).toHaveAttribute('data-undone', 'true')
    expect(screen.queryByRole('button', { name: UNDO_BUTTON })).toBeNull()
  })

  it('lets the record beat a decision this browser stored', async () => {
    mockCardInteractions = {
      [`canvas_activity-0#${ANN4}@0`]: { decision: 'rejected', decidedAt: '2026-10-13T08:00:00.000Z' },
    }
    turnChanges.mockResolvedValue({ changes: [change({ undoneAt: null, canUndo: true })] })
    renderCard([RECORDED])

    expect(await screen.findByRole('button', { name: UNDO_BUTTON })).toBeInTheDocument()
    expect(screen.getByTestId('canvas-activity-changed')).not.toHaveAttribute('data-undone')
  })

  it('shows whom a mark set on request was for, and undoes it through the record', async () => {
    const created = change({ id: '00000000-0000-4000-8000-0000000000b2', annotationId: 'ann-7', objectId: 'ann-7', op: 'create', before: null, after: { status: 'open' } })
    turnChanges.mockResolvedValue({ changes: [created] })
    undo.mockResolvedValue({ change: { ...created, undoneAt: '2026-10-13T09:00:00.000Z', undoneByName: 'Miriam', canUndo: false } })
    stubRoutes({ list: [[view('ann-7', 7, { status: 'open' })], []] })
    const user = userEvent.setup()
    renderCard([SET])

    await user.click(await screen.findByRole('button', { name: 'Undo the change to annotation 7' }))

    expect(undo).toHaveBeenCalledWith(created.id)
    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Undone'))
    expect(screen.getByTestId('canvas-activity-for')).toHaveTextContent('for Miriam')
  })

  it('offers a proposal no undo: its two answers are the way back', async () => {
    const proposed = change({ annotationId: 'ann-7', objectId: 'ann-7', op: 'create', before: null, after: { status: 'proposed' } })
    turnChanges.mockResolvedValue({ changes: [proposed] })
    stubRoutes({ list: [[view('ann-7', 7)]] })
    renderCard([STAIR])

    await screen.findByText('for Miriam')
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Take over annotation 7' })).toBeInTheDocument()
  })

  it('pairs two changes to one mark in the order the turn made them', async () => {
    const second: CanvasActivityItem = { ...ASSIGNED, annotation_id: ANN4 }
    turnChanges.mockResolvedValue({
      changes: [
        change({ id: '00000000-0000-4000-8000-0000000000b3', onBehalfOfName: 'Miriam' }),
        change({ id: '00000000-0000-4000-8000-0000000000b4', onBehalfOfName: 'Ben', before: null, after: { assigneeUserId: 'user_anna' } }),
      ],
    })
    renderCard([RECORDED, second])

    const rows = await screen.findAllByTestId('canvas-activity-changed')
    await waitFor(() => expect(rows[0]).toHaveTextContent('for Miriam'))
    expect(rows[1]).toHaveTextContent('for Ben')
  })

  it('undoes a thread reply and a deletion through the record too', async () => {
    const reply = change({ id: '00000000-0000-4000-8000-0000000000b5', objectKind: 'annotation_reply', op: 'create', before: null, after: { body: 'x' } })
    const removal = change({ id: '00000000-0000-4000-8000-0000000000b6', annotationId: '00000000-0000-4000-8000-0000000000a9', annotationNumber: null, op: 'delete', before: { body: 'Doppelt gesetzt.' }, after: null })
    turnChanges.mockResolvedValue({ changes: [reply, removal] })
    renderCard([{ ...REPLY, annotation_id: ANN4 } as CanvasActivityItem, DELETED])

    await waitFor(() => expect(screen.getAllByRole('button', { name: /Undo/ })).toHaveLength(2))
  })
})

describe('CanvasActivityCard — the card’s own copy is the fallback', () => {
  it('keeps the browser-side replay when the request fails', async () => {
    turnChanges.mockRejectedValue(new ChangeRequestError('down', 500, null))
    stubRoutes({
      list: [[view('ann-4', 4, { status: 'resolved', authorKind: 'person', closedBy: 'user_1' })]],
      patch: (id) => ({ status: 200, body: { annotation: view(id, 4, { status: 'open', authorKind: 'person' }) } }),
    })
    const user = userEvent.setup()
    renderCard([RESOLVED])

    await user.click(await screen.findByRole('button', { name: UNDO_BUTTON }))

    await waitFor(() => expect(screen.getByTestId('canvas-activity-changed')).toHaveAttribute('data-undone', 'true'))
    expect(setCardDecision).not.toHaveBeenCalled()
    expect(undo).not.toHaveBeenCalled()
    expect(screen.queryByTestId('canvas-activity-for')).toBeNull()
  })

  it('keeps it for a row the record does not hold, while another row has its change', async () => {
    turnChanges.mockResolvedValue({ changes: [change({ annotationId: 'ann-7', objectId: 'ann-7', op: 'create', after: { status: 'open' } })] })
    stubRoutes({ list: [[view('ann-7', 7, { status: 'open' }), view('ann-4', 4, { status: 'resolved', authorKind: 'person' })]] })
    renderCard([SET, RESOLVED])

    await screen.findByText('for Miriam')
    // The changed row has no change: the copy's replay is offered as before.
    expect(await screen.findByRole('button', { name: UNDO_BUTTON })).toBeInTheDocument()
    expect(undo).not.toHaveBeenCalled()
  })
})

describe('CanvasActivityCard — undo through the record', () => {
  beforeEach(() => stubRoutes({ list: [[RECORDED_MARK]] }))

  it('undoes through undoChange, adopts the answer and reads the canvas again', async () => {
    const original = change({ id: '00000000-0000-4000-8000-0000000000b7' })
    turnChanges.mockResolvedValue({ changes: [original] })
    undo.mockResolvedValue({
      change: { ...original, undoneAt: '2026-10-13T09:00:00.000Z', undoneBy: 'user_miriam', undoneByName: 'Miriam', canUndo: false },
    })
    const user = userEvent.setup()
    renderCard([RECORDED])

    await user.click(await screen.findByRole('button', { name: UNDO_BUTTON }))

    expect(undo).toHaveBeenCalledWith(original.id)
    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Undone'))
    // No PATCH replay, and nothing stored on the message.
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false)
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('says calmly that somebody changed it since on moved-on, and reads the record again', async () => {
    const original = change()
    turnChanges
      .mockResolvedValueOnce({ changes: [original] })
      .mockResolvedValue({ changes: [{ ...original, canUndo: false }] })
    undo.mockRejectedValue(new ChangeRequestError('moved', 409, 'moved-on'))
    const user = userEvent.setup()
    renderCard([RECORDED])

    await user.click(await screen.findByRole('button', { name: UNDO_BUTTON }))

    const notice = await screen.findByTestId('canvas-activity-notice')
    expect(notice).toHaveTextContent('Someone changed this in the meantime')
    expect(notice.className).not.toContain('destructive')
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(screen.queryByRole('button', { name: UNDO_BUTTON })).toBeNull())
  })

  it('shows who undid it after a refetch on already-undone', async () => {
    const original = change()
    turnChanges
      .mockResolvedValueOnce({ changes: [original] })
      .mockResolvedValue({
        changes: [{ ...original, undoneAt: '2026-10-13T09:00:00.000Z', undoneBy: 'user_anna', undoneByName: 'Anna', canUndo: false }],
      })
    undo.mockRejectedValue(new ChangeRequestError('done', 409, 'already-undone'))
    const user = userEvent.setup()
    renderCard([RECORDED])

    await user.click(await screen.findByRole('button', { name: UNDO_BUTTON }))

    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Anna'))
    expect(screen.queryByTestId('canvas-activity-notice')).toBeNull()
  })

  it('says it plainly when it cannot show who undid it', async () => {
    turnChanges.mockResolvedValueOnce({ changes: [change()] }).mockRejectedValue(new ChangeRequestError('down', 500, null))
    undo.mockRejectedValue(new ChangeRequestError('done', 409, 'already-undone'))
    const user = userEvent.setup()
    renderCard([RECORDED])

    await user.click(await screen.findByRole('button', { name: UNDO_BUTTON }))

    expect(await screen.findByTestId('canvas-activity-notice')).toHaveTextContent('Already undone.')
  })

  it('shows an error, in red, for any other failure', async () => {
    turnChanges.mockResolvedValue({ changes: [change()] })
    undo.mockRejectedValue(new ChangeRequestError('boom', 500, null))
    const user = userEvent.setup()
    renderCard([RECORDED])

    await user.click(await screen.findByRole('button', { name: UNDO_BUTTON }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not be saved.')
  })
})

describe('CanvasActivityCard — live', () => {
  beforeEach(() => stubRoutes({ list: [[RECORDED_MARK]] }))

  it('reads the record again when the live store says one of its marks changed', async () => {
    turnChanges.mockResolvedValue({ changes: [change()] })
    const { rerender } = renderCard([RECORDED])
    await waitFor(() => expect(turnChanges).toHaveBeenCalledTimes(1))
    await screen.findByText('for Miriam')

    // A colleague undid it on another screen: the hint moves the stamp.
    turnChanges.mockResolvedValue({
      changes: [change({ undoneAt: '2026-10-13T09:00:00.000Z', undoneBy: 'user_anna', undoneByName: 'Anna', canUndo: false })],
    })
    mockTouched = 1
    rerender(<CanvasActivityCard document={DOC} items={[RECORDED]} messageId="msg-1" cardKey="canvas_activity-0" />)

    await waitFor(() => expect(turnChanges).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('canvas-activity-state')).toHaveTextContent('Anna'))
  })
})

describe('CanvasActivityCard — several proposals at once', () => {
  const TAKE_ALL = 'Take over all'
  const DISCARD_REST = 'Discard the rest'
  const patches = () => calls.filter((call) => call.method === 'PATCH')

  it('offers the two batch answers once the list says several marks are proposed', async () => {
    renderCard([STAIR, DOOR])

    expect(await screen.findByRole('button', { name: TAKE_ALL })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: DISCARD_REST })).toBeInTheDocument()
    // The per-mark answers stay.
    expect(screen.getByRole('button', { name: 'Take over annotation 7' })).toBeInTheDocument()
  })

  it('offers none for a single proposal', async () => {
    renderCard([STAIR])
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/annotations'))).toBe(true))
    expect(screen.queryByRole('button', { name: TAKE_ALL })).toBeNull()
  })

  it('takes every proposed mark over with the per-mark write and records nothing on the message', async () => {
    const user = userEvent.setup()
    renderCard([STAIR, DOOR])

    await user.click(await screen.findByRole('button', { name: TAKE_ALL }))

    await waitFor(() => expect(patches()).toHaveLength(2))
    expect(patches().map((call) => [call.url.split('/').pop(), call.body])).toEqual([
      ['ann-7', { status: 'open', expectedStatus: 'proposed' }],
      ['ann-8', { status: 'open', expectedStatus: 'proposed' }],
    ])
    await waitFor(() => expect(screen.queryByRole('button', { name: TAKE_ALL })).toBeNull())
    expect(screen.getAllByTestId('canvas-activity-state')).toHaveLength(2)
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('leaves out a mark that is not the reader’s to answer', async () => {
    stubRoutes({
      list: [[view('ann-7', 7), view('ann-8', 8, { canEdit: false }), view('ann-9', 9)]],
    })
    const user = userEvent.setup()
    renderCard([STAIR, DOOR, { ...STAIR, annotation_id: 'ann-9', number: 9 } as CanvasActivityItem])

    await user.click(await screen.findByRole('button', { name: TAKE_ALL }))

    await waitFor(() => expect(patches()).toHaveLength(2))
    expect(patches().map((call) => call.url.split('/').pop())).toEqual(['ann-7', 'ann-9'])
  })

  it('asks before it discards, and does nothing when the reader backs out', async () => {
    const user = userEvent.setup()
    renderCard([STAIR, DOOR])

    await user.click(await screen.findByRole('button', { name: DISCARD_REST }))

    expect(await screen.findByText('Discard 2 annotations?')).toBeInTheDocument()
    expect(screen.getByText('This cannot be undone from here.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(patches()).toHaveLength(0)
  })

  it('discards the rest with status dismissed once confirmed', async () => {
    const user = userEvent.setup()
    renderCard([STAIR, DOOR])

    await user.click(await screen.findByRole('button', { name: DISCARD_REST }))
    await user.click(await screen.findByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(patches()).toHaveLength(2))
    expect(patches().map((call) => call.body)).toEqual([
      { status: 'dismissed', expectedStatus: 'proposed' },
      { status: 'dismissed', expectedStatus: 'proposed' },
    ])
    await waitFor(() => expect(screen.getAllByTestId('canvas-activity-state')).toHaveLength(2))
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('skips a mark somebody decided meanwhile and says so in its row', async () => {
    stubRoutes({
      list: [
        [view('ann-7', 7), view('ann-8', 8)],
        [view('ann-7', 7, { status: 'open', acceptedByName: 'Anna' }), view('ann-8', 8, { status: 'open', acceptedByName: 'Reader' })],
      ],
      patch: (id) =>
        id === 'ann-7'
          ? { status: 409, body: { error: 'Somebody changed this Anmerkung a moment ago.', code: 'CONFLICT' } }
          : { status: 200, body: { annotation: view(id, 8, { status: 'open', acceptedByName: 'Reader' }) } },
    })
    const user = userEvent.setup()
    renderCard([STAIR, DOOR])

    await user.click(await screen.findByRole('button', { name: TAKE_ALL }))

    const skipped = await screen.findByTestId('canvas-activity-skipped')
    expect(skipped).toHaveTextContent('already handled by Anna')
    // The mark the batch did take over carries no such note.
    expect(screen.getAllByTestId('canvas-activity-skipped')).toHaveLength(1)
    expect(skipped.closest('li')).toHaveAttribute('data-testid', 'canvas-activity-proposed')
    expect(within(skipped.closest('li') as HTMLElement).getByTestId('canvas-activity-state')).toHaveTextContent('Anna')
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('reports the marks it could not save and keeps going', async () => {
    stubRoutes({
      patch: (id) =>
        id === 'ann-7'
          ? { status: 500, body: { error: 'boom' } }
          : { status: 200, body: { annotation: view(id, 8, { status: 'open' }) } },
    })
    const user = userEvent.setup()
    renderCard([STAIR, DOOR])

    await user.click(await screen.findByRole('button', { name: TAKE_ALL }))

    expect(await screen.findByText('One annotation could not be saved.')).toBeInTheDocument()
    expect(patches()).toHaveLength(2)
  })
})

describe('CanvasActivityCard — the thread at a glance', () => {
  const reply = (
    id: string,
    patch: Partial<AnnotationView['replies'][number]>
  ): AnnotationView['replies'][number] => ({
    id,
    annotationId: 'ann-7',
    authorKind: 'person',
    body: 'x',
    createdBy: 'user_1',
    createdByName: 'Anna',
    createdAt: '2026-10-13T08:00:00.000Z',
    addressesPiloti: false,
    ...patch,
  })

  it('says how many replies there are and who answered last, with their first words', async () => {
    stubRoutes({
      list: [
        [
          view('ann-7', 7, {
            replies: [
              reply('r1', { body: 'Welche Breite gilt hier?' }),
              reply('r2', {
                authorKind: 'piloti',
                createdByName: null,
                createdAt: '2026-10-13T09:00:00.000Z',
                body: 'Die Breite beträgt 1,10 m und liegt damit unter dem Mindestmaß von 1,20 m aus der Bauordnung.',
              }),
            ],
          }),
        ],
      ],
    })
    renderCard([STAIR])

    const glance = await screen.findByTestId('canvas-activity-thread')
    expect(glance).toHaveTextContent('2 replies')
    expect(glance).toHaveTextContent(`latest ${PRODUCT_NAME}: “Die Breite beträgt 1,10 m und liegt damit unter dem…”`)
  })

  it('names a person by the directory name, and counts one reply in the singular', async () => {
    stubRoutes({ list: [[view('ann-7', 7, { replies: [reply('r1', { body: 'Bitte prüfen.' })] })]] })
    renderCard([STAIR])

    expect(await screen.findByTestId('canvas-activity-thread')).toHaveTextContent('1 reply · latest Anna: “Bitte prüfen.”')
  })

  it('takes the newest reply by its time, not by its place in the list', async () => {
    stubRoutes({
      list: [
        [
          view('ann-7', 7, {
            replies: [
              reply('r2', { createdAt: '2026-10-13T09:00:00.000Z', body: 'Neuere', createdByName: 'Ben' }),
              reply('r1', { createdAt: '2026-10-13T08:00:00.000Z', body: 'Ältere' }),
            ],
          }),
        ],
      ],
    })
    renderCard([STAIR])

    expect(await screen.findByTestId('canvas-activity-thread')).toHaveTextContent('latest Ben: “Neuere”')
  })

  it('shows nothing for a thread without replies', async () => {
    renderCard([STAIR])
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/annotations'))).toBe(true))
    expect(screen.queryByTestId('canvas-activity-thread')).toBeNull()
  })

  it('shows it on a changed row and on a replied row too', async () => {
    stubRoutes({
      list: [[view('ann-4', 4, { status: 'open', authorKind: 'person', replies: [reply('r1', { body: 'Danke' })] })]],
    })
    renderCard([ASSIGNED, REPLY])

    await waitFor(() => expect(screen.getAllByTestId('canvas-activity-thread')).toHaveLength(2))
  })
})
