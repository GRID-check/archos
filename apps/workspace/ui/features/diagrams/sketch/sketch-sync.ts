/**
 * Two canvases on one Skizze converging, element by element (ADR-0110,
 * amended 2026-10-29; the wire is `lib/diagrams/sketch-room-types.ts`).
 *
 * Excalidraw's own collaboration model, on our room instead of its server:
 * every element carries a `version` that each edit bumps and a random
 * `versionNonce`, and `reconcileElements` keeps, per element, the higher
 * version (the lower nonce on a tie). That merge is commutative and
 * idempotent, so two scenes that have heard the same elements are the same
 * scene, whatever order they heard them in. No CRDT: the Fassung a save writes
 * is the record, and this only keeps open canvases in step between saves.
 *
 * What this module adds to the merge is what a lossy room needs:
 *
 * - **deltas**: after an edit, the elements whose version passed what this tab
 *   last got delivered, tombstones included, at most every
 *   {@link DELTA_INTERVAL_MS}, in parts under the wire's caps, one post at a
 *   time. A lost or rate-limited post is rolled back and retried, so an edit
 *   is never marked sent before the server took it. A post the server refuses
 *   for good (400, 413) is split until the one element it refuses is found,
 *   which is set aside and reported (`onRefused`); a 403 stops this tab's
 *   edits. An element too large for any delta is reported (`onTooLarge`).
 *   Both reach the others with the next save.
 * - **no echo, no rebound**: this tab's own events are dropped, and an element
 *   taken from a peer counts as sent, so the canvas's `onChange` after
 *   applying it does not send it back.
 * - **repair**: a gap in a peer's `seq`, or two hash beacons in a row from one
 *   peer that differ from this scene, asks the room for its whole scene
 *   (`want`). Writers answer after a random pause, and one hearing another's
 *   answer first stays quiet; each answers one person at most once per
 *   {@link WANT_COOLDOWN_MS}, and at most {@link ANSWERS_PER_MINUTE} times a
 *   minute in all, whatever a crafted client asks. The asker merges the answer
 *   and sends back what it holds newer or the answerer lacks, so both end on
 *   the union.
 * - **saves**: a peer's `saved` moves this canvas's base only when this scene
 *   is the one saved. Otherwise the base stays, so a save from here is refused
 *   as stale and merges first, and the caller is told (`onSaved`, `matches:
 *   false`) to merge the new Fassung at once.
 * - **deletes across a merge**: a Fassung leaves out what its saver deleted.
 *   Merging one (`mergeFrom`), an element the base Fassung drew, the newer one
 *   leaves out and this canvas has not changed since is deleted here too, as a
 *   tombstone that travels; one changed here since stays, as an edit wins
 *   over a delete in Excalidraw's own merge.
 *
 * Pure apart from the timers and the post it is given. The Excalidraw helpers
 * are injected, so this module never imports Excalidraw: `sketch-canvas.tsx`
 * stays the only one that does (`sketch-isolation.spec.ts`).
 */

import {
  SKETCH_DELTA_MAX_BYTES,
  SKETCH_DELTA_MAX_ELEMENTS,
  SKETCH_FULL_MAX_PARTS,
  type SketchPost,
  type SketchRoomEvent,
  type WireElement,
} from '@/lib/diagrams/sketch-room-types'

/** What the sync reads of an Excalidraw element; the rest travels untouched. */
export interface SketchElement {
  readonly id: string
  readonly type: string
  readonly version: number
  readonly versionNonce: number
  readonly isDeleted: boolean
  readonly index: string | null
}

/** Excalidraw's own merge, hash and repair, handed in by the canvas. */
export interface SketchHelpers<E extends SketchElement, A> {
  /** `reconcileElements(local, remote, appState)`. */
  reconcile(local: readonly E[], remote: readonly E[], appState: A): readonly E[]
  /** `hashElementsVersion`. */
  hash(elements: readonly E[]): number
  /** `restoreElements(remote, null)`: repairs what arrived before it is merged. */
  restore(elements: readonly WireElement[]): readonly E[]
}

export interface SketchTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface SketchSyncOptions<E extends SketchElement, A> {
  /** This tab's peer id: its own events come back from the room and are dropped. */
  peerId: string
  /** The Fassung the scene was loaded from; null when there is none. */
  base: string | null
  helpers: SketchHelpers<E, A>
  /** The canvas's scene now, deleted elements included. */
  scene(): { elements: readonly E[]; appState: A }
  /** Put a merged scene on the canvas without an undo step (`captureUpdate: NEVER`). */
  apply(elements: readonly E[]): void
  /**
   * Say something in the room: `true` when the server took it, `false` when it
   * was lost or limited (try again), `'refused'` when the server refuses it for
   * good (400, 413), `'forbidden'` when this tab may not send it (403).
   */
  post(post: SketchPost): Promise<SketchPostOutcome>
  /** Whether this tab may edit: a reader points and asks, but sends no edit. */
  canWrite(): boolean
  /** Whether anybody else is in the room: alone, nothing is beaconed. */
  others(): boolean
  /** Elements too large to travel live; they wait for the next save. */
  onTooLarge?(ids: readonly string[]): void
  /** Elements the server refused to relay; they wait for the next save too. */
  onRefused?(ids: readonly string[]): void
  /** A peer saved a Fassung; `matches` when this scene is the one saved. */
  onSaved?(saved: { versionId: string; matches: boolean; by: SketchRoomEvent['peer'] }): void
  timers?: SketchTimers
  now?(): number
  random?(): number
  newRequestId?(): string
  limits?: { maxBytes: number; maxElements: number }
}

export type SketchPostOutcome = boolean | 'refused' | 'forbidden'

/** The fastest deltas go up while somebody draws: ten a second, inside `SKETCH_EDIT_LIMIT`. */
export const DELTA_INTERVAL_MS = 100
/** How often a scene's hash is said while others are here. */
export const BEACON_INTERVAL_MS = 5_000
/** A beacon waits for this long a pause in drawing: mid-stroke, every hash differs. */
export const BEACON_IDLE_MS = 1_000
/** A refused or lost delta is tried again after this, doubling up to {@link RETRY_MAX_MS}. */
export const RETRY_MS = 1_000
export const RETRY_MAX_MS = 30_000
/** A writer answers a request for the scene after a pause in this range, so one answers rather than all. */
export const ANSWER_DELAY_MS: readonly [number, number] = [150, 500]
/** After asking for the scene, ask again no sooner than this; and answer one person no oftener. */
export const WANT_COOLDOWN_MS = 5_000
/** The most whole-scene answers one canvas gives in a minute, to anyone. */
export const ANSWERS_PER_MINUTE = 6
/** Mismatching beacons from one peer in a row before asking. */
const MISMATCHES_TO_ASK = 2

const defaultTimers: SketchTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const randomRequestId = () => `req_${Math.random().toString(36).slice(2, 14).padEnd(12, '0')}`

const encoder = new TextEncoder()
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length

/** Split elements into parts under both caps; an element alone over the byte cap is set aside. */
export function chunkElements<E>(elements: readonly E[], limits: { maxBytes: number; maxElements: number }) {
  const chunks: E[][] = []
  const tooLarge: E[] = []
  let current: E[] = []
  let size = 2
  for (const element of elements) {
    const weight = bytesOf(element) + 1
    if (weight + 2 > limits.maxBytes) {
      tooLarge.push(element)
      continue
    }
    if (current.length >= limits.maxElements || size + weight > limits.maxBytes) {
      chunks.push(current)
      current = []
      size = 2
    }
    current.push(element)
    size += weight
  }
  if (current.length > 0) chunks.push(current)
  return { chunks, tooLarge }
}

const visible = <E extends SketchElement>(elements: readonly E[]) => elements.filter((element) => !element.isDeleted)

/** Per element still drawn, its version: what a Fassung held. */
const drawnVersions = (elements: readonly { id: string; version: number; isDeleted: boolean }[]) =>
  new Map(elements.filter((element) => !element.isDeleted).map((element) => [element.id, element.version] as const))

/** The hash peers compare: over the elements still drawn, so a tombstone one side never saw is no difference. */
export const sceneHashOf = <E extends SketchElement>(hash: (elements: readonly E[]) => number, elements: readonly E[]) =>
  hash(visible(elements))

type DeltaEvent = Extract<SketchRoomEvent, { kind: 'scene.delta' }>

export function createSketchSync<E extends SketchElement, A>(options: SketchSyncOptions<E, A>) {
  const { peerId, helpers, timers = defaultTimers, limits = { maxBytes: SKETCH_DELTA_MAX_BYTES, maxElements: SKETCH_DELTA_MAX_ELEMENTS } } = options
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const newRequestId = options.newRequestId ?? randomRequestId

  let base = options.base
  /** Per element the base Fassung drew, its version there: what a newer Fassung leaving it out deleted. */
  let baseVersions = new Map<string, number>()
  /** A 403 on an edit: this tab's write access is gone, so it sends no more. */
  let forbidden = false
  /** When this tab last answered each person, and its answers of the last minute. */
  const answeredPerson = new Map<string, number>()
  const answerTimes: number[] = []
  /** Per element, the version the server last took from this tab, or this tab took from a peer. */
  const delivered = new Map<string, number>()
  let seq = 0
  let flushTimer: unknown = null
  let retryMs = RETRY_MS
  let sending = false
  let again = false
  let lastLocalChange = 0
  let beaconTimer: unknown = null
  let lastWant = Number.NEGATIVE_INFINITY
  let stopped = false
  const lastSeq = new Map<string, number>()
  const mismatches = new Map<string, number>()
  /** Answers this tab owes, by request, until it sends one or hears another's. */
  const owed = new Map<string, unknown>()
  /** Requests already answered by somebody: never answered twice. */
  const answered = new Set<string>()
  /** Full answers being received, by request: which parts and which element ids arrived. */
  const receiving = new Map<string, { parts: Set<number>; of: number; ids: Set<string>; versions: Map<string, [number, number]> }>()

  const pending = (elements: readonly E[]) => elements.filter((element) => element.version > (delivered.get(element.id) ?? -1))

  const schedule = (ms: number) => {
    if (stopped || flushTimer !== null) return
    flushTimer = timers.set(() => {
      flushTimer = null
      void flush()
    }, ms)
  }

  /** Send what changed, one part at a time; on a refusal, keep the rest for the retry. */
  const markDelivered = (elements: readonly E[]) => {
    for (const element of elements) delivered.set(element.id, Math.max(delivered.get(element.id) ?? -1, element.version))
  }

  async function flush(): Promise<void> {
    if (stopped || forbidden || !options.canWrite()) return
    if (sending) {
      again = true
      return
    }
    sending = true
    try {
      const { chunks, tooLarge } = chunkElements(pending(options.scene().elements), limits)
      if (tooLarge.length > 0) options.onTooLarge?.(tooLarge.map((element) => element.id))
      const refused: string[] = []
      const queue = [...chunks]
      while (queue.length > 0) {
        const elements = queue.shift()!
        const delta = { base, seq: seq + 1, elements: elements as unknown as WireElement[] }
        const outcome = await options.post({ delta })
        if (outcome === 'forbidden') {
          forbidden = true
          return
        }
        if (outcome === 'refused') {
          // Split until the element the server refuses is alone; it waits for the save, the rest travels.
          if (elements.length > 1) {
            const half = Math.ceil(elements.length / 2)
            queue.unshift(elements.slice(0, half), elements.slice(half))
            continue
          }
          markDelivered(elements)
          refused.push(elements[0].id)
          continue
        }
        if (!outcome) {
          schedule(retryMs)
          retryMs = Math.min(RETRY_MAX_MS, retryMs * 2)
          return
        }
        seq = delta.seq
        retryMs = RETRY_MS
        markDelivered(elements)
      }
      if (refused.length > 0) options.onRefused?.(refused)
    } finally {
      sending = false
    }
    if (again) {
      again = false
      schedule(0)
    }
  }

  /** The canvas changed: send what changed soon. */
  function changed(): void {
    lastLocalChange = now()
    schedule(DELTA_INTERVAL_MS)
  }

  function want(): void {
    if (stopped || now() - lastWant < WANT_COOLDOWN_MS) return
    lastWant = now()
    void options.post({ want: { requestId: newRequestId(), base } })
  }

  /** Merge what a peer sent into the canvas. Returns the merged scene's elements the remote side won, by id. */
  function merge(remote: readonly WireElement[]): Set<string> {
    const { elements: local, appState } = options.scene()
    // What the peer holds, before `restore` repairs anything: a repaired element is newer here and goes back out.
    const wire = new Map(remote.map((element) => [element.id, element.version] as const))
    const merged = helpers.reconcile(local, helpers.restore(remote), appState)
    const won = new Set<string>()
    for (const element of merged) {
      const version = wire.get(element.id)
      if (version === undefined || element.version !== version) continue
      won.add(element.id)
      delivered.set(element.id, Math.max(delivered.get(element.id) ?? -1, version))
    }
    options.apply(merged)
    return won
  }

  function onDelta(event: DeltaEvent): void {
    if (event.full) return onFullPart(event, event.full)
    merge(event.elements)
    const last = lastSeq.get(event.peer.peerId)
    if (last === undefined || event.seq > last) lastSeq.set(event.peer.peerId, event.seq)
    if (last !== undefined && event.seq > last + 1) want()
  }

  function onFullPart(event: DeltaEvent, full: NonNullable<DeltaEvent['full']>): void {
    // Somebody answers: whoever owed the same answer stays quiet.
    answered.add(full.requestId)
    const debt = owed.get(full.requestId)
    if (debt !== undefined) {
      timers.clear(debt)
      owed.delete(full.requestId)
    }
    let state = receiving.get(full.requestId)
    if (!state) {
      state = { parts: new Set(), of: full.of, ids: new Set(), versions: new Map() }
      receiving.set(full.requestId, state)
    }
    state.parts.add(full.part)
    for (const element of event.elements) {
      state.ids.add(element.id)
      state.versions.set(element.id, [element.version, element.versionNonce])
    }
    merge(event.elements)
    if (state.parts.size < state.of) return
    receiving.delete(full.requestId)
    // The whole of the answerer's scene is here: what it lacks, or holds older, goes back to it.
    for (const element of options.scene().elements) {
      const theirs = state.versions.get(element.id)
      const same = theirs && theirs[0] === element.version && theirs[1] === element.versionNonce
      if (!same) delivered.delete(element.id)
    }
    schedule(0)
  }

  /** Whether this tab may answer the person now: once per cooldown each, and a few times a minute in all. */
  function mayAnswer(userId: string): boolean {
    const at = now()
    while (answerTimes.length > 0 && at - answerTimes[0] >= 60_000) answerTimes.shift()
    if (answerTimes.length >= ANSWERS_PER_MINUTE) return false
    return at - (answeredPerson.get(userId) ?? Number.NEGATIVE_INFINITY) >= WANT_COOLDOWN_MS
  }

  function onWant(event: Extract<SketchRoomEvent, { kind: 'scene.want' }>): void {
    if (!options.canWrite() || forbidden || answered.has(event.requestId) || owed.has(event.requestId)) return
    // Keyed by the person the server stamped, never the tab id a client picks.
    if (!mayAnswer(event.peer.userId)) return
    const [low, high] = ANSWER_DELAY_MS
    const handle = timers.set(() => {
      owed.delete(event.requestId)
      if (answered.has(event.requestId) || stopped || !mayAnswer(event.peer.userId)) return
      answered.add(event.requestId)
      answeredPerson.set(event.peer.userId, now())
      answerTimes.push(now())
      void answer(event.requestId)
    }, low + random() * (high - low))
    owed.set(event.requestId, handle)
  }

  async function answer(requestId: string): Promise<void> {
    const elements = options.scene().elements
    const { chunks } = chunkElements(elements, limits)
    const parts = chunks.slice(0, SKETCH_FULL_MAX_PARTS)
    for (const [part, chunk] of parts.entries()) {
      const delta = { base, seq, full: { requestId, part, of: parts.length }, elements: chunk as unknown as WireElement[] }
      if ((await options.post({ delta })) !== true) return
    }
  }

  function onHash(event: Extract<SketchRoomEvent, { kind: 'scene.hash' }>): void {
    const mine = sceneHashOf(helpers.hash, options.scene().elements)
    if (mine === event.sceneHash) {
      mismatches.delete(event.peer.peerId)
      return
    }
    const count = (mismatches.get(event.peer.peerId) ?? 0) + 1
    if (count < MISMATCHES_TO_ASK) {
      mismatches.set(event.peer.peerId, count)
      return
    }
    mismatches.delete(event.peer.peerId)
    want()
  }

  /** Hear an event of the room. This tab's own are dropped. */
  function receive(event: SketchRoomEvent): void {
    if (stopped || event.peer.peerId === peerId) return
    switch (event.kind) {
      case 'scene.delta':
        return onDelta(event)
      case 'scene.want':
        return onWant(event)
      case 'scene.hash':
        return onHash(event)
      case 'scene.saved': {
        const { elements } = options.scene()
        const matches = sceneHashOf(helpers.hash, elements) === event.sceneHash
        // Only a scene that is the one saved sits on it; any other keeps its base, so its save merges first.
        if (matches) {
          base = event.versionId
          baseVersions = drawnVersions(elements)
        }
        options.onSaved?.({ versionId: event.versionId, matches, by: event.peer })
        return
      }
      default:
        return
    }
  }

  /** What a newer Fassung deleted: drawn in the base, left out of it, and not changed here since. */
  function deletedSince(newer: readonly WireElement[]): WireElement[] {
    const kept = new Set(newer.map((element) => element.id))
    const tombstones: WireElement[] = []
    for (const element of options.scene().elements) {
      if (element.isDeleted || kept.has(element.id) || baseVersions.get(element.id) !== element.version) continue
      const nonce = Math.floor(random() * 2 ** 31)
      tombstones.push({ ...element, isDeleted: true, version: element.version + 1, versionNonce: nonce, updated: now() } as unknown as WireElement)
    }
    return tombstones
  }

  function beacon(): void {
    beaconTimer = timers.set(beacon, BEACON_INTERVAL_MS)
    if (stopped || !options.others() || now() - lastLocalChange < BEACON_IDLE_MS) return
    const elements = options.scene().elements
    void options.post({ hash: { base, sceneHash: sceneHashOf(helpers.hash, elements), count: visible(elements).length } })
  }

  return {
    /**
     * Take the scene the canvas opened with as what everybody has (the
     * Fassung), and start the beacon. `ask`: a late joiner asks the room for
     * what was drawn since.
     */
    start(ask = false) {
      const { elements } = options.scene()
      for (const element of elements) delivered.set(element.id, element.version)
      baseVersions = drawnVersions(elements)
      beaconTimer = timers.set(beacon, BEACON_INTERVAL_MS)
      if (ask) want()
    },
    changed,
    receive,
    /** Ask the room for its whole scene. */
    want,
    /**
     * This tab wrote a Fassung of `elements` (the scene it sent): tell the
     * room, and make it the base. Returns whether the room heard it.
     */
    async saved(versionId: string, elements: readonly WireElement[]) {
      base = versionId
      baseVersions = drawnVersions(elements)
      return (await options.post({ saved: { versionId, sceneHash: sceneHashOf(helpers.hash, elements as unknown as E[]) } })) === true
    },
    /**
     * Merge elements from elsewhere into the canvas: a newer Fassung, after a
     * save was refused as stale. What the Fassung holds counts as everybody's;
     * what this tab holds newer is still unsent and goes out.
     */
    mergeFrom(elements: readonly WireElement[], versionId: string | null) {
      const tombstones = deletedSince(elements)
      base = versionId
      merge([...elements, ...tombstones])
      // A delete taken from the Fassung goes on to the peers that still draw the element.
      for (const tombstone of tombstones) delivered.delete(tombstone.id)
      baseVersions = drawnVersions(elements)
      schedule(0)
    },
    base: () => base,
    /** Whether anything this tab drew has not reached the server yet. */
    unsent: () => pending(options.scene().elements).length > 0,
    stop() {
      stopped = true
      if (flushTimer !== null) timers.clear(flushTimer)
      if (beaconTimer !== null) timers.clear(beaconTimer)
      for (const handle of owed.values()) timers.clear(handle)
      owed.clear()
    },
  }
}

export type SketchSync = ReturnType<typeof createSketchSync>
