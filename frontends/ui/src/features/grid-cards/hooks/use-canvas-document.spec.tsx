/**
 * The `canvas_activity` card's marks as a live view, against a scripted
 * channel: a hint on the document's room is a fresh read, the cards on one
 * document share one subscription and one read, and a card that leaves the
 * screen or unmounts lets the channel go.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAnnotations } from '@/lib/annotations/client'
import type { RoomEvent } from '@/lib/annotations/room-types'
import type { AnnotationListResponse, AnnotationView } from '@/lib/annotations/types'
import { realtimeLink, type ChannelFrame, type ChannelLink } from '@/features/realtime/use-channel'
import { __resetCanvasDocuments, CARD_CHANNEL_BUDGET, useLiveMarks } from './use-canvas-document'

vi.mock('@/lib/annotations/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/annotations/client')>()),
  listAnnotations: vi.fn(),
}))

vi.mock('@/features/realtime/use-channel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/realtime/use-channel')>()),
  realtimeLink: vi.fn(),
}))

const list = vi.mocked(listAnnotations)

/** The fields of a mark the card reads; the rest of a view does not reach it. */
const mark = (id: string, status: AnnotationView['status']) =>
  ({
    id,
    status,
    canEdit: true,
    acceptedByName: null,
    closedByName: null,
    assigneeUserId: null,
    dueOn: null,
    kind: 'defect',
    body: 'x',
  }) as unknown as AnnotationView

const answer = (...annotations: AnnotationView[]) =>
  ({ annotations, canAnnotate: true, pilotiWakes: false }) as unknown as AnnotationListResponse

/** The tab's connection, scripted: which channels were joined and left, and a way to speak in one. */
function scriptedChannels() {
  const open = new Map<string, (frame: ChannelFrame) => void>()
  const joins: string[] = []
  const leaves: string[] = []
  vi.mocked(realtimeLink).mockImplementation((ch: string): ChannelLink => ({
    connect({ onFrame, onOpen }) {
      joins.push(ch)
      open.set(ch, onFrame)
      onOpen()
      return () => {
        leaves.push(ch)
        open.delete(ch)
      }
    },
    post: () => {},
  }))
  const changed: RoomEvent = {
    kind: 'annotations.changed',
    annotationIds: ['ann_7'],
    change: 'updated',
    actor: { peerId: null, userId: 'user_anna', name: 'Anna Berger', kind: 'person' },
  }
  return {
    joins,
    leaves,
    open,
    hint: (ch: string) => act(() => open.get(ch)?.({ kind: 'event', event: changed })),
  }
}

beforeEach(() => {
  list.mockReset()
  list.mockResolvedValue(answer(mark('ann_7', 'proposed')))
})

afterEach(() => {
  __resetCanvasDocuments()
})

const ON_SCREEN = { seen: true, onScreen: true }

describe('useLiveMarks', () => {
  it('reads the marks again on every annotations.changed, a burst as one read', async () => {
    const channels = scriptedChannels()
    const { result } = renderHook(() => useLiveMarks('doc_1', ON_SCREEN))

    await waitFor(() => expect(result.current.lookup('ann_7')).toMatchObject({ status: 'proposed' }))
    expect(result.current.connected).toBe(true)
    expect(channels.joins).toEqual(['doc:doc_1'])
    expect(list).toHaveBeenCalledTimes(1)

    list.mockResolvedValue(answer(mark('ann_7', 'resolved')))
    channels.hint('doc:doc_1')
    channels.hint('doc:doc_1')
    channels.hint('doc:doc_1')

    await waitFor(() => expect(result.current.lookup('ann_7')).toMatchObject({ status: 'resolved' }))
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('stamps the marks a burst of hints named, so a card refetches what the server records on them', async () => {
    const channels = scriptedChannels()
    const watching = renderHook(() => useLiveMarks('doc_1', { ...ON_SCREEN, watch: ['ann_7'] }))
    const other = renderHook(() => useLiveMarks('doc_1', { ...ON_SCREEN, watch: ['ann_9'] }))
    await waitFor(() => expect(watching.result.current.lookup('ann_7')).toBeDefined())
    expect(watching.result.current.touched).toBe(0)

    channels.hint('doc:doc_1')
    channels.hint('doc:doc_1')
    await waitFor(() => expect(watching.result.current.touched).toBe(1))
    // A burst is one stamp, and a card watching other marks is not moved by it.
    expect(other.result.current.touched).toBe(0)
  })

  it('stamps every mark when the channel comes back, because nothing is replayed', async () => {
    scriptedChannels()
    const { result, rerender } = renderHook(
      (props: { onScreen: boolean }) => useLiveMarks('doc_1', { seen: true, onScreen: props.onScreen, watch: ['ann_9'] }),
      { initialProps: { onScreen: true } }
    )
    await waitFor(() => expect(result.current.connected).toBe(true))
    expect(result.current.touched).toBe(0)

    rerender({ onScreen: false })
    rerender({ onScreen: true })
    await waitFor(() => expect(result.current.touched).toBeGreaterThan(0))
  })

  it('lets a fresh list supersede what a write returned', async () => {
    const channels = scriptedChannels()
    const { result } = renderHook(() => useLiveMarks('doc_1', ON_SCREEN))
    await waitFor(() => expect(result.current.lookup('ann_7')).toMatchObject({ status: 'proposed' }))

    act(() => result.current.adopt(mark('ann_7', 'open')))
    expect(result.current.lookup('ann_7')).toMatchObject({ status: 'open' })

    list.mockResolvedValue(answer())
    channels.hint('doc:doc_1')
    await waitFor(() => expect(result.current.lookup('ann_7')).toBe('gone'))
  })

  it('gives two cards on one document one subscription and one read', async () => {
    const channels = scriptedChannels()
    const first = renderHook(() => useLiveMarks('doc_1', ON_SCREEN))
    const second = renderHook(() => useLiveMarks('doc_1', ON_SCREEN))

    await waitFor(() => expect(second.result.current.lookup('ann_7')).toMatchObject({ status: 'proposed' }))
    expect(channels.joins).toEqual(['doc:doc_1'])
    expect(list).toHaveBeenCalledTimes(1)

    list.mockResolvedValue(answer(mark('ann_7', 'dismissed')))
    channels.hint('doc:doc_1')
    await waitFor(() => expect(first.result.current.lookup('ann_7')).toMatchObject({ status: 'dismissed' }))
    expect(second.result.current.lookup('ann_7')).toMatchObject({ status: 'dismissed' })
    expect(list).toHaveBeenCalledTimes(2)

    // One card going leaves the channel to the other.
    first.unmount()
    expect(channels.leaves).toEqual([])
    expect(second.result.current.connected).toBe(true)
    second.unmount()
    expect(channels.leaves).toEqual(['doc:doc_1'])
  })

  it('leaves the channel when the card unmounts', async () => {
    const channels = scriptedChannels()
    const { result, unmount } = renderHook(() => useLiveMarks('doc_1', ON_SCREEN))
    await waitFor(() => expect(result.current.connected).toBe(true))

    unmount()
    expect(channels.leaves).toEqual(['doc:doc_1'])
    expect(channels.open.size).toBe(0)
  })

  it('leaves the channel when the card scrolls away, keeps what it read, and catches up when it is back', async () => {
    const channels = scriptedChannels()
    const { result, rerender } = renderHook(
      (props: { onScreen: boolean }) => useLiveMarks('doc_1', { seen: true, onScreen: props.onScreen }),
      { initialProps: { onScreen: true } }
    )
    await waitFor(() => expect(result.current.lookup('ann_7')).toMatchObject({ status: 'proposed' }))

    rerender({ onScreen: false })
    expect(channels.leaves).toEqual(['doc:doc_1'])
    expect(result.current.connected).toBe(false)
    expect(result.current.lookup('ann_7')).toMatchObject({ status: 'proposed' })

    list.mockResolvedValue(answer(mark('ann_7', 'resolved')))
    rerender({ onScreen: true })
    await waitFor(() => expect(result.current.lookup('ann_7')).toMatchObject({ status: 'resolved' }))
    expect(channels.joins).toEqual(['doc:doc_1', 'doc:doc_1'])
  })

  it('holds no more than its budget of channels, and promotes the next document when one frees up', async () => {
    const channels = scriptedChannels()
    const ids = Array.from({ length: CARD_CHANNEL_BUDGET + 1 }, (_, index) => `doc_${index}`)
    const cards = ids.map((id) => renderHook(() => useLiveMarks(id, ON_SCREEN)))

    await waitFor(() => expect(list).toHaveBeenCalledTimes(ids.length))
    expect(channels.joins).toEqual(ids.slice(0, CARD_CHANNEL_BUDGET).map((id) => `doc:${id}`))
    expect(cards.at(-1)?.result.current.connected).toBe(false)

    cards[0]?.unmount()
    expect(channels.joins.at(-1)).toBe(`doc:${ids.at(-1)}`)
    await waitFor(() => expect(cards.at(-1)?.result.current.connected).toBe(true))
  })
})
