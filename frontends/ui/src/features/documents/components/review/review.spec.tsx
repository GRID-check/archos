/**
 * The review against MSW and a scripted room: the hook both surfaces share, the
 * page layer, the thread card and the panel, through the real typed client.
 *
 * What is pinned: a person sets a point or a region where the pointer went,
 * through the API; Piloti's marks arrive as proposals a person takes over or
 * dismisses; a change somebody else made is read again even while pointers are
 * moving (each pointer re-renders the review, and a listener that re-subscribed
 * on every render cancelled the read: the bug this suite caught); colleagues'
 * pointers are drawn on their page; and a reader who may not write gets no tools.
 *
 * And Piloti on the canvas, through the real canvas client on a scripted
 * socket: a box drawn with the Piloti tool opens its card, the question goes
 * out with the box, the answer streams into the card and can be taken over as
 * an Anmerkung at the box, and @Piloti in a thread asks for a reply there.
 */

import { act, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { fireEvent, render, renderHook, screen, waitFor, within } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { server } from '@/mocks/server'
import type { TurnSocket, TurnSocketOptions } from '@/adapters/api/turn-socket'
import type { ClientMessage } from '@/adapters/api/wire-v2'
import type { RoomFrame, RoomPost } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import { wakeTurnId } from '@/lib/annotations/wake-ids'
import { eventOf, frameOf } from '@/test-utils/wire-v2-fixtures'
import { createCanvasTurnClient, type CanvasTurnClientOptions } from '../../lib/canvas-turn-client'
import { useDocumentReview, type ReviewFassung } from '../../hooks/use-document-review'
import type { RoomTransport } from '../../hooks/use-document-room'
import { PilotiAnswerCard } from './piloti-answer-card'
import { ReviewPageLayer } from './review-page-layer'
import { ReviewPanel } from './review-panel'
import { DraftCard, ThreadCard } from './thread-card'

vi.mock('@/features/chat', () => ({
  useChatStore: (selector: (state: { currentUserId: string }) => unknown) => selector({ currentUserId: 'user_me' }),
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

/** The „@" picker's row for one person (or Piloti), as the chat's picker draws it. */
const pickerOption = (scope: HTMLElement, targetId: string): HTMLElement => {
  const row = within(scope)
    .getAllByTestId('mention-option')
    .find((option) => option.getAttribute('data-target-id') === targetId)
  if (!row) throw new Error(`no picker row for ${targetId}`)
  return row
}

/** A room the test plays: frames go to the hook, posts are recorded. */
function scriptedRoom() {
  let deliver: ((frame: RoomFrame) => void) | null = null
  const posts: RoomPost[] = []
  const transport: RoomTransport = {
    connect({ onFrame, onOpen }) {
      deliver = onFrame
      onOpen()
      onFrame({ kind: 'welcome', self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } })
      return () => {
        deliver = null
      }
    },
    post: (post) => posts.push(post),
  }
  return { transport, posts, send: (frame: RoomFrame) => act(() => deliver?.(frame)) }
}

const ANNA = { peerId: 'peer_anna_0001', userId: 'user_anna', name: 'Anna Berger', kind: 'person' as const }

/** Piloti's socket, played by the test: what the canvas sends, and the answer's frames on cue. */
function scriptedPiloti() {
  const sent: ClientMessage[] = []
  let options: TurnSocketOptions | null = null
  const socket: TurnSocket = {
    connect: async () => options?.onStatus?.('open'),
    send: (message) => {
      sent.push(message)
      return true
    },
    accepts: (entry) => entry === 'steer',
    reconnect: () => {},
    close: () => {},
  }
  const createClient = (given: CanvasTurnClientOptions) =>
    createCanvasTurnClient({
      ...given,
      createSocket: (socketOptions) => {
        options = socketOptions
        return socket
      },
    })
  const questions = () =>
    sent.filter((message): message is Extract<ClientMessage, { message_id: string }> => message.type === 'user_message')
  return {
    sent,
    questions,
    createClient,
    deliver: (seq: number, body: Record<string, unknown>) => {
      const turnId = questions().at(-1)?.message_id ?? 'turn-1'
      act(() => options?.onEvent(eventOf(frameOf(seq, body, turnId))))
    },
  }
}

/** The pane's join, without the viewer: page 1's layer in a sized box, the open thread, and the panel. */
function Harness({
  transport,
  onReady,
  piloti,
  canPickAssignee = false,
  fassung = null,
}: {
  transport: RoomTransport
  onReady?: (review: ReturnType<typeof useDocumentReview>) => void
  piloti?: ReturnType<typeof scriptedPiloti>
  canPickAssignee?: boolean
  fassung?: ReviewFassung | null
}) {
  const review = useDocumentReview('doc_1', {
    enabled: true,
    transport,
    fassung,
    piloti: piloti ? { projectId: 'proj_1', fileName: 'Grundriss.pdf', createClient: piloti.createClient } : undefined,
  })
  useEffect(() => {
    onReady?.(review)
  })
  const selected = review.annotations.find((annotation) => annotation.id === review.selectedId)
  return (
    <>
      <div data-testid="sheet" style={{ position: 'relative', width: 800, height: 600 }}>
        <div>
          <ReviewPageLayer
            page={1}
            review={review}
            focused
            renderAsk={(ask, { placement }) => <PilotiAnswerCard review={review} ask={ask} placement={placement} />}
            renderThread={({ placement }) =>
              review.draft ? (
                <DraftCard review={review} draft={review.draft} placement={placement} canPickAssignee={canPickAssignee} />
              ) : selected ? (
                <ThreadCard review={review} annotation={selected} placement={placement} canPickAssignee={canPickAssignee} />
              ) : null
            }
          />
        </div>
      </div>
      <button type="button" onClick={() => review.setTool('region')}>
        region tool
      </button>
      <button type="button" onClick={() => review.setTool('point')}>
        point tool
      </button>
      <button type="button" onClick={() => review.setTool('ask')}>
        piloti tool
      </button>
      {/* A mark of an earlier Fassung is not on the sheet: its thread opens on its own, as the review places it. */}
      {selected && !selected.onCurrentFassung && (
        <ThreadCard review={review} annotation={selected} placement="detached" canPickAssignee={canPickAssignee} />
      )}
      <ReviewPanel review={review} onOpen={(annotation) => review.select(annotation.id)} />
    </>
  )
}

const serve = (annotations: AnnotationView[], canAnnotate = true, pilotiWakes = false) =>
  server.use(
    http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations, canAnnotate, pilotiWakes })),
    // One mark, as a room hint has it read again.
    http.get('/api/documents/:id/annotations/:annotationId', ({ params }) => {
      const found = annotations.find((annotation) => annotation.id === params.annotationId)
      return found
        ? HttpResponse.json({ annotation: found })
        : HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    })
  )

beforeEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

/** The page's capture surface, measured as an 800 × 600 sheet. */
function captureSurface() {
  const capture = within(screen.getByTestId('sheet')).getByTestId('review-capture')
  vi.spyOn(capture, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
  capture.setPointerCapture = () => {}
  return capture
}

/** The conversation and its question rows, as the BFF answers them; what was posted is recorded. */
function serveConversation() {
  const posted: Array<{ path: string; body: unknown }> = []
  server.use(
    // The person's own thread about the document (ADR-0106), which the canvas asks in.
    http.post('/api/documents/:id/thread', async ({ request }) => {
      posted.push({ path: 'thread', body: await request.json() })
      return HttpResponse.json({ conversationId: 's_thread_doc_1' })
    }),
    http.post('/api/conversations', async ({ request }) => {
      posted.push({ path: 'conversation', body: await request.json() })
      return HttpResponse.json({}, { status: 201 })
    }),
    http.post('/api/conversations/:id/messages', async ({ request }) => {
      posted.push({ path: 'message', body: await request.json() })
      return HttpResponse.json([], { status: 201 })
    })
  )
  return posted
}

/** Draw a box with the Piloti tool, ask about it, and let Piloti answer. */
async function askAboutABox(piloti: ReturnType<typeof scriptedPiloti>) {
  await userEvent.click(screen.getByRole('button', { name: 'piloti tool' }))
  const capture = captureSurface()
  fireEvent.pointerDown(capture, { button: 0, clientX: 80, clientY: 120, pointerId: 1 })
  fireEvent.pointerMove(capture, { clientX: 320, clientY: 300, pointerId: 1 })
  fireEvent.pointerUp(capture, { clientX: 320, clientY: 300, pointerId: 1 })

  const card = await screen.findByTestId('piloti-card')
  expect(within(card).getByTestId('piloti-composer')).toBeInTheDocument()
  expect(within(screen.getByTestId('sheet')).getByTestId('piloti-ask-box')).toHaveAttribute('data-status', 'composing')
  await userEvent.click(within(card).getByTestId('piloti-quick-dimensions'))
  await waitFor(() => expect(piloti.questions()).toHaveLength(1))
}

describe('the review', () => {
  it('walks the marks in the order the list shows them: proposals first, this Fassung only; K from nothing is the last', async () => {
    serve([
      view({ id: 'a', number: 1 }),
      view({ id: 'b', number: 2 }),
      view({ id: 'p', number: 3, authorKind: 'piloti', status: 'proposed' }),
      view({ id: 'old', number: 4, onCurrentFassung: false }),
    ])
    let review: ReturnType<typeof useDocumentReview> | null = null
    render(<Harness transport={scriptedRoom().transport} onReady={(next) => (review = next)} />)
    await screen.findAllByTestId('review-pin')

    const walked: Array<string | undefined> = []
    for (let i = 0; i < 4; i += 1) act(() => void walked.push(review?.step(1)?.id))
    expect(walked).toEqual(['p', 'a', 'b', 'p'])

    act(() => review?.select(null))
    let back: string | undefined
    act(() => void (back = review?.step(-1)?.id))
    expect(back).toBe('b')
  })

  it('draws a point as a pin and a region as a box with its pin at the corner', async () => {
    serve([
      view({ id: 'a', number: 1 }),
      view({ id: 'b', number: 2, shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.25, kind: 'question' }),
      view({ id: 'c', number: 3, onCurrentFassung: false }),
    ])
    render(<Harness transport={scriptedRoom().transport} />)

    const pins = await within(screen.getByTestId('sheet')).findAllByTestId('review-pin')
    expect(pins).toHaveLength(2)
    const region = within(screen.getByTestId('sheet')).getByTestId('review-region')
    expect(region.style.left).toBe('10%')
    expect(region.style.width).toBe('30%')
    // The mark set on an earlier Fassung is listed, not drawn.
    expect(screen.getAllByTestId('review-row')).toHaveLength(3)
  })

  it('sets a region dragged out with the region tool, through the API, from this tab', async () => {
    serve([])
    const posted: Array<{ body: unknown; peer: string | null }> = []
    server.use(
      http.post('/api/documents/:id/annotations', async ({ request }) => {
        posted.push({ body: await request.json(), peer: request.headers.get('x-grid-room-peer') })
        return HttpResponse.json(
          { annotation: view({ id: 'new', shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.3, kind: 'question' }) },
          { status: 201 }
        )
      })
    )
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    await screen.findByTestId('review-empty')

    await userEvent.click(screen.getByRole('button', { name: 'region tool' }))
    const capture = within(screen.getByTestId('sheet')).getByTestId('review-capture')
    vi.spyOn(capture, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    capture.setPointerCapture = () => {}
    fireEvent.pointerDown(capture, { button: 0, clientX: 80, clientY: 120, pointerId: 1 })
    fireEvent.pointerMove(capture, { clientX: 320, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(capture, { clientX: 320, clientY: 300, pointerId: 1 })

    const draft = await screen.findByTestId('review-draft')
    await userEvent.click(within(draft).getByTestId('thread-kind-question'))
    await userEvent.type(within(draft).getByTestId('review-draft-body'), 'Raumhöhe nachweisen?{Enter}')

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body).toEqual({
      page: 1,
      shape: 'region',
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.3,
      kind: 'question',
      body: 'Raumhöhe nachweisen?',
      assigneeUserId: null,
      dueOn: null,
    })
    expect(posted[0].peer).toMatch(/^[A-Za-z0-9]{12,}$/)
  })

  it("takes Piloti's proposal over: the thread says what it is, and taking it over opens it", async () => {
    serve([view({ id: 'p', authorKind: 'piloti', status: 'proposed', basis: 'OIB-RL 2, Pkt. 3.4', canDelete: false })])
    const patched: unknown[] = []
    server.use(
      http.patch('/api/documents/:id/annotations/:annotationId', async ({ request }) => {
        patched.push(await request.json())
        return HttpResponse.json({ annotation: view({ id: 'p', authorKind: 'piloti', status: 'open', acceptedBy: 'user_me' }) })
      })
    )
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    expect(within(thread).getByText('Proposal')).toBeInTheDocument()
    expect(within(thread).getByText('OIB-RL 2, Pkt. 3.4')).toBeInTheDocument()
    expect(within(thread).queryByTestId('thread-resolve')).not.toBeInTheDocument()

    await userEvent.click(within(thread).getByTestId('thread-accept'))

    // The status the card showed goes with the move: a stale tab gets a 409, never a blind change.
    await waitFor(() => expect(patched).toEqual([{ status: 'open', expectedStatus: 'proposed' }]))
    await waitFor(() => expect(within(screen.getByTestId('review-thread')).queryByTestId('thread-accept')).toBeNull())
  })

  it('reads again only the mark a hint names, not the list, while pointers keep moving', async () => {
    let listed = 0
    const read: string[] = []
    server.use(
      http.get('/api/documents/:id/annotations', () => {
        listed += 1
        return HttpResponse.json({ annotations: [], canAnnotate: true })
      }),
      http.get('/api/documents/:id/annotations/:annotationId', ({ params }) => {
        read.push(String(params.annotationId))
        return HttpResponse.json({ annotation: view({ id: 'theirs', body: 'Von Anna gesetzt' }) })
      })
    )
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    await screen.findByTestId('review-empty')

    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['theirs'], change: 'created', actor: { ...ANNA } },
    })
    // A pointer every 30ms for half a second: none of them cancels the read.
    for (let index = 0; index < 16; index += 1) {
      room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: index / 20, y: 0.5 } } })
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    }

    expect(await screen.findByText('Von Anna gesetzt')).toBeInTheDocument()
    expect(read).toEqual(['theirs'])
    expect(listed).toBe(1)
  })

  it('takes a mark a hint names off the list when it is not there any more for this reader', async () => {
    serve([view({ id: 'gone', body: 'Wird gelöscht' })])
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    expect(await screen.findByText('Wird gelöscht')).toBeInTheDocument()

    serve([])
    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['gone'], change: 'deleted', actor: { ...ANNA } },
    })
    await waitFor(() => expect(screen.queryByText('Wird gelöscht')).toBeNull())
  })

  it("never draws a mark of the document left behind: a re-read that answers after the switch lands nowhere", async () => {
    let release: () => void = () => {}
    server.use(
      http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations: [], canAnnotate: true })),
      http.get('/api/documents/:id/annotations/:annotationId', async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return HttpResponse.json({ annotation: view({ id: 'theirs', documentId: 'doc_1', body: 'Auf Dokument A' }) })
      })
    )
    const room = scriptedRoom()
    const { result, rerender } = renderHook(({ id }) => useDocumentReview(id, { enabled: true, transport: room.transport }), {
      initialProps: { id: 'doc_1' },
    })
    await waitFor(() => expect(result.current.load).toBe('ready'))
    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['theirs'], change: 'created', actor: { ...ANNA } },
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))

    rerender({ id: 'doc_2' })
    await waitFor(() => expect(result.current.load).toBe('ready'))
    release()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(result.current.annotations).toEqual([])
  })

  it('sends a decision held by a key to the document it was taken on, even after the pane moved on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const patchedOn: string[] = []
    server.use(
      http.get('/api/documents/:id/annotations', ({ params }) =>
        HttpResponse.json({
          annotations: params.id === 'doc_1' ? [view({ id: 'm', documentId: 'doc_1' })] : [],
          canAnnotate: true,
        })
      ),
      http.patch('/api/documents/:id/annotations/:annotationId', ({ params }) => {
        patchedOn.push(String(params.id))
        return HttpResponse.json({ annotation: view({ id: 'm', documentId: String(params.id), status: 'resolved' }) })
      })
    )
    try {
      const room = scriptedRoom()
      const { result, rerender } = renderHook(
        ({ id }) => useDocumentReview(id, { enabled: true, transport: room.transport }),
        { initialProps: { id: 'doc_1' } }
      )
      await waitFor(() => expect(result.current.annotations).toHaveLength(1))
      act(() => {
        result.current.decide(result.current.annotations[0], 'resolved')
      })

      rerender({ id: 'doc_2' })
      await waitFor(() => expect(result.current.load).toBe('ready'))
      await act(async () => {
        vi.advanceTimersByTime(6_000)
      })

      await waitFor(() => expect(patchedOn).toEqual(['doc_1']))
      expect(result.current.annotations.map((annotation) => annotation.id)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends a change asked while a held decision is on its way, rather than taking back a write already sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const sent: Array<{ status?: string; expectedStatus?: string }> = []
    let answerFirst: () => void = () => {}
    server.use(
      http.get('/api/documents/:id/annotations', () =>
        HttpResponse.json({ annotations: [view({ id: 'm' })], canAnnotate: true })
      ),
      http.patch('/api/documents/:id/annotations/:annotationId', async ({ request }) => {
        const body = (await request.json()) as { status?: string; expectedStatus?: string }
        sent.push(body)
        if (sent.length === 1) await new Promise<void>((resolve) => (answerFirst = resolve))
        return HttpResponse.json({ annotation: view({ id: 'm', status: (body.status ?? 'open') as AnnotationView['status'] }) })
      })
    )
    try {
      const room = scriptedRoom()
      const { result } = renderHook(() => useDocumentReview('doc_1', { enabled: true, transport: room.transport }))
      await waitFor(() => expect(result.current.annotations).toHaveLength(1))
      act(() => {
        result.current.decide(result.current.annotations[0], 'resolved')
      })
      await act(async () => {
        vi.advanceTimersByTime(6_000)
      })
      await waitFor(() => expect(sent).toHaveLength(1))

      // „Wieder öffnen" while the resolve is in flight goes to the server, not into the void.
      let reopened: Promise<unknown> = Promise.resolve()
      act(() => {
        reopened = result.current.update('m', { status: 'open', expectedStatus: 'resolved' })
      })
      answerFirst()
      await act(async () => {
        await reopened
      })
      expect(sent).toEqual([
        { status: 'resolved', expectedStatus: 'open' },
        { status: 'open', expectedStatus: 'resolved' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets only the latest re-read of a mark land: an older answer cannot bring back a mark a newer one found gone', async () => {
    const answers: Array<() => void> = []
    let reads = 0
    server.use(
      http.get('/api/documents/:id/annotations', () =>
        HttpResponse.json({ annotations: [view({ id: 'm', body: 'Wird gelöscht' })], canAnnotate: true })
      ),
      http.get('/api/documents/:id/annotations/:annotationId', async () => {
        reads += 1
        if (reads === 1) {
          // The first read is slow, and answers with the mark as it was.
          await new Promise<void>((resolve) => answers.push(resolve))
          return HttpResponse.json({ annotation: view({ id: 'm', body: 'Wird gelöscht' }) })
        }
        return HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
      })
    )
    const room = scriptedRoom()
    const { result } = renderHook(() => useDocumentReview('doc_1', { enabled: true, transport: room.transport }))
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))
    const hint = (change: 'updated' | 'deleted') =>
      room.send({ kind: 'event', event: { kind: 'annotations.changed', annotationIds: ['m'], change, actor: { ...ANNA } } })

    hint('updated')
    await waitFor(() => expect(answers).toHaveLength(1))
    hint('deleted')
    await waitFor(() => expect(result.current.annotations).toEqual([]))

    answers[0]?.()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(result.current.annotations).toEqual([])
  })

  it("does not read again for this tab's own write, which it already holds", async () => {
    let calls = 0
    server.use(
      http.get('/api/documents/:id/annotations', () => {
        calls += 1
        return HttpResponse.json({ annotations: [], canAnnotate: true })
      })
    )
    const room = scriptedRoom()
    let peerId = ''
    render(<Harness transport={room.transport} onReady={(review) => (peerId = review.room.peerId)} />)
    await screen.findByTestId('review-empty')

    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['mine'], change: 'created', actor: { ...ANNA, peerId } },
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)))
    expect(calls).toBe(1)
  })

  it("draws a colleague's pointer on their page, and answers a stranger's presence with its own", async () => {
    const restore = installLayoutObservers({ frameWidth: 800 })
    serve([])
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    await screen.findByTestId('review-empty')
    const announced = room.posts.filter((post) => post.presence === 'here').length

    room.send({ kind: 'event', event: { kind: 'presence', peer: ANNA, state: 'here', ttlMs: 25_000 } })
    room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: 0.5, y: 0.5 }, tool: 'region' } })

    expect(await within(screen.getByTestId('sheet')).findByText('Anna Berger')).toBeInTheDocument()
    await waitFor(() => expect(room.posts.filter((post) => post.presence === 'here').length).toBe(announced + 1))
    restore()
  })

  it('gives a reader who may not write no tools and no decisions', async () => {
    serve([view({ id: 'p', authorKind: 'piloti', status: 'proposed', canEdit: false, canDelete: false })], false)
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    expect(within(thread).queryByTestId('thread-accept')).not.toBeInTheDocument()
    expect(within(thread).queryByTestId('thread-reply')).not.toBeInTheDocument()
  })

  it('asks Piloti about a box drawn with its tool, and streams the answer beside it', async () => {
    serve([])
    const posted = serveConversation()
    const piloti = scriptedPiloti()
    render(<Harness transport={scriptedRoom().transport} piloti={piloti} />)
    await screen.findByTestId('review-empty')

    await askAboutABox(piloti)

    // The person's own thread about the document, which the server creates (ADR-0106).
    expect(posted[0]).toEqual({ path: 'thread', body: { title: 'Grundriss.pdf · Review' } })
    expect(posted.some((entry) => entry.path === 'conversation')).toBe(false)
    expect(piloti.questions()[0].conversation_id).toBe('s_thread_doc_1')
    expect(posted[1]).toEqual({
      path: 'message',
      body: {
        id: piloti.questions()[0].message_id,
        role: 'user',
        content: 'Check the dimensions in this detail: are they complete, consistent and plausible?',
        messageType: 'user',
      },
    })
    expect(piloti.questions()[0]).toMatchObject({
      text: 'Check the dimensions in this detail: are they complete, consistent and plausible?',
      focus_document_id: 'doc_1',
      focus_file_name: 'Grundriss.pdf',
      focus_region: { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.3 },
      reasoning_effort: 'low',
    })
    expect(piloti.questions()[0]).not.toHaveProperty('reply_in_thread')

    const card = screen.getByTestId('piloti-card')
    expect(within(card).getByTestId('piloti-card-thinking')).toBeInTheDocument()
    expect(within(screen.getByTestId('sheet')).getByTestId('piloti-ask-box')).toHaveAttribute('data-status', 'thinking')

    piloti.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    piloti.deliver(2, { type: 'TEXT_MESSAGE_START', message_id: 'a-1' })
    piloti.deliver(3, { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a-1', delta: 'Die Raumhöhe ist ' })
    piloti.deliver(4, { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a-1', delta: 'nicht kotiert.' })
    expect(await within(card).findByText(/Die Raumhöhe ist nicht kotiert\./)).toBeInTheDocument()

    piloti.deliver(5, {
      type: 'RUN_FINISHED',
      outcome: 'answered',
      result: { message_id: 'a-1', text: 'Die Raumhöhe ist nicht kotiert.\n\n[[card:1]]' },
    })
    await waitFor(() => expect(within(card).queryByTestId('piloti-card-thinking')).toBeNull())
    expect(within(card).queryByText(/card:1/)).toBeNull()
    expect(within(card).getByTestId('piloti-card-chat')).toHaveAttribute(
      'href',
      '/app/projects/proj_1/chat?session=s_thread_doc_1'
    )
  })

  it("takes Piloti's answer over as an Anmerkung at the box", async () => {
    serve([])
    serveConversation()
    const created: unknown[] = []
    server.use(
      http.post('/api/documents/:id/annotations', async ({ request }) => {
        created.push(await request.json())
        return HttpResponse.json(
          { annotation: view({ id: 'kept', shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.3, kind: 'hint', body: 'Raumhöhe fehlt.' }) },
          { status: 201 }
        )
      })
    )
    const piloti = scriptedPiloti()
    render(<Harness transport={scriptedRoom().transport} piloti={piloti} />)
    await screen.findByTestId('review-empty')
    await askAboutABox(piloti)
    piloti.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    piloti.deliver(2, { type: 'RUN_FINISHED', outcome: 'answered', result: { message_id: 'a-1', text: '**Raumhöhe** fehlt.' } })

    await userEvent.click(await screen.findByTestId('piloti-card-adopt'))

    await waitFor(() =>
      expect(created).toEqual([
        { page: 1, shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.3, kind: 'hint', body: 'Raumhöhe fehlt.' },
      ])
    )
    await waitFor(() => expect(screen.queryByTestId('piloti-card')).toBeNull())
    expect(within(screen.getByTestId('sheet')).queryByTestId('piloti-ask-box')).toBeNull()
    expect(await screen.findByTestId('review-thread')).toBeInTheDocument()
  })

  it('brings Piloti into a thread with @Piloti: the reply is saved, then this tab asks Piloti while wakes are off', async () => {
    serve([view({ id: 'ann_1', shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.25 })])
    serveConversation()
    const replies: unknown[] = []
    server.use(
      http.post('/api/documents/:id/annotations/:annotationId/replies', async ({ request }) => {
        replies.push(await request.json())
        return HttpResponse.json({
          annotation: view({
            id: 'ann_1',
            shape: 'region',
            x: 0.1,
            y: 0.2,
            w: 0.3,
            h: 0.25,
            replies: [
              {
                id: 'r1',
                annotationId: 'ann_1',
                authorKind: 'person',
                body: 'Stimmt die Breite?',
                createdBy: 'user_me',
                createdByName: 'Miriam Hofer',
                createdAt: '2026-10-01T09:00:00.000Z',
                addressesPiloti: true,
              },
            ],
          }),
          replyId: 'r1',
          wake: 'off',
        })
      })
    )
    const piloti = scriptedPiloti()
    render(<Harness transport={scriptedRoom().transport} piloti={piloti} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    const box = within(thread).getByTestId('thread-reply')
    // The chat's own picker, gesture for gesture: „@" opens it, a pick writes the name.
    await userEvent.type(box, '@pil')
    await userEvent.click(pickerOption(thread, 'agent:piloti'))
    expect(box).toHaveValue('@Piloti ')
    await userEvent.type(box, 'Stimmt die Breite?{Enter}')

    // The mention is what was picked, sent beside the text and never read out of it.
    await waitFor(() =>
      expect(replies).toEqual([
        {
          body: '@Piloti Stimmt die Breite?',
          addressesPiloti: true,
          mentions: [{ targetId: 'agent:piloti', display: 'Piloti' }],
        },
      ])
    )
    await waitFor(() => expect(piloti.questions()).toHaveLength(1))
    expect(piloti.questions()[0]).toMatchObject({
      // The id a server wake of the same reply would use: the two can never both run.
      message_id: wakeTurnId('r1'),
      conversation_id: 's_thread_doc_1',
      text: '@Piloti Stimmt die Breite?',
      reply_in_thread: true,
      focus_region: { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.25, annotation_id: 'ann_1' },
    })
    // No card: Piloti answers in the thread, and the thread says it is on it.
    expect(screen.queryByTestId('piloti-card')).toBeNull()
    expect(within(screen.getByTestId('review-thread')).getByTestId('thread-piloti-pending')).toBeInTheDocument()

    piloti.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    piloti.deliver(2, { type: 'RUN_FINISHED', outcome: 'answered', result: { message_id: 'a-1', text: 'Ja, 1,20 m.' } })
    await waitFor(() => expect(screen.queryByTestId('thread-piloti-pending')).toBeNull())
  })

  it('leaves an @Piloti reply to the server when it wakes Piloti, and shows the work as the server knows it', async () => {
    const mark = view({ id: 'ann_1', shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.25 })
    const asked: AnnotationView['replies'][number] = {
      id: 'r1',
      annotationId: 'ann_1',
      authorKind: 'person',
      body: 'Stimmt die Breite?',
      createdBy: 'user_me',
      createdByName: 'Miriam Hofer',
      createdAt: '2026-10-01T09:00:00.000Z',
      addressesPiloti: true,
    }
    serve([mark], true, true)
    const posted = serveConversation()
    server.use(
      http.post('/api/documents/:id/annotations/:annotationId/replies', () =>
        HttpResponse.json(
          {
            annotation: {
              ...mark,
              replies: [asked],
              pilotiWork: {
                state: 'queued',
                trigger: 'thread_mention',
                forUserId: 'user_me',
                forName: 'Miriam Hofer',
                reasonKind: null,
                since: '2026-10-01T09:00:00.000Z',
              },
            },
            replyId: 'r1',
            wake: 'queued',
          },
          { status: 201 }
        )
      )
    )
    const piloti = scriptedPiloti()
    const room = scriptedRoom()
    render(<Harness transport={room.transport} piloti={piloti} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    const box = within(thread).getByTestId('thread-reply')
    await userEvent.type(box, '@pil')
    await userEvent.click(pickerOption(thread, 'agent:piloti'))
    await userEvent.type(box, 'Stimmt die Breite?{Enter}')

    // The mark's own view says Piloti is on it, for whom: the same line everyone in the room
    // reads, after a reload too. Nothing runs in this tab: no thread, no socket, no question.
    const work = await within(screen.getByTestId('review-thread')).findByTestId('thread-piloti-work')
    expect(work).toHaveAttribute('data-state', 'queued')
    expect(work).toHaveTextContent('Miriam Hofer')
    expect(piloti.questions()).toEqual([])
    expect(posted).toEqual([])

    // Piloti's reply arrives through the room, as the wake job's turn writes it.
    const answered = {
      ...mark,
      replies: [
        asked,
        { ...asked, id: 'r2', authorKind: 'piloti' as const, body: '1,20 m im Schnitt B-B.', addressesPiloti: false },
      ],
    }
    serve([answered], true, true)
    room.send({
      kind: 'event',
      event: {
        kind: 'annotations.changed',
        annotationIds: ['ann_1'],
        change: 'replied',
        actor: { peerId: null, userId: 'user_me', name: 'Piloti', kind: 'piloti' },
      },
    })
    await waitFor(() => expect(screen.queryByTestId('thread-piloti-work')).toBeNull())
    expect(within(screen.getByTestId('review-thread')).getByText('1,20 m im Schnitt B-B.')).toBeInTheDocument()
  })

  it('says why a woken Piloti did not answer, from the mark as the server reads it', async () => {
    serve(
      [
        view({
          id: 'ann_1',
          pilotiWork: {
            state: 'failed',
            trigger: 'thread_mention',
            forUserId: 'user_me',
            forName: 'Miriam Hofer',
            reasonKind: 'budget',
            since: '2026-10-01T09:00:00.000Z',
          },
        }),
      ],
      true,
      true
    )
    render(<Harness transport={scriptedRoom().transport} piloti={scriptedPiloti()} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const work = await within(await screen.findByTestId('review-thread')).findByTestId('thread-piloti-work')
    expect(work).toHaveAttribute('data-state', 'failed')
    expect(work).toHaveTextContent(/budget/i)
  })

  it('delegates an open mark to Piloti from the thread, and shows for whom Piloti works it', async () => {
    serve([view({ id: 'ann_1' })], true, true)
    const patches: unknown[] = []
    server.use(
      http.patch('/api/documents/:id/annotations/:annotationId', async ({ request }) => {
        patches.push(await request.json())
        return HttpResponse.json({
          annotation: view({
            id: 'ann_1',
            delegatedBy: 'user_me',
            delegatedByName: 'Miriam Hofer',
            delegatedAt: '2026-10-13T09:00:00.000Z',
          }),
          wake: 'queued',
        })
      })
    )
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    expect(within(thread).queryByTestId('thread-delegate')).toBeNull()
    await userEvent.click(within(thread).getByRole('button', { name: 'More' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delegate to Piloti' }))

    await waitFor(() => expect(patches).toEqual([{ delegateToPiloti: true }]))
    expect(await within(screen.getByTestId('review-thread')).findByTestId('thread-delegate')).toHaveTextContent(
      'Piloti is working on it · for Miriam Hofer'
    )
  })

  it('offers no delegation while the organization does not let events wake Piloti', async () => {
    serve([view({ id: 'ann_1' })])
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    await userEvent.click(within(thread).getByRole('button', { name: 'More' }))
    expect(await screen.findByRole('menuitem', { name: 'Copy link' }).catch(() => null)).toBeDefined()
    expect(screen.queryByRole('menuitem', { name: 'Delegate to Piloti' })).toBeNull()
  })

  it("draws Piloti's own pointer and what it points out, from the room", async () => {
    const restore = installLayoutObservers({ frameWidth: 800 })
    serve([])
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    await screen.findByTestId('review-empty')
    const PILOTI = { peerId: 'piloti_peer_01', userId: 'piloti', name: 'Piloti', kind: 'piloti' as const }

    room.send({ kind: 'event', event: { kind: 'presence', peer: PILOTI, state: 'here', ttlMs: 25_000 } })
    room.send({ kind: 'event', event: { kind: 'cursor', peer: PILOTI, cursor: { page: 1, x: 0.4, y: 0.4 } } })
    room.send({
      kind: 'event',
      event: { kind: 'activity', peer: PILOTI, state: 'reading', label: 'Liest die Stiege', box: { page: 1, x: 0.5, y: 0.1, w: 0.2, h: 0.3 } },
    })

    const sheet = screen.getByTestId('sheet')
    expect(await within(sheet).findByText('Piloti · Liest die Stiege', { selector: '[data-slot="live-cursor"] *' })).toBeInTheDocument()
    const highlight = await within(sheet).findByTestId('piloti-highlight')
    expect(highlight.style.left).toBe('50%')
    restore()
  })
})

describe('marking on a touch screen', () => {
  const press = (capture: HTMLElement, pointerId: number, at: [number, number], to = at, pointerType = 'mouse') => {
    fireEvent.pointerDown(capture, { button: 0, clientX: at[0], clientY: at[1], pointerId, pointerType })
    fireEvent.pointerMove(capture, { clientX: to[0], clientY: to[1], pointerId, pointerType })
    fireEvent.pointerUp(capture, { clientX: to[0], clientY: to[1], pointerId, pointerType })
  }

  it('sets a point on release, and nothing for a press that travelled: that was a pan', async () => {
    serve([])
    render(<Harness transport={scriptedRoom().transport} />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByRole('button', { name: 'point tool' }))
    const capture = captureSurface()

    fireEvent.pointerDown(capture, { button: 0, clientX: 80, clientY: 120, pointerId: 1 })
    // Pressed, not released: no draft yet.
    expect(screen.queryByTestId('review-draft')).toBeNull()
    fireEvent.pointerMove(capture, { clientX: 260, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(capture, { clientX: 260, clientY: 300, pointerId: 1 })
    expect(screen.queryByTestId('review-draft')).toBeNull()

    press(capture, 1, [80, 120], [83, 121])
    expect(await screen.findByTestId('review-draft')).toBeInTheDocument()
  })

  it('gives the page back to two fingers: a second finger cancels the box being drawn', async () => {
    serve([])
    render(<Harness transport={scriptedRoom().transport} />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByRole('button', { name: 'region tool' }))
    const capture = captureSurface()
    fireEvent.pointerDown(capture, { button: 0, clientX: 80, clientY: 120, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerDown(capture, { button: 0, clientX: 300, clientY: 320, pointerId: 2, pointerType: 'touch' })
    fireEvent.pointerMove(capture, { clientX: 320, clientY: 330, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(capture, { clientX: 320, clientY: 330, pointerId: 2, pointerType: 'touch' })
    fireEvent.pointerUp(capture, { clientX: 320, clientY: 330, pointerId: 1, pointerType: 'touch' })
    expect(screen.queryByTestId('review-draft')).toBeNull()
  })

  it('returns to navigating once a finger has set its mark, so the next drag scrolls', async () => {
    serve([])
    render(<Harness transport={scriptedRoom().transport} />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByRole('button', { name: 'region tool' }))
    press(captureSurface(), 1, [80, 120], [320, 300], 'touch')
    expect(await screen.findByTestId('review-draft')).toBeInTheDocument()
    expect(within(screen.getByTestId('sheet')).queryByTestId('review-capture')).toBeNull()
  })

  it('a mouse keeps its tool for the next mark', async () => {
    serve([])
    render(<Harness transport={scriptedRoom().transport} />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByRole('button', { name: 'region tool' }))
    press(captureSurface(), 1, [80, 120], [320, 300])
    expect(await screen.findByTestId('review-draft')).toBeInTheDocument()
    expect(within(screen.getByTestId('sheet')).getByTestId('review-capture')).toBeInTheDocument()
  })

  it('pins stay 24px on the drawing and catch a finger at 44px', async () => {
    serve([view({ id: 'a', number: 1 })])
    render(<Harness transport={scriptedRoom().transport} />)
    const [pin] = await within(screen.getByTestId('sheet')).findAllByTestId('review-pin')
    expect(pin).toHaveClass('touch-target')
  })
})

/**
 * Mentioning a colleague on a mark, the way the chat does: „@" opens the chat's
 * own picker, its rows are the people who may open the document (the Zuständige
 * picker's list), a pick writes the name and sends whom it means beside the
 * text, and the mark shows the mention as the chat's chip.
 */
describe('mentioning a colleague on a mark', () => {
  const ANNA_PERSON = { userId: 'user_anna', name: 'Anna Berger', email: 'anna@buero.at', profilePictureUrl: null }
  const ANNA_MENTION = { targetId: 'user_anna', display: 'Anna Berger' }

  /** Who may open the document, as the Zuständige picker reads it; the paths asked are recorded. */
  const serveCandidates = () => {
    const asked: string[] = []
    server.use(
      http.get('/api/assignments/:type/:id/candidates', ({ request }) => {
        asked.push(new URL(request.url).pathname)
        return HttpResponse.json({ candidates: [ANNA_PERSON] })
      })
    )
    return asked
  }

  const replyView = (body: string, mentions: AnnotationView['replies'][number]['mentions']) => ({
    id: 'r1',
    annotationId: 'ann_1',
    authorKind: 'person' as const,
    body,
    createdBy: 'user_me',
    createdByName: 'Miriam Hofer',
    createdAt: '2026-10-01T09:00:00.000Z',
    addressesPiloti: false,
    mentions,
  })

  it('offers who may open the document, sends whom was picked, and shows the chip in the thread', async () => {
    serve([view({ id: 'ann_1' })])
    const asked = serveCandidates()
    const replies: unknown[] = []
    server.use(
      http.post('/api/documents/:id/annotations/:annotationId/replies', async ({ request }) => {
        const sent = (await request.json()) as { body: string }
        replies.push(sent)
        return HttpResponse.json({
          annotation: view({ id: 'ann_1', replies: [replyView(sent.body, [ANNA_MENTION])] }),
          replyId: 'r1',
          wake: 'none',
        })
      })
    )
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    const box = within(thread).getByTestId('thread-reply')
    await userEvent.type(box, '@an')
    await userEvent.click(await waitFor(() => pickerOption(thread, 'user_anna')))
    expect(box).toHaveValue('@Anna Berger ')
    await userEvent.type(box, 'bitte die Breite prüfen{Enter}')

    expect(asked).toEqual(['/api/assignments/document/doc_1/candidates'])
    await waitFor(() =>
      expect(replies).toEqual([{ body: '@Anna Berger bitte die Breite prüfen', mentions: [ANNA_MENTION] }])
    )
    // The name, drawn as the chat's chip, never the id.
    const chip = await within(screen.getByTestId('review-thread')).findByTestId('mention-chip')
    expect(chip).toHaveTextContent('@Anna Berger')
    expect(chip).toHaveAttribute('data-mention-target', 'user_anna')
    expect(within(screen.getByTestId('review-thread')).queryByTestId('thread-reply-untold')).toBeNull()
  })

  it('sends nobody for a name typed by hand, and says whom the server did not tell', async () => {
    serve([view({ id: 'ann_1' })])
    serveCandidates()
    const replies: Array<{ body: string; mentions?: unknown }> = []
    server.use(
      http.post('/api/documents/:id/annotations/:annotationId/replies', async ({ request }) => {
        const sent = (await request.json()) as { body: string; mentions?: unknown }
        replies.push(sent)
        // Anna lost the folder between the pick and the send: the server keeps nobody.
        return HttpResponse.json({
          annotation: view({ id: 'ann_1', replies: [replyView(sent.body, [])] }),
          replyId: 'r1',
          wake: 'none',
        })
      })
    )
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    const box = within(thread).getByTestId('thread-reply')

    // Typed by hand, never picked: text, not a mention, and the picker says who can be.
    await userEvent.type(box, '@Max')
    expect(await within(thread).findByTestId('mention-no-results-hint')).toHaveTextContent(
      'You can mention anyone who can open this document.'
    )
    await userEvent.type(box, ' schau mal{Enter}')
    await waitFor(() => expect(replies).toEqual([{ body: '@Max schau mal' }]))
    expect(within(screen.getByTestId('review-thread')).queryByTestId('mention-chip')).toBeNull()

    // Picked, and dropped by the server: the box says so.
    await userEvent.type(box, '@an')
    await userEvent.click(await waitFor(() => pickerOption(thread, 'user_anna')))
    await userEvent.type(box, 'bitte{Enter}')
    await waitFor(() => expect(replies[1]).toEqual({ body: '@Anna Berger bitte', mentions: [ANNA_MENTION] }))
    // Said without a reason it cannot know, and in the singular for one name.
    expect(await within(screen.getByTestId('review-thread')).findByTestId('thread-reply-untold')).toHaveTextContent(
      /^Anna Berger was not told\.$/
    )
  })

  it('mentions a colleague in a new mark, and offers no Piloti there: setting a mark wakes nobody', async () => {
    serve([])
    serveCandidates()
    const posted: unknown[] = []
    server.use(
      http.post('/api/documents/:id/annotations', async ({ request }) => {
        posted.push(await request.json())
        return HttpResponse.json(
          { annotation: view({ id: 'new', body: '@Anna Berger Brüstung prüfen', mentions: [ANNA_MENTION] }) },
          { status: 201 }
        )
      })
    )
    render(<Harness transport={scriptedRoom().transport} />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByRole('button', { name: 'region tool' }))
    const capture = captureSurface()
    fireEvent.pointerDown(capture, { button: 0, clientX: 80, clientY: 120, pointerId: 1 })
    fireEvent.pointerMove(capture, { clientX: 320, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(capture, { clientX: 320, clientY: 300, pointerId: 1 })

    const draft = await screen.findByTestId('review-draft')
    const box = within(draft).getByTestId('review-draft-body')
    await userEvent.type(box, '@')
    await waitFor(() => pickerOption(draft, 'user_anna'))
    expect(within(draft).getAllByTestId('mention-option').map((row) => row.getAttribute('data-target-id'))).toEqual([
      'user_anna',
    ])
    await userEvent.click(pickerOption(draft, 'user_anna'))
    await userEvent.type(box, 'Brüstung prüfen{Enter}')

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ body: '@Anna Berger Brüstung prüfen', mentions: [ANNA_MENTION] })
    // The list shows the new mark with the same chip.
    const row = await screen.findByTestId('review-row')
    expect(within(row).getByTestId('mention-chip')).toHaveTextContent('@Anna Berger')
  })

  /** A thread whose reply POSTs are recorded and answered with what was sent, kept as sent. */
  const serveReplies = (respond?: (sent: { body: string; mentions?: AnnotationView['mentions'] }) => Response) => {
    const sent: Array<{ body: string; mentions?: AnnotationView['mentions'] }> = []
    server.use(
      http.post('/api/documents/:id/annotations/:annotationId/replies', async ({ request }) => {
        const body = (await request.json()) as { body: string; mentions?: AnnotationView['mentions'] }
        sent.push(body)
        return (
          respond?.(body) ??
          HttpResponse.json({
            annotation: view({ id: 'ann_1', replies: [replyView(body.body, body.mentions ?? [])] }),
            replyId: 'r1',
            wake: 'none',
          })
        )
      })
    )
    return sent
  }

  const openThread = async () => {
    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    return { thread, box: within(thread).getByTestId('thread-reply') }
  }

  it('sends the Anna picked last when a namesake was picked and taken back first', async () => {
    serve([view({ id: 'ann_1' })])
    const wien = { ...ANNA_PERSON, userId: 'user_wien' }
    const graz = { ...ANNA_PERSON, userId: 'user_graz', email: 'anna@graz.at' }
    server.use(http.get('/api/assignments/:type/:id/candidates', () => HttpResponse.json({ candidates: [wien, graz] })))
    const sent = serveReplies()
    render(<Harness transport={scriptedRoom().transport} />)
    const { thread, box } = await openThread()

    await userEvent.type(box, '@an')
    await userEvent.click(await waitFor(() => pickerOption(thread, 'user_wien')))
    await userEvent.clear(box)
    await userEvent.type(box, '@an')
    await userEvent.click(await waitFor(() => pickerOption(thread, 'user_graz')))
    await userEvent.type(box, 'bitte{Enter}')

    await waitFor(() =>
      expect(sent).toEqual([{ body: '@Anna Berger bitte', mentions: [{ targetId: 'user_graz', display: 'Anna Berger' }] }])
    )
  })

  it('says the chat’s words when the mention budget is spent, and the bound before sending too many names', async () => {
    serve([view({ id: 'ann_1' })])
    const many = Array.from({ length: 11 }, (_, index) => ({
      userId: `user_${index}`,
      name: `Person ${String.fromCharCode(65 + index)}`,
      email: null,
      profilePictureUrl: null,
    }))
    server.use(http.get('/api/assignments/:type/:id/candidates', () => HttpResponse.json({ candidates: many })))
    const sent = serveReplies(() =>
      HttpResponse.json(
        { error: 'Too many mentions.', code: 'FORBIDDEN', details: { reason: 'mention-rate-limited' } },
        { status: 403 }
      )
    )
    render(<Harness transport={scriptedRoom().transport} />)
    const { thread, box } = await openThread()

    await userEvent.type(box, '@')
    await userEvent.click(await waitFor(() => pickerOption(thread, 'user_0')))
    await userEvent.type(box, 'bitte{Enter}')
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(await within(thread).findByText('Too many mentions. Please wait a few minutes.')).toBeInTheDocument()

    await userEvent.clear(box)
    for (const person of many) {
      await userEvent.type(box, '@')
      await userEvent.click(await waitFor(() => pickerOption(thread, person.userId)))
    }
    await userEvent.type(box, '{Enter}')
    expect(await within(thread).findByText('Mention at most 10 people at once.')).toBeInTheDocument()
    expect(sent).toHaveLength(1)
  })

  it('says the people could not be loaded, and asks again on the next „@"', async () => {
    serve([view({ id: 'ann_1' })])
    let asked = 0
    server.use(
      http.get('/api/assignments/:type/:id/candidates', () => {
        asked += 1
        return asked === 1
          ? HttpResponse.json({ error: 'down' }, { status: 503 })
          : HttpResponse.json({ candidates: [ANNA_PERSON] })
      })
    )
    render(<Harness transport={scriptedRoom().transport} />)
    const { thread, box } = await openThread()

    await userEvent.type(box, '@an')
    expect(await within(thread).findByTestId('mention-picker-notice')).toHaveTextContent(
      'Could not load the people. Type "@" again.'
    )
    await userEvent.type(box, ' @an')
    await waitFor(() => pickerOption(thread, 'user_anna'))
    expect(within(thread).queryByTestId('mention-picker-notice')).toBeNull()
    expect(asked).toBe(2)
  })

  it('marks a mention of the reader as the room knows them, and keeps line breaks only in the thread', async () => {
    const me = { targetId: 'user_room', display: 'Rita Raum' }
    serve([view({ id: 'ann_1', body: '@Rita Raum bitte\nprüfen', mentions: [me] })])
    // The room names this tab's person; the chat knows nobody here.
    const transport: RoomTransport = {
      connect({ onFrame, onOpen }) {
        onOpen()
        onFrame({ kind: 'welcome', self: { userId: 'user_room', name: 'Rita Raum', kind: 'person' } })
        return () => {}
      },
      post: () => {},
    }
    render(<Harness transport={transport} />)

    const row = await screen.findByTestId('review-row')
    await waitFor(() => expect(within(row).getByTestId('mention-chip')).toHaveAttribute('data-mention-me', 'true'))
    expect(within(row).getByTestId('mention-text')).toHaveClass('whitespace-normal')

    await userEvent.click(row)
    const thread = await screen.findByTestId('review-thread')
    const text = within(thread).getByTestId('mention-text')
    expect(text).toHaveClass('whitespace-pre-wrap')
    expect(text).not.toHaveClass('whitespace-normal')
  })
})

/**
 * The loop a mark runs through: whoever is made responsible can answer it, an
 * answer to Piloti reaches Piloti, the reader can take a mark themselves, set
 * and clear its date, find their own marks with the room down, and reword
 * what they wrote.
 */
describe('closing the loop on a mark', () => {
  const ANNA_MENTION = { targetId: 'user_anna', display: 'Anna Berger' }

  /** The PATCHes the thread sends; each answers the mark as given, with the change applied. */
  const servePatches = (mark: AnnotationView) => {
    const patched: Array<Record<string, unknown>> = []
    server.use(
      http.patch('/api/documents/:id/annotations/:annotationId', async ({ request }) => {
        const change = (await request.json()) as Record<string, unknown>
        patched.push(change)
        return HttpResponse.json({ annotation: { ...mark, ...change } })
      })
    )
    return patched
  }

  /** A room that never welcomes this tab: what the review knows of who reads comes from the page. */
  const silentRoom = (): RoomTransport => ({
    connect: ({ onOpen }) => {
      onOpen()
      return () => {}
    },
    post: () => {},
  })

  // With wakes off, an answer to Piloti's own Rückfrage met the thread_reply
  // rule, and the server said so (`off`): this tab asks Piloti, though nobody
  // wrote @Piloti. Without it the answer reached nobody.
  it('asks Piloti itself when an answer to its open Rückfrage meets a rule the switch keeps off', async () => {
    const question = view({ id: 'ann_1', kind: 'question', authorKind: 'piloti', acceptedBy: 'user_me', createdBy: 'user_me' })
    serve([question])
    serveConversation()
    server.use(
      http.post('/api/documents/:id/annotations/:annotationId/replies', () =>
        HttpResponse.json({ annotation: question, replyId: 'r7', wake: 'off' })
      )
    )
    const piloti = scriptedPiloti()
    render(<Harness transport={scriptedRoom().transport} piloti={piloti} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const box = within(await screen.findByTestId('review-thread')).getByTestId('thread-reply')
    await userEvent.type(box, 'Ab Fertigfußboden.{Enter}')

    await waitFor(() => expect(piloti.questions()).toHaveLength(1))
    expect(piloti.questions()[0]).toMatchObject({
      message_id: wakeTurnId('r7'),
      text: 'Ab Fertigfußboden.',
      reply_in_thread: true,
    })
  })

  it('asks Piloti nothing for a reply no rule met, or one the server already woke Piloti for', async () => {
    serve([view({ id: 'ann_1' })])
    serveConversation()
    const wakes = ['none', 'queued']
    server.use(
      http.post('/api/documents/:id/annotations/:annotationId/replies', () =>
        HttpResponse.json({ annotation: view({ id: 'ann_1' }), replyId: 'r1', wake: wakes.shift() })
      )
    )
    const piloti = scriptedPiloti()
    render(<Harness transport={scriptedRoom().transport} piloti={piloti} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const box = within(await screen.findByTestId('review-thread')).getByTestId('thread-reply')
    await userEvent.type(box, 'Passt.{Enter}')
    await waitFor(() => expect(wakes).toHaveLength(1))
    await userEvent.type(box, 'Noch etwas.{Enter}')
    await waitFor(() => expect(wakes).toHaveLength(0))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(piloti.questions()).toHaveLength(0)
  })

  it('offers as Zuständige who may write the document, and „Assign to me" picks the reader', async () => {
    const mark = view({ id: 'ann_1', createdBy: 'user_anna', createdByName: 'Anna Berger' })
    serve([mark])
    const asked: string[] = []
    server.use(
      http.get('/api/assignments/:type/:id/candidates', ({ request }) => {
        asked.push(new URL(request.url).search)
        return HttpResponse.json({
          candidates: [{ userId: 'user_anna', name: 'Anna Berger', email: 'anna@buero.at', profilePictureUrl: null }],
        })
      })
    )
    const patched = servePatches(mark)
    render(<Harness transport={scriptedRoom().transport} canPickAssignee />)

    await userEvent.click(await screen.findByTestId('review-row'))
    await userEvent.click(within(await screen.findByTestId('review-thread')).getByTestId('thread-assignee'))
    await userEvent.click(await screen.findByTestId('assign-pick-self'))

    await waitFor(() => expect(patched).toEqual([{ assigneeUserId: 'user_me' }]))
    // The Zuständige must answer and close the mark: the list is of who may write it.
    expect(asked).toEqual(['?access=write'])
  })

  it('clears a date from its chip, as the Zuständige chip clears its person', async () => {
    const mark = view({ id: 'ann_1', dueOn: '2026-10-20' })
    serve([mark])
    const patched = servePatches(mark)
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    await userEvent.click(within(thread).getByRole('button', { name: 'Remove due date' }))

    await waitFor(() => expect(patched).toEqual([{ dueOn: null }]))
  })

  it('finds the reader’s own marks under „Mine" while the room has not welcomed the tab', async () => {
    serve([
      view({ id: 'ann_1', number: 1, createdBy: 'user_anna', assigneeUserId: 'user_me', body: 'Mir zugewiesen' }),
      view({ id: 'ann_2', number: 2, createdBy: 'user_anna', body: 'Nicht meins' }),
    ])
    render(<Harness transport={silentRoom()} />)
    await waitFor(() => expect(screen.getAllByTestId('review-row')).toHaveLength(2))

    await userEvent.click(screen.getByTestId('review-filter-mine'))

    const rows = screen.getAllByTestId('review-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Mir zugewiesen')
    expect(screen.getByTestId('review-filter-open')).toHaveTextContent('1')
  })

  it('lets the author reword their mark: the composer starts from its text, keeps whom it mentions, and adds whom was picked', async () => {
    const mark = view({ id: 'ann_1', body: '@Anna Berger Brüstung prüfen', mentions: [ANNA_MENTION] })
    serve([mark])
    const patched = servePatches(mark)
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    await userEvent.click(within(thread).getByRole('button', { name: 'More' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }))

    const box = within(screen.getByTestId('review-thread')).getByTestId('thread-edit-body')
    expect(box).toHaveValue('@Anna Berger Brüstung prüfen')
    await userEvent.type(box, ' auf 1,00 m{Enter}')

    await waitFor(() =>
      expect(patched).toEqual([{ body: '@Anna Berger Brüstung prüfen auf 1,00 m', mentions: [ANNA_MENTION] }])
    )
    expect(within(screen.getByTestId('review-thread')).queryByTestId('thread-edit')).toBeNull()
  })

  it('offers no rewording of someone else’s mark, nor of Piloti’s', async () => {
    serve([
      view({ id: 'ann_1', number: 1, createdBy: 'user_anna', createdByName: 'Anna Berger' }),
      view({ id: 'ann_2', number: 2, authorKind: 'piloti', status: 'proposed', x: 0.7 }),
    ])
    render(<Harness transport={scriptedRoom().transport} />)

    for (const index of [0, 1]) {
      await waitFor(() => expect(screen.getAllByTestId('review-row')).toHaveLength(2))
      await userEvent.click(screen.getAllByTestId('review-row')[index] as HTMLElement)
      const thread = await screen.findByTestId('review-thread')
      await userEvent.click(within(thread).getByRole('button', { name: 'More' }))
      await screen.findAllByRole('menuitem')
      expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull()
      await userEvent.keyboard('{Escape}')
    }
  })
})

describe('a mark goes on with the current Fassung', () => {
  /** The marks of each document, as its own list answers them; what was patched, with the document it went to. */
  function serveDocuments(lists: Record<string, AnnotationView[]>) {
    const patched: Array<{ documentId: string; annotationId: string; change: Record<string, unknown> }> = []
    server.use(
      http.get('/api/documents/:id/annotations', ({ params }) =>
        HttpResponse.json({ annotations: lists[String(params.id)] ?? [], canAnnotate: true, pilotiWakes: false })
      ),
      http.patch('/api/documents/:id/annotations/:annotationId', async ({ params, request }) => {
        const change = (await request.json()) as Record<string, unknown>
        const documentId = String(params.id)
        const annotationId = String(params.annotationId)
        patched.push({ documentId, annotationId, change })
        const mark = (lists[documentId] ?? []).find((annotation) => annotation.id === annotationId) as AnnotationView
        if (documentId === 'doc_1') {
          // Under its own name the mark moves in place: same id, same number, now on the sheet.
          const moved = { ...mark, onCurrentFassung: true, fassungNumber: 3 }
          lists.doc_1 = lists.doc_1.map((annotation) => (annotation.id === annotationId ? moved : annotation))
          return HttpResponse.json({ annotation: moved })
        }
        // From the replaced document: a linked mark of this one, the original closed.
        const copy = view({
          ...mark,
          id: `${annotationId}_on_doc_1`,
          documentId: 'doc_1',
          number: 9,
          carriedFrom: { annotationId, documentId, number: mark.number, documentName: 'Grundriss Index B.pdf' },
        })
        lists[documentId] = (lists[documentId] ?? []).map((annotation) =>
          annotation.id === annotationId ? { ...annotation, status: 'resolved' } : annotation
        )
        lists.doc_1 = [...(lists.doc_1 ?? []), copy]
        return HttpResponse.json({ annotation: copy })
      })
    )
    return patched
  }

  it('carries a mark of an earlier Fassung from its card, keeping its number, and the card stops saying it is not drawn', async () => {
    const patched = serveDocuments({ doc_1: [view({ id: 'ann_4', number: 4, onCurrentFassung: false, fassungNumber: 2 })] })
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    expect(within(thread).getByTestId('thread-earlier')).toHaveTextContent('From revision 2. Not drawn on this sheet.')
    await userEvent.click(within(thread).getByTestId('thread-carry'))

    await waitFor(() =>
      expect(patched).toEqual([
        { documentId: 'doc_1', annotationId: 'ann_4', change: { carryToCurrent: true, expectedStatus: 'open' } },
      ])
    )
    await waitFor(() => expect(within(screen.getByTestId('review-thread')).queryByTestId('thread-earlier')).toBeNull())
    expect(screen.getByTestId('review-thread')).toHaveTextContent('#4')
  })

  it('offers no carry on a mark that is closed, or to a reader who may not edit it', async () => {
    serveDocuments({
      doc_1: [
        view({ id: 'ann_closed', number: 1, onCurrentFassung: false, status: 'resolved', closedBy: 'user_me', closedAt: '2026-10-02T08:00:00.000Z' }),
        view({ id: 'ann_ro', number: 2, onCurrentFassung: false, canEdit: false }),
      ],
    })
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    expect(within(await screen.findByTestId('review-thread')).queryByTestId('thread-carry')).toBeNull()
    expect(screen.queryByTestId('review-earlier-bar')).toBeNull()
  })

  it('carries every open mark of earlier Fassungen at once from the list', async () => {
    const patched = serveDocuments({
      doc_1: [
        view({ id: 'ann_1', number: 1, onCurrentFassung: false, fassungNumber: 1 }),
        view({ id: 'ann_2', number: 2, onCurrentFassung: false, fassungNumber: 2 }),
        view({ id: 'ann_3', number: 3 }),
      ],
    })
    render(<Harness transport={scriptedRoom().transport} />)

    const bar = await screen.findByTestId('review-earlier-bar')
    expect(bar).toHaveTextContent('Open from earlier revisions: 2')
    await userEvent.click(within(bar).getByTestId('review-carry-all-earlier'))

    await waitFor(() => expect(patched.map((patch) => patch.annotationId)).toEqual(['ann_1', 'ann_2']))
    await waitFor(() => expect(screen.queryByTestId('review-earlier-bar')).toBeNull())
  })

  it('lists the open marks of the document this one replaces, read-only, and carries one on as a mark of this one', async () => {
    const patched = serveDocuments({
      doc_1: [],
      doc_b: [
        view({ id: 'ann_b4', documentId: 'doc_b', number: 4, body: 'Brüstung unter 1,00 m' }),
        view({ id: 'ann_b5', documentId: 'doc_b', number: 5, status: 'resolved', closedBy: 'user_me', closedAt: '2026-10-02T08:00:00.000Z' }),
      ],
    })
    render(
      <Harness
        transport={scriptedRoom().transport}
        fassung={{ replacedBy: null, replaces: [{ id: 'doc_b', filename: 'Grundriss Index B.pdf' }] }}
      />
    )

    const group = await screen.findByTestId('review-carried-group')
    expect(group).toHaveTextContent('From revision “Grundriss Index B.pdf”')
    expect(within(group).getAllByTestId('review-carried-row')).toHaveLength(1)
    expect(within(group).getByTestId('review-carried-row')).toHaveTextContent('Brüstung unter 1,00 m')
    // Read-only: a row there opens no thread here.
    expect(within(group).queryByTestId('review-row')).toBeNull()

    await userEvent.click(within(group).getByTestId('review-carry-from'))

    await waitFor(() =>
      expect(patched).toEqual([
        { documentId: 'doc_b', annotationId: 'ann_b4', change: { carryToCurrent: true, expectedStatus: 'open' } },
      ])
    )
    await waitFor(() => expect(screen.queryByTestId('review-carried-group')).toBeNull())
    expect(await screen.findByTestId('review-row')).toHaveTextContent('Brüstung unter 1,00 m')
  })

  it('lists nothing from a replaced document while another document replaces this one', async () => {
    serveDocuments({ doc_1: [], doc_b: [view({ id: 'ann_b4', documentId: 'doc_b', number: 4 })] })
    render(
      <Harness
        transport={scriptedRoom().transport}
        fassung={{
          replacedBy: { id: 'doc_d', filename: 'Grundriss Index D.pdf' },
          replaces: [{ id: 'doc_b', filename: 'Grundriss Index B.pdf' }],
        }}
      />
    )

    await screen.findByTestId('review-empty')
    expect(screen.queryByTestId('review-carried-group')).toBeNull()
  })

  it('offers to carry an open mark of a replaced document to the one that replaces it, and says where a carried mark came from', async () => {
    serveDocuments({
      doc_1: [
        view({ id: 'ann_1', number: 1 }),
        view({
          id: 'ann_2',
          number: 2,
          status: 'resolved',
          closedBy: 'user_me',
          closedAt: '2026-10-02T08:00:00.000Z',
          carriedTo: { annotationId: 'ann_c7', documentId: 'doc_c', number: 7, documentName: 'Grundriss Index C.pdf' },
        }),
      ],
    })
    render(
      <Harness
        transport={scriptedRoom().transport}
        fassung={{ replacedBy: { id: 'doc_c', filename: 'Grundriss Index C.pdf' }, replaces: [] }}
      />
    )

    await userEvent.click((await screen.findAllByTestId('review-row'))[0])
    const thread = await screen.findByTestId('review-thread')
    expect(within(thread).getByTestId('thread-earlier')).toHaveTextContent('This document was replaced by “Grundriss Index C.pdf”.')
    expect(within(thread).getByTestId('thread-carry')).toHaveTextContent('Carry to “Grundriss Index C.pdf”')

    await userEvent.click(screen.getByTestId('review-filter-closed'))
    await userEvent.click(await screen.findByTestId('review-row'))
    expect(await screen.findByTestId('thread-carried-to')).toHaveTextContent('Continues in “Grundriss Index C.pdf” as annotation 7')
  })
})
