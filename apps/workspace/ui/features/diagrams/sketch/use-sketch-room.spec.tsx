/**
 * Two editors on one Skizze, each a `useSketchRoom` on an in-memory room that
 * stamps and relays as the server does: one's edit reaches the other's canvas,
 * a pointer shows as a collaborator, a reader sends no edit, and a save moves
 * the other's base.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { roomEventSchema, type RoomFrame, type RoomPost } from '@/lib/annotations/room-types'
import { sketchEventsOf } from '@/lib/diagrams/sketch-room-types'
import type { RoomTransport } from '@/features/documents'
import type { SketchCollaborator } from './sketch-collaborators'
import { DELTA_INTERVAL_MS, type SketchElement, type SketchHelpers } from './sketch-sync'
import { useSketchRoom, type SketchCanvasBridge } from './use-sketch-room'

type Element = SketchElement & Record<string, unknown>
let lib: typeof import('@excalidraw/excalidraw')
let helpers: SketchHelpers<Element, object>

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy({ filter: 'none' }, { get: (target, key) => (key in target ? target[key as 'filter'] : () => ({ width: 0 })) })) as never
  lib = await import('@excalidraw/excalidraw')
  helpers = {
    reconcile: (local, remote, appState) => lib.reconcileElements(local as never, remote as never, appState as never) as unknown as Element[],
    hash: (elements) => lib.hashElementsVersion(elements as never),
    restore: (elements) => lib.restoreElements(elements as never, null) as unknown as Element[],
  }
})

/** The server, in memory: stamps each post with its sender's identity and relays it to every open tab. */
function inMemoryRoom() {
  const tabs = new Set<(frame: RoomFrame) => void>()
  const posts: Array<{ userId: string; post: RoomPost }> = []
  const transportFor = (userId: string, name: string, { canWrite = true } = {}): RoomTransport => ({
    connect({ onFrame, onOpen }) {
      tabs.add(onFrame)
      queueMicrotask(() => {
        onFrame({ kind: 'welcome', self: { userId, name, kind: 'person' } })
        onOpen()
      })
      return () => {
        tabs.delete(onFrame)
      }
    },
    post: async (post) => {
      posts.push({ userId, post })
      if (!canWrite && (post.delta || post.saved)) return { status: 403, retryAfterMs: 0 }
      const peer = { peerId: post.peerId, userId, name, kind: 'person' as const }
      const events = [
        ...(post.presence ? [{ kind: 'presence', peer, state: post.presence, ttlMs: 25_000 }] : []),
        ...sketchEventsOf(post, peer),
      ]
      for (const event of events) {
        const parsed = roomEventSchema.parse(structuredClone(event))
        for (const tab of [...tabs]) tab({ kind: 'event', event: parsed })
      }
      return { status: 204, retryAfterMs: 0 }
    },
  })
  return { transportFor, posts }
}

function canvas(initial: readonly Element[]) {
  const state = { elements: [...initial], collaborators: new Map<string, SketchCollaborator>() }
  let onApplied = () => {}
  const bridge: SketchCanvasBridge = {
    helpers: helpers as unknown as SketchHelpers<SketchElement, unknown>,
    scene: () => ({ elements: state.elements, appState: {} }),
    apply: (elements) => {
      state.elements = [...(elements as Element[])]
      onApplied()
    },
    setCollaborators: (collaborators) => {
      state.collaborators = collaborators
    },
  }
  return { state, bridge, onApply: (run: () => void) => (onApplied = run) }
}

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useSketchRoom', () => {
  function twoEditors({ annaWrites = true } = {}) {
    const room = inMemoryRoom()
    const initial = lib.restoreElements([{ type: 'rectangle', id: 'box', x: 0, y: 0, width: 40, height: 20 }] as never, null) as unknown as Element[]
    const annaTransport = room.transportFor('user_anna', 'Anna Berger', { canWrite: annaWrites })
    const anna = renderHook(() =>
      useSketchRoom({ documentId: 'doc_1', canWrite: annaWrites, baseVersionId: 'ver_1', transport: annaTransport })
    )
    const maxTransport = room.transportFor('user_max', 'Max Huber')
    const max = renderHook(() => useSketchRoom({ documentId: 'doc_1', canWrite: true, baseVersionId: 'ver_1', transport: maxTransport }))
    const annaCanvas = canvas(initial)
    const maxCanvas = canvas(initial)
    maxCanvas.onApply(() => max.result.current.collab.changed())
    annaCanvas.onApply(() => anna.result.current.collab.changed())
    return { room, anna, max, annaCanvas, maxCanvas }
  }

  it('merges one writer’s edit into the other’s canvas, and shows the pointer as a collaborator', async () => {
    const { anna, max, annaCanvas, maxCanvas } = twoEditors()
    await settle()
    const detachAnna = anna.result.current.collab.attach(annaCanvas.bridge)
    const detachMax = max.result.current.collab.attach(maxCanvas.bridge)
    await settle(50)

    annaCanvas.state.elements = [lib.newElementWith(annaCanvas.state.elements[0] as never, { x: 120 } as never) as unknown as Element]
    act(() => anna.result.current.collab.changed())
    await settle(DELTA_INTERVAL_MS + 10)
    expect(maxCanvas.state.elements[0]).toMatchObject({ id: 'box', x: 120 })

    act(() => anna.result.current.collab.pointer({ pointer: { x: 7, y: 8 }, tool: 'pointer', button: 'down' }))
    await settle(200)
    const anna1 = [...maxCanvas.state.collaborators.values()].find((collaborator) => collaborator.id === 'user_anna')
    expect(anna1).toMatchObject({ username: 'Anna Berger', pointer: { x: 7, y: 8, tool: 'pointer' }, button: 'down' })
    expect(max.result.current.otherPeople()).toEqual(['Anna Berger'])

    detachAnna()
    detachMax()
    anna.unmount()
    max.unmount()
  })

  it('sends no edit from a reader, who still sees the writer draw', async () => {
    const { room, anna, max, annaCanvas, maxCanvas } = twoEditors({ annaWrites: false })
    await settle()
    anna.result.current.collab.attach(annaCanvas.bridge)
    max.result.current.collab.attach(maxCanvas.bridge)
    await settle(50)

    // Something changed on the reader's canvas (in view mode it cannot, but the sync must not rely on that).
    annaCanvas.state.elements = lib.restoreElements(
      [...annaCanvas.state.elements, { type: 'ellipse', id: 'stray', x: 0, y: 0, width: 10, height: 10 }] as never,
      null
    ) as unknown as Element[]
    act(() => anna.result.current.collab.changed())
    maxCanvas.state.elements = [lib.newElementWith(maxCanvas.state.elements[0] as never, { y: 55 } as never) as unknown as Element]
    act(() => max.result.current.collab.changed())
    await settle(DELTA_INTERVAL_MS + 10)

    expect(room.posts.filter(({ userId, post }) => userId === 'user_anna' && post.delta)).toEqual([])
    expect(annaCanvas.state.elements.find((element) => element.id === 'box')).toMatchObject({ y: 55 })
    anna.unmount()
    max.unmount()
  })

  it('tells the other a save: their base moves, and they know their canvas shows what was saved', async () => {
    const { anna, max, annaCanvas, maxCanvas } = twoEditors()
    await settle()
    anna.result.current.collab.attach(annaCanvas.bridge)
    max.result.current.collab.attach(maxCanvas.bridge)
    await settle(50)

    await act(async () => {
      await anna.result.current.announceSave('ver_2')
    })
    expect(max.result.current.base()).toBe('ver_2')
    expect(max.result.current.peerSave).toMatchObject({ versionId: 'ver_2', matches: true, by: { name: 'Anna Berger' } })
    anna.unmount()
    max.unmount()
  })
})
