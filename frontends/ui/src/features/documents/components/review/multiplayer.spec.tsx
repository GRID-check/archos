/**
 * The room on the sheet, the way a design tool has it: a colleague's cursor
 * chat keeps their name above the words; a pointer that rests goes quiet; the
 * mark a colleague has open is ringed in their colour with their name; a box
 * being dragged out says whose it is; „/" opens a bubble at the reader's own
 * pointer that types live into the room and clears itself.
 */

import { act, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import type { RoomPeer } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import type { DocumentReview } from '../../hooks/use-document-review'
import type { RoomPeerState } from '../../hooks/use-document-room'
import { CURSOR_CHAT_LINGER_MS, CursorChat } from './cursor-chat'
import { CURSOR_IDLE_MS, peerSelections, ReviewPageLayer } from './review-page-layer'

const ANNA: RoomPeer = { peerId: 'tab-anna', userId: 'user_anna', name: 'Anna Berger', kind: 'person' }
const JAKOB: RoomPeer = { peerId: 'tab-jakob', userId: 'user_jakob', name: 'Jakob Huber', kind: 'person' }

const person = (peer: RoomPeer, overrides: Partial<RoomPeerState> = {}): RoomPeerState => ({
  peer,
  cursor: { page: 1, x: 0.4, y: 0.5 },
  movedAt: Date.now(),
  tool: 'select',
  viewport: null,
  draft: null,
  chat: null,
  label: null,
  selected: null,
  activity: null,
  highlight: null,
  expiresAt: Date.now() + 25_000,
  ...overrides,
})

const MARK = {
  id: 'ann_1',
  documentId: 'doc_1',
  number: 1,
  page: 1,
  shape: 'point',
  x: 0.3,
  y: 0.3,
  w: null,
  h: null,
  status: 'open',
  authorKind: 'person',
  createdBy: 'user_me',
  onCurrentFassung: true,
  kind: 'defect',
} as AnnotationView

function reviewWith(peers: RoomPeerState[], annotations: AnnotationView[] = []): DocumentReview {
  const room: Partial<DocumentReview['room']> = {
    peers,
    self: { peerId: 'tab-me', userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } as DocumentReview['room']['self'],
    sendCursor: () => {},
    sendDraft: () => {},
  }
  const piloti: Partial<DocumentReview['piloti']> = { asks: [], openId: null, compose: () => 'ask_1', open: () => {} }
  const review: Partial<DocumentReview> = {
    annotations,
    tool: 'select',
    draft: null,
    selectedId: null,
    hoveredId: null,
    filter: 'open',
    room: room as DocumentReview['room'],
    piloti: piloti as DocumentReview['piloti'],
    select: () => {},
    setDraft: () => {},
    hover: () => {},
  }
  return review as DocumentReview
}

const renderLayer = (peers: RoomPeerState[], annotations: AnnotationView[] = []) =>
  render(
    <div style={{ position: 'relative', width: 800, height: 600 }}>
      <div>
        <ReviewPageLayer page={1} review={reviewWith(peers, annotations)} focused={false} />
      </div>
    </div>
  )

let restore: () => void
beforeEach(() => {
  restore = installLayoutObservers({ frameWidth: 800 })
})
afterEach(() => {
  restore()
  vi.useRealTimers()
})

describe('a colleague’s pointer', () => {
  it('keeps their name above their cursor chat, so the room knows who said it', () => {
    renderLayer([person(ANNA, { chat: 'Hier fehlt die Kote' })])
    const bubble = document.querySelector<HTMLElement>('[data-slot="live-cursor-chat"]')
    expect(bubble).not.toBeNull()
    expect(within(bubble as HTMLElement).getByText('Anna Berger')).toBeInTheDocument()
    expect(within(bubble as HTMLElement).getByText('Hier fehlt die Kote')).toBeInTheDocument()
  })

  it('goes quiet when it has rested a while, and its tag folds away', () => {
    renderLayer([person(ANNA, { movedAt: Date.now() - CURSOR_IDLE_MS - 1 }), person(JAKOB)])
    const cursors = document.querySelectorAll<HTMLElement>('[data-slot="live-cursor"]')
    expect([...cursors].map((cursor) => cursor.dataset.idle ?? null)).toEqual(['true', null])
  })

  it('says whose box is being dragged out', () => {
    renderLayer([person(ANNA, { draft: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })])
    expect(within(screen.getByTestId('review-peer-draft')).getByText('Anna')).toBeInTheDocument()
  })
})

describe('the marks the others have open', () => {
  it('rings the mark in their colour and names them, one face per person, never the reader’s own tabs', () => {
    renderLayer(
      [
        person(ANNA, { selected: 'ann_1' }),
        person({ ...ANNA, peerId: 'tab-anna-2' }, { selected: 'ann_1' }),
        person(JAKOB, { selected: 'ann_1' }),
        person({ peerId: 'tab-me-2', userId: 'user_me', name: 'Miriam Hofer', kind: 'person' }, { selected: 'ann_1' }),
      ],
      [MARK]
    )
    expect(screen.getByTestId('review-peer-selection')).toBeInTheDocument()
    expect(screen.getByTestId('review-peer-selection-tag')).toHaveTextContent('Anna +1')
  })

  it('groups by mark and leaves Piloti out: it says what it does with its own pointer', () => {
    const piloti: RoomPeer = { peerId: 'piloti-c', userId: 'user_anna', name: 'Piloti', kind: 'piloti' }
    const selections = peerSelections(
      [person(ANNA, { selected: 'ann_1' }), person(JAKOB, { selected: 'ann_2' }), person(piloti, { selected: 'ann_1' })],
      'user_me'
    )
    expect([...selections.entries()].map(([mark, states]) => [mark, states.map((state) => state.peer.userId)])).toEqual([
      ['ann_1', ['user_anna']],
      ['ann_2', ['user_jakob']],
    ])
  })
})

describe('cursor chat', () => {
  it('types live into the room, and Enter lets the line linger before it clears', () => {
    vi.useFakeTimers()
    const said: Array<string | null> = []
    const onClose = vi.fn()
    render(<CursorChat userId="user_me" from={{ x: 100, y: 100 }} onChat={(text) => said.push(text)} onClose={onClose} />)
    const field = screen.getByTestId('cursor-chat-input')

    fireEvent.change(field, { target: { value: 'H' } })
    fireEvent.change(field, { target: { value: 'Hier' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(said).toEqual(['H', 'Hier'])
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => void vi.advanceTimersByTime(CURSOR_CHAT_LINGER_MS))
    expect(said).toEqual(['H', 'Hier', null])
  })

  it('takes the line away at once on Esc, and keeps Esc from closing anything else', () => {
    const said: Array<string | null> = []
    const outside = vi.fn()
    window.addEventListener('keydown', outside)
    try {
      render(<CursorChat userId="user_me" from={null} onChat={(text) => said.push(text)} onClose={() => {}} />)
      const field = screen.getByTestId('cursor-chat-input')
      fireEvent.change(field, { target: { value: 'Hier' } })
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(said).toEqual(['Hier', null])
      expect(outside).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', outside)
    }
  })
})
