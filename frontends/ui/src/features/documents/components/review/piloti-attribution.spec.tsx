/**
 * Piloti on the canvas says whose request it works on (ADR-0105; EU AI Act
 * Art. 50): its cursor tag reads „Piloti · für Anna", or „Treppe · für Anna"
 * beside a pointer label (in the specs' English: „Piloti · for Anna"), and the
 * name is never the part that is clipped. The name is the server's (`publishAsAgent` stamps `forName`); a
 * Piloti peer without one keeps its plain tag rather than inventing a person.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { roomEventSchema, type RoomPeer } from '@/lib/annotations/room-types'
import type { DocumentReview } from '../../hooks/use-document-review'
import type { RoomPeerState } from '../../hooks/use-document-room'
import { pilotiForShort, ReviewPageLayer } from './review-page-layer'

const PILOTI: RoomPeer = {
  peerId: 'piloti-conv_42',
  userId: 'user_anna',
  name: 'Piloti',
  kind: 'piloti',
  forName: 'Anna Berger',
}

const pilotiState = (overrides: Partial<RoomPeerState> = {}): RoomPeerState => ({
  peer: PILOTI,
  cursor: { page: 1, x: 0.4, y: 0.5 },
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

/** The review as far as the page layer reads it: no marks, no tool in hand, one room. */
function reviewWith(peers: RoomPeerState[]): DocumentReview {
  const room: Partial<DocumentReview['room']> = { peers, sendCursor: () => {}, sendDraft: () => {} }
  const piloti: Partial<DocumentReview['piloti']> = { asks: [], openId: null, compose: () => 'ask_1', open: () => {} }
  const review: Partial<DocumentReview> = {
    annotations: [],
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

const cursorTag = () => {
  const cursor = document.querySelector<HTMLElement>('[data-slot="live-cursor"]')
  if (!cursor) throw new Error('no cursor on the page')
  return cursor
}

const renderLayer = (peers: RoomPeerState[]) =>
  render(
    <div style={{ position: 'relative', width: 800, height: 600 }}>
      <div>
        <ReviewPageLayer page={1} review={reviewWith(peers)} focused={false} />
      </div>
    </div>
  )

let restore: () => void
beforeEach(() => {
  restore = installLayoutObservers({ frameWidth: 800 })
})
afterEach(() => restore())

describe('Piloti’s cursor on the canvas', () => {
  it('reads „Piloti · for Anna" when its pointer says nothing else', () => {
    renderLayer([pilotiState()])
    const tag = cursorTag()
    expect(within(tag).getByText('Piloti')).toBeInTheDocument()
    expect(within(tag).getByTestId('piloti-cursor-for')).toHaveTextContent('· for Anna')
    expect(tag.textContent?.replace(/\s+/g, ' ')).toMatch(/^Piloti ?· for Anna$/)
  })

  it('keeps „for Anna" beside its pointer label and what it is doing, outside the part that truncates', () => {
    renderLayer([pilotiState({ label: 'Treppe' })])
    expect(within(cursorTag()).getByText('Treppe')).toHaveClass('truncate')
    expect(within(cursorTag()).getByTestId('piloti-cursor-for')).toHaveTextContent('· for Anna')
    expect(within(cursorTag()).getByTestId('piloti-cursor-for')).not.toHaveClass('truncate')
  })

  it('says it while it works, too', () => {
    renderLayer([pilotiState({ activity: { state: 'reading', box: null, label: 'sieht sich Seite 2 an' } })])
    expect(within(cursorTag()).getByText('sieht sich Seite 2 an')).toBeInTheDocument()
    expect(within(cursorTag()).getByTestId('piloti-cursor-for')).toHaveTextContent('· for Anna')
  })

  it('names nobody when the server could not', () => {
    const { forName: _, ...nameless } = PILOTI
    renderLayer([pilotiState({ peer: nameless })])
    expect(within(cursorTag()).getByText('Piloti')).toBeInTheDocument()
    expect(screen.queryByTestId('piloti-cursor-for')).not.toBeInTheDocument()
  })

  it('carries the name the server stamped through the room’s own parse', () => {
    const event = roomEventSchema.parse({ kind: 'presence', peer: PILOTI, state: 'here', ttlMs: 25_000 })
    expect(event).toMatchObject({ peer: { forName: 'Anna Berger' } })
  })
})

describe('pilotiForShort', () => {
  it('takes the first name, the local part of a bare address, or nothing', () => {
    expect(pilotiForShort({ forName: 'Anna Berger' })).toBe('Anna')
    expect(pilotiForShort({ forName: '  Ben  ' })).toBe('Ben')
    expect(pilotiForShort({ forName: 'c.weber@buero.at' })).toBe('c.weber')
    expect(pilotiForShort({ forName: '   ' })).toBeNull()
    expect(pilotiForShort({})).toBeNull()
  })
})
