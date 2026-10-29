/**
 * Two or three canvases on one Skizze converge: what changed goes up once and
 * only once the server took it, nothing comes back as an echo or a rebound,
 * and a lossy room is repaired by hashes and full answers.
 *
 * The merge, the hash and the repair are Excalidraw's own, imported here (a
 * spec may; `sketch-isolation.spec.ts` guards the shipped modules only), so
 * the convergence test proves the sync with the code that runs in the editor.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sketchEventsOf, type SketchPost, type SketchRoomEvent, type WireElement } from '@/lib/diagrams/sketch-room-types'
import {
  ANSWER_DELAY_MS,
  BEACON_INTERVAL_MS,
  createSketchSync,
  DELTA_INTERVAL_MS,
  RETRY_MS,
  sceneHashOf,
  type SketchElement,
  type SketchHelpers,
  type SketchSyncOptions,
} from './sketch-sync'

type Excalidraw = typeof import('@excalidraw/excalidraw')
type Element = SketchElement & Record<string, unknown>
let lib: Excalidraw
let helpers: SketchHelpers<Element, object>

beforeAll(async () => {
  // happy-dom has no 2D context, and Excalidraw asks for one when it loads.
  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy({ filter: 'none' }, { get: (target, key) => (key in target ? target[key as 'filter'] : () => ({ width: 0 })) })) as never
  lib = await import('@excalidraw/excalidraw')
  helpers = {
    reconcile: (local, remote, appState) =>
      lib.reconcileElements(local as never, remote as never, appState as never) as unknown as Element[],
    hash: (elements) => lib.hashElementsVersion(elements as never),
    restore: (elements) => lib.restoreElements(elements as never, null) as unknown as Element[],
  }
})

/** A seeded PRNG (mulberry32): the run is the same every time, Excalidraw's nonces included. */
function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const skeleton = (id: string, x = 0) => ({ type: 'rectangle', id, x, y: 0, width: 40, height: 20 })
const restoreScene = (items: readonly object[]) => lib.restoreElements(items as never, null) as unknown as Element[]
const edit = (element: Element, updates: Record<string, unknown>) => lib.newElementWith(element as never, updates as never) as unknown as Element

const peerOf = (peerId: string) => ({ peerId, userId: `user_${peerId}`, name: peerId, kind: 'person' as const })

interface Replica {
  peerId: string
  elements: Element[]
  sync: ReturnType<typeof createSketchSync<Element, object>>
  posts: SketchPost[]
  applied: number
}

/** A room: every post reaches every replica (its sender too, as the server's echo), unless the network drops it. */
interface RoomOptions {
  refuse?: (peerId: string, post: SketchPost) => boolean
  deliver?: (from: string, to: string, run: () => void) => void
}
type ReplicaOptions = { canWrite?: boolean } & Partial<Omit<SketchSyncOptions<Element, object>, 'canWrite'>>

function room({ refuse = () => false, deliver = (_from, _to, run) => run() }: RoomOptions = {}) {
  const replicas: Replica[] = []
  const make = (peerId: string, initial: readonly Element[], { canWrite = true, ...rest }: ReplicaOptions = {}) => {
    const replica: Replica = { peerId, elements: [...initial], posts: [], applied: 0, sync: null as never }
    replica.sync = createSketchSync<Element, object>({
      peerId,
      base: 'ver_1',
      helpers,
      scene: () => ({ elements: replica.elements, appState: {} }),
      apply: (elements) => {
        replica.applied++
        replica.elements = [...elements]
        // The canvas's onChange after `updateScene`, as Excalidraw fires it.
        replica.sync.changed()
      },
      post: async (post) => {
        replica.posts.push(post)
        if (refuse(peerId, post)) return false
        for (const event of sketchEventsOf(post, peerOf(peerId))) {
          for (const to of replicas) deliver(peerId, to.peerId, () => to.sync.receive(structuredClone(event) as SketchRoomEvent))
        }
        return true
      },
      canWrite: () => canWrite,
      others: () => replicas.length > 1,
      ...rest,
    })
    replicas.push(replica)
    replica.sync.start()
    return replica
  }
  return { replicas, make }
}

const deltas = (replica: Replica) => replica.posts.flatMap((post) => (post.delta && !post.delta.full ? [post.delta] : []))
const versionsOf = (elements: readonly Element[]) =>
  Object.fromEntries(elements.filter((element) => !element.isDeleted).map((element) => [element.id, [element.version, element.versionNonce]]))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sending what changed', () => {
  it('sends only the elements changed since the last delivery, tombstones included, and nothing twice', async () => {
    const { make } = room()
    const a = make('peer_a0000001', restoreScene([skeleton('one'), skeleton('two', 100)]))
    a.elements = [edit(a.elements[0], { x: 5 }), a.elements[1]]
    a.sync.changed()
    await vi.advanceTimersByTimeAsync(DELTA_INTERVAL_MS)
    expect(deltas(a).map((delta) => delta.elements.map((element) => element.id))).toEqual([['one']])

    a.sync.changed()
    await vi.advanceTimersByTimeAsync(DELTA_INTERVAL_MS)
    expect(deltas(a)).toHaveLength(1)

    a.elements = [a.elements[0], edit(a.elements[1], { isDeleted: true })]
    a.sync.changed()
    await vi.advanceTimersByTimeAsync(DELTA_INTERVAL_MS)
    expect(deltas(a)[1]).toMatchObject({ seq: 2, elements: [{ id: 'two', isDeleted: true }] })
  })

  it('splits a large change under the element and byte caps, and sets aside an element too large for any', async () => {
    const tooLarge = vi.fn()
    const { make } = room()
    const a = make('peer_a0000001', [], { limits: { maxBytes: 4_000, maxElements: 3 }, onTooLarge: tooLarge })
    a.elements = restoreScene([...Array.from({ length: 7 }, (_, i) => skeleton(`el_${i}`, i * 50)), { ...skeleton('huge'), text: 'x'.repeat(5_000) }])
    a.sync.changed()
    await vi.advanceTimersByTimeAsync(DELTA_INTERVAL_MS)
    expect(deltas(a).map((delta) => delta.elements.length)).toEqual([3, 3, 1])
    expect(deltas(a).map((delta) => delta.seq)).toEqual([1, 2, 3])
    expect(tooLarge).toHaveBeenCalledWith(['huge'])
    for (const delta of deltas(a)) expect(new TextEncoder().encode(JSON.stringify(delta.elements)).length).toBeLessThanOrEqual(4_000)
  })

  it('keeps a refused delta unsent, under the same seq, and tries again', async () => {
    let refusing = true
    const { make } = room({ refuse: () => refusing })
    const a = make('peer_a0000001', restoreScene([skeleton('one')]))
    a.elements = [edit(a.elements[0], { x: 9 })]
    a.sync.changed()
    await vi.advanceTimersByTimeAsync(DELTA_INTERVAL_MS)
    expect(a.sync.unsent()).toBe(true)
    refusing = false
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(deltas(a).map((delta) => [delta.seq, delta.elements[0].id])).toEqual([
      [1, 'one'],
      [1, 'one'],
    ])
    expect(a.sync.unsent()).toBe(false)
  })

  it('sends nothing from a reader', async () => {
    const { make } = room()
    const reader = make('peer_r0000001', restoreScene([skeleton('one')]), { canWrite: false })
    reader.elements = [edit(reader.elements[0], { x: 9 })]
    reader.sync.changed()
    await vi.advanceTimersByTimeAsync(DELTA_INTERVAL_MS * 3)
    expect(reader.posts).toEqual([])
  })
})

describe('hearing the room', () => {
  it('drops its own echo, applies a peer’s delta, and does not send it back', async () => {
    const { make } = room()
    const initial = restoreScene([skeleton('one')])
    const a = make('peer_a0000001', initial)
    const b = make('peer_b0000001', initial)
    a.elements = [edit(a.elements[0], { x: 30 })]
    a.sync.changed()
    await vi.advanceTimersByTimeAsync(DELTA_INTERVAL_MS * 3)
    expect(a.applied).toBe(0)
    expect(b.applied).toBe(1)
    expect(b.elements[0]).toMatchObject({ x: 30, version: a.elements[0].version })
    expect(deltas(b)).toEqual([])
  })

  it('asks for the whole scene on a gap in a peer’s seq', async () => {
    const { make } = room()
    const b = make('peer_b0000001', [])
    const delta = (seq: number): SketchRoomEvent => ({
      kind: 'scene.delta',
      peer: peerOf('peer_a0000001'),
      base: 'ver_1',
      seq,
      elements: restoreScene([skeleton(`el_${seq}`)]) as unknown as WireElement[],
    })
    b.sync.receive(delta(1))
    b.sync.receive(delta(2))
    expect(b.posts.filter((post) => post.want)).toHaveLength(0)
    b.sync.receive(delta(4))
    expect(b.posts.filter((post) => post.want)).toHaveLength(1)
  })

  it('asks for the whole scene after two mismatching hashes in a row from one peer, never after one', () => {
    const { make } = room()
    const b = make('peer_b0000001', restoreScene([skeleton('one')]))
    const hash = (sceneHash: number, peerId = 'peer_a0000001'): SketchRoomEvent => ({
      kind: 'scene.hash',
      peer: peerOf(peerId),
      base: 'ver_1',
      sceneHash,
      count: 1,
    })
    const mine = sceneHashOf(helpers.hash, b.elements)
    b.sync.receive(hash(mine + 1))
    b.sync.receive(hash(mine))
    b.sync.receive(hash(mine + 1))
    b.sync.receive(hash(mine + 1, 'peer_c0000001'))
    expect(b.posts.filter((post) => post.want)).toHaveLength(0)
    b.sync.receive(hash(mine + 1))
    expect(b.posts.filter((post) => post.want)).toHaveLength(1)
  })

  it('answers a request once: a writer that hears another’s answer first stays quiet', async () => {
    const { make } = room()
    const initial = restoreScene([skeleton('one')])
    const random = vi.spyOn(Math, 'random')
    random.mockReturnValue(0)
    const a = make('peer_a0000001', initial, { random: () => 0 })
    const b = make('peer_b0000001', initial, { random: () => 1 })
    const c = make('peer_c0000001', initial, { canWrite: false })
    c.sync.want()
    await vi.advanceTimersByTimeAsync(ANSWER_DELAY_MS[1] + 10)
    const answers = (replica: Replica) => replica.posts.filter((post) => post.delta?.full)
    expect(answers(a)).toHaveLength(1)
    expect(answers(b)).toHaveLength(0)
    expect(answers(c)).toHaveLength(0)
  })

  it('sends back what it holds newer, or the answerer lacks, after a full answer', async () => {
    const { make } = room()
    const initial = restoreScene([skeleton('one')])
    const a = make('peer_a0000001', initial)
    // b drew `two` while a did not hear it, and the server took it.
    const b = make('peer_b0000001', restoreScene([skeleton('one'), skeleton('two', 100)]))
    b.sync.want()
    await vi.advanceTimersByTimeAsync(ANSWER_DELAY_MS[1] + DELTA_INTERVAL_MS + 10)
    expect(versionsOf(a.elements)).toEqual(versionsOf(b.elements))
  })

  it('tells the room a save, and a peer moves its base and knows whether its scene is the saved one', async () => {
    const onSaved = vi.fn()
    const { make } = room()
    const initial = restoreScene([skeleton('one')])
    const a = make('peer_a0000001', initial)
    const b = make('peer_b0000001', initial, { onSaved })
    await a.sync.saved('ver_2', sceneHashOf(helpers.hash, a.elements))
    expect(b.sync.base()).toBe('ver_2')
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ versionId: 'ver_2', matches: true }))
  })
})

describe('convergence', () => {
  it.each([
    [2, 0xa11ce],
    [3, 0xb0b],
    [3, 0x5eed],
  ])('%i replicas converge through drops, reorders and refusals once the room heals (seed %i)', async (count, seed) => {
    const rand = seeded(seed)
    vi.spyOn(Math, 'random').mockImplementation(rand)
    let lossy = true
    const { replicas, make } = room({
      refuse: () => lossy && rand() < 0.05,
      deliver: (from, to, run) => {
        if (from !== to && lossy && rand() < 0.2) return
        setTimeout(run, lossy ? Math.floor(rand() * 300) : 5)
      },
    })
    const initial = restoreScene([skeleton('base_0'), skeleton('base_1', 100)])
    for (let i = 0; i < count; i++) make(`peer_${i}0000000`, initial)

    let made = 0
    for (let step = 0; step < 80; step++) {
      const replica = replicas[Math.floor(rand() * replicas.length)]
      const live = replica.elements.filter((element) => !element.isDeleted)
      const roll = rand()
      if (roll < 0.35 || live.length === 0) {
        replica.elements = restoreScene([...replica.elements, skeleton(`${replica.peerId}_${made++}`, rand() * 500)])
      } else {
        const target = live[Math.floor(rand() * live.length)]
        const updates = roll < 0.85 ? { x: Math.round(rand() * 500), y: Math.round(rand() * 300) } : { isDeleted: true }
        replica.elements = replica.elements.map((element) => (element.id === target.id ? edit(element, updates) : element))
      }
      replica.sync.changed()
      await vi.advanceTimersByTimeAsync(Math.floor(rand() * 200))
    }

    lossy = false
    await vi.advanceTimersByTimeAsync(BEACON_INTERVAL_MS * 8)

    const [first, ...rest] = replicas
    for (const replica of rest) {
      expect(versionsOf(replica.elements)).toEqual(versionsOf(first.elements))
      expect(sceneHashOf(helpers.hash, replica.elements)).toBe(sceneHashOf(helpers.hash, first.elements))
    }
    expect(Object.keys(versionsOf(first.elements)).length).toBeGreaterThan(2)
    for (const replica of replicas) expect(replica.sync.unsent()).toBe(false)
    for (const replica of replicas) replica.sync.stop()
  })
})
