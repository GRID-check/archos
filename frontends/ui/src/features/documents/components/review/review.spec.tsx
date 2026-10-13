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
import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { server } from '@/mocks/server'
import type { TurnSocket, TurnSocketOptions } from '@/adapters/api/turn-socket'
import type { ClientMessage } from '@/adapters/api/wire-v2'
import type { RoomFrame, RoomPost } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import { eventOf, frameOf } from '@/test-utils/wire-v2-fixtures'
import { createCanvasTurnClient, type CanvasTurnClientOptions } from '../../lib/canvas-turn-client'
import { useDocumentReview } from '../../hooks/use-document-review'
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
  replies: [],
  canEdit: true,
  canDelete: true,
  ...overrides,
})

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
}: {
  transport: RoomTransport
  onReady?: (review: ReturnType<typeof useDocumentReview>) => void
  piloti?: ReturnType<typeof scriptedPiloti>
}) {
  const review = useDocumentReview('doc_1', {
    enabled: true,
    transport,
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
            renderAsk={(ask, { flip }) => <PilotiAnswerCard review={review} ask={ask} flip={flip} />}
            renderThread={({ flip }) =>
              review.draft ? (
                <DraftCard review={review} draft={review.draft} flip={flip} canPickAssignee={false} />
              ) : selected ? (
                <ThreadCard review={review} annotation={selected} flip={flip} canPickAssignee={false} />
              ) : null
            }
          />
        </div>
      </div>
      <button type="button" onClick={() => review.setTool('region')}>
        region tool
      </button>
      <button type="button" onClick={() => review.setTool('ask')}>
        piloti tool
      </button>
      <ReviewPanel review={review} onOpen={(annotation) => review.select(annotation.id)} />
    </>
  )
}

const serve = (annotations: AnnotationView[], canAnnotate = true) =>
  server.use(http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations, canAnnotate })))

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

    await waitFor(() => expect(patched).toEqual([{ status: 'open' }]))
    await waitFor(() => expect(within(screen.getByTestId('review-thread')).queryByTestId('thread-accept')).toBeNull())
  })

  it('reads the list again when somebody else changed it, while pointers keep moving', async () => {
    let calls = 0
    server.use(
      http.get('/api/documents/:id/annotations', () => {
        calls += 1
        return HttpResponse.json({
          annotations: calls === 1 ? [] : [view({ id: 'theirs', body: 'Von Anna gesetzt' })],
          canAnnotate: true,
        })
      })
    )
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    await screen.findByTestId('review-empty')

    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['theirs'], change: 'created', actor: { ...ANNA } },
    })
    // A pointer every 30ms for half a second: each one re-renders the review.
    for (let index = 0; index < 16; index += 1) {
      room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: index / 20, y: 0.5 } } })
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    }

    expect(await screen.findByText('Von Anna gesetzt')).toBeInTheDocument()
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

    expect(posted[0]).toEqual({
      path: 'conversation',
      body: {
        id: expect.any(String),
        title: 'Grundriss.pdf · Review',
        projectId: 'proj_1',
        subjectResourceType: 'document',
        subjectResourceId: 'doc_1',
      },
    })
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
      `/app/projects/proj_1/chat?session=${(posted[0].body as { id: string }).id}`
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

  it('brings Piloti into a thread with @Piloti: the reply is saved, then Piloti is asked to answer there', async () => {
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
              },
            ],
          }),
        })
      })
    )
    const piloti = scriptedPiloti()
    render(<Harness transport={scriptedRoom().transport} piloti={piloti} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    const box = within(thread).getByTestId('thread-reply')
    await userEvent.type(box, '@pil')
    await userEvent.click(within(thread).getByTestId('thread-reply-mention-option'))
    expect(within(thread).getByTestId('thread-reply-mention-chip')).toHaveTextContent('@Piloti')
    await userEvent.type(box, 'Stimmt die Breite?{Enter}')

    await waitFor(() => expect(replies).toEqual([{ body: 'Stimmt die Breite?' }]))
    await waitFor(() => expect(piloti.questions()).toHaveLength(1))
    expect(piloti.questions()[0]).toMatchObject({
      text: 'Stimmt die Breite?',
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
    expect(await within(sheet).findByText('Liest die Stiege', { selector: '[data-slot="live-cursor"] *' })).toBeInTheDocument()
    const highlight = await within(sheet).findByTestId('piloti-highlight')
    expect(highlight.style.left).toBe('50%')
    restore()
  })
})
