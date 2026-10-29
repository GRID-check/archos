/**
 * One room per tab, one avatar per person (the interference audit's C5).
 *
 * The Files preview's review is in the document room; the sketch editor it
 * opens used to join `doc:<id>` again as a second peer, so the person counted
 * herself as company: she saw herself on the canvas, the close guard named her,
 * Piloti's snapshot listed her twice and pointer motion never stopped while she
 * was alone. The editor now joins through the review's room.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RoomFrame, RoomPost } from '@/lib/annotations/room-types'
import { useDocumentRoom, type RoomTransport } from '@/features/documents'
import { useSketchRoom } from './use-sketch-room'

const ME = { userId: 'user_anna', name: 'Anna Berger', kind: 'person' as const }

/** A relay: every post comes back to every connection as the server would publish it, stamped as the session. */
function relay() {
  const sinks = new Set<(frame: RoomFrame) => void>()
  const posts: RoomPost[] = []
  let connections = 0
  const transport: RoomTransport = {
    connect({ onFrame, onOpen }) {
      connections++
      sinks.add(onFrame)
      onOpen()
      onFrame({ kind: 'welcome', self: ME })
      return () => sinks.delete(onFrame)
    },
    post(post: RoomPost) {
      posts.push(post)
      const peer = { ...ME, peerId: post.peerId }
      if (post.presence) {
        const event = { kind: 'presence', peer, state: post.presence, ttlMs: 25_000 } as never
        queueMicrotask(() => act(() => { for (const sink of [...sinks]) sink({ kind: 'event', event }) }))
      }
    },
  }
  return { transport, posts, connections: () => connections }
}

describe('the sketch editor opened from the preview', () => {
  it('joins through the preview’s room: one connection, one peer, no company of her own', async () => {
    const { transport, posts, connections } = relay()
    const { result } = renderHook(() => {
      const review = useDocumentRoom('doc_1', { enabled: true, transport })
      const sketch = useSketchRoom({ documentId: 'doc_1', canWrite: true, baseVersionId: 'v1', transport, room: review })
      return { review, sketch }
    })
    await waitFor(() => expect(posts.some((post) => post.presence)).toBe(true))
    expect(connections()).toBe(1)
    expect(result.current.sketch.peerId).toBe(result.current.review.peerId)
    expect(result.current.sketch.peers.get()).toEqual([])
    expect(result.current.review.company()).toBe(false)
    expect(result.current.sketch.otherPeople()).toEqual([])
    // Alone, the canvas pointer goes nowhere: it spends no budget.
    const before = posts.length
    act(() => result.current.sketch.collab.pointer({ pointer: { x: 1, y: 2 }, tool: 'pointer', button: 'up' }))
    expect(posts.length).toBe(before)
  })

  it('names nobody but the others in the close guard, even her own second tab', async () => {
    const { transport } = relay()
    const { result } = renderHook(() => ({
      other: useDocumentRoom('doc_1', { enabled: true, transport }),
      sketch: useSketchRoom({ documentId: 'doc_1', canWrite: true, baseVersionId: 'v1', transport }),
    }))
    await waitFor(() => expect(result.current.sketch.peers.get()).toHaveLength(1))
    expect(result.current.sketch.otherPeople()).toEqual([])
  })
})
