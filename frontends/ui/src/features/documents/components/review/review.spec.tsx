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
 */

import { act, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { server } from '@/mocks/server'
import type { RoomFrame, RoomPost } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import { useDocumentReview } from '../../hooks/use-document-review'
import type { RoomTransport } from '../../hooks/use-document-room'
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

/** The pane's join, without the viewer: page 1's layer in a sized box, the open thread, and the panel. */
function Harness({ transport, onReady }: { transport: RoomTransport; onReady?: (review: ReturnType<typeof useDocumentReview>) => void }) {
  const review = useDocumentReview('doc_1', { enabled: true, transport })
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
      <ReviewPanel review={review} onOpen={(annotation) => review.select(annotation.id)} />
    </>
  )
}

const serve = (annotations: AnnotationView[], canAnnotate = true) =>
  server.use(http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations, canAnnotate })))

beforeEach(() => {
  vi.restoreAllMocks()
})

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
})
