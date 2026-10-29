'use client'

/**
 * A Skizze's editor in its document's room (`doc:<id>`): the others' pointers
 * and selections on the canvas, their edits merged into it, and this tab's
 * saves announced (`docs/architecture/diagrams.md`, "Two people on one
 * Skizze").
 *
 * The room is the document's own (`useDocumentRoom`); the convergence is
 * `./sketch-sync`; who is drawn where is `./sketch-collaborators`. What this
 * hook adds is the wiring, and the one seam that keeps Excalidraw out of it:
 * the canvas (`sketch-canvas.tsx`, the only module that imports Excalidraw)
 * attaches a {@link SketchCanvasBridge} once its API is ready, carrying
 * Excalidraw's merge, hash and repair and a way to read and update its scene.
 *
 * Pointers and selections go up only while another person is here. Edits go
 * up only from a writer; a reader's canvas is in view mode and still sees
 * everyone draw.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SCENE_POINTER_INTERVAL_MS,
  SCENE_SELECTION_INTERVAL_MS,
  SCENE_SELECTION_MAX,
  type ScenePointer,
  type SketchRoomEvent,
  type WireElement,
} from '@/lib/diagrams/sketch-room-types'
import type { RealtimePeer } from '@/lib/realtime/types'
import { useDocumentRoom, type RoomTransport } from '@/features/documents'
import { collaboratorsOf, type SketchCollaborator } from './sketch-collaborators'
import { createSketchSync, sceneHashOf, type SketchElement, type SketchHelpers, type SketchSync } from './sketch-sync'

/** What the canvas hands the room once Excalidraw is ready. */
export interface SketchCanvasBridge<E extends SketchElement = SketchElement, A = unknown> {
  helpers: SketchHelpers<E, A>
  /** The scene now, deleted elements included. */
  scene(): { elements: readonly E[]; appState: A }
  /** Put a merged scene on the canvas, without an undo step. */
  apply(elements: readonly E[]): void
  /** Show who else is here. */
  setCollaborators(collaborators: Map<string, SketchCollaborator>): void
}

/** What the canvas calls on the room: the `collab` prop of `sketch-canvas.tsx`. */
export interface SketchCollab {
  /** Whether this tab may edit; a reader's canvas is in view mode. */
  canWrite: boolean
  attach(bridge: SketchCanvasBridge): () => void
  /** Excalidraw's `onChange`. */
  changed(): void
  /** Excalidraw's `onPointerUpdate`, in scene coordinates. */
  pointer(pointer: ScenePointer): void
  /** The selected element ids, on every change of them. */
  selection(ids: readonly string[]): void
}

export interface SketchRoomOptions {
  documentId: string | null
  /** Whether the reader may write the document: only a writer's edits travel. */
  canWrite: boolean
  /** The Fassung the canvas opened. */
  baseVersionId: string | null
  /** Defaults to the tab's live connection; the `/dev` preview and the specs hand in their own. */
  transport?: RoomTransport
  /** What a peer is called on the canvas (Piloti with the person it acts for). */
  nameOf?: (peer: RealtimePeer) => string
}

/** A peer's save, as the dialog shows it. */
export interface PeerSave {
  versionId: string
  by: RealtimePeer
  /** Whether this canvas shows what was saved: nothing of this tab's is left unsaved. */
  matches: boolean
}

const SYNC_EVENTS = new Set<string>(['scene.delta', 'scene.hash', 'scene.want', 'scene.saved'])
const isSyncEvent = (event: { kind: string }): event is SketchRoomEvent => SYNC_EVENTS.has(event.kind)

export function useSketchRoom({ documentId, canWrite, baseVersionId, transport, nameOf }: SketchRoomOptions) {
  const room = useDocumentRoom(documentId ?? '', { enabled: documentId !== null, transport })
  const sync = useRef<SketchSync | null>(null)
  const bridgeRef = useRef<SketchCanvasBridge | null>(null)
  const settings = useRef({ canWrite, baseVersionId, nameOf })
  settings.current = { canWrite, baseVersionId, nameOf }
  const [tooLarge, setTooLarge] = useState<readonly string[]>([])
  const [peerSave, setPeerSave] = useState<PeerSave | null>(null)
  const lastSelection = useRef('')

  const { send, onRoomEvent, company, peers, peerId, status } = room
  const live = useRef(false)
  live.current = status === 'live'

  const attach = useCallback(
    (bridge: SketchCanvasBridge) => {
      bridgeRef.current = bridge
      const created = createSketchSync({
        peerId,
        base: settings.current.baseVersionId,
        helpers: bridge.helpers,
        scene: () => bridge.scene(),
        apply: (elements) => bridge.apply(elements),
        post: async (post) => {
          const outcome = await send(post)
          return outcome !== undefined && outcome.status >= 200 && outcome.status < 300
        },
        canWrite: () => settings.current.canWrite,
        others: () => company(),
        onTooLarge: (ids) => setTooLarge((before) => (before.join() === ids.join() ? before : ids)),
        onSaved: (saved) => setPeerSave(saved),
      })
      sync.current = created
      // A canvas that joins a live room asks at once for what was drawn since its Fassung.
      created.start(live.current)
      const showPeers = () => bridge.setCollaborators(collaboratorsOf(peers.get(), { nameOf: settings.current.nameOf }))
      showPeers()
      const unsubscribePeers = peers.subscribe(showPeers)
      const unsubscribeEvents = onRoomEvent((event) => {
        if (isSyncEvent(event)) created.receive(event)
      })
      return () => {
        unsubscribeEvents()
        unsubscribePeers()
        created.stop()
        if (sync.current === created) sync.current = null
        if (bridgeRef.current === bridge) bridgeRef.current = null
      }
    },
    [peerId, send, company, peers, onRoomEvent]
  )

  // Once the room is live (again), ask for what was drawn meanwhile.
  useEffect(() => {
    if (status === 'live') sync.current?.want()
  }, [status])

  const changed = useCallback(() => sync.current?.changed(), [])

  const pointer = useCallback(
    (next: ScenePointer) => {
      if (!company()) return
      void send({ scene: next }, { throttleMs: SCENE_POINTER_INTERVAL_MS, lane: 'scene' })
    },
    [company, send]
  )

  const selection = useCallback(
    (ids: readonly string[]) => {
      const selected = ids.slice(0, SCENE_SELECTION_MAX)
      const key = selected.join(',')
      if (key === lastSelection.current || !company()) return
      lastSelection.current = key
      void send({ sceneSelection: selected }, { throttleMs: SCENE_SELECTION_INTERVAL_MS, lane: 'scene-sel' })
    },
    [company, send]
  )

  const collab = useMemo<SketchCollab>(
    () => ({ canWrite, attach, changed, pointer, selection }),
    [canWrite, attach, changed, pointer, selection]
  )

  /** This tab wrote a Fassung of the scene it shows now: tell the room. */
  const announceSave = useCallback(async (versionId: string) => {
    const bridge = bridgeRef.current
    const current = sync.current
    if (!bridge || !current) return false
    setPeerSave(null)
    return current.saved(versionId, sceneHashOf(bridge.helpers.hash, bridge.scene().elements))
  }, [])

  /** Merge a newer Fassung into the canvas and sit on it, after a save was refused as stale. */
  const mergeFrom = useCallback(
    (elements: readonly WireElement[], versionId: string | null) => sync.current?.mergeFrom(elements, versionId),
    []
  )

  /** The names of the other people here now, for the close guard. */
  const otherPeople = useCallback(
    () => [...new Set(peers.get().filter((state) => state.peer.kind === 'person').map((state) => state.peer.name))],
    [peers]
  )

  return {
    status,
    collab,
    peers,
    /** Elements too large to travel live; they reach the others with the next save. */
    tooLarge,
    /** The last save another tab announced. */
    peerSave,
    announceSave,
    mergeFrom,
    otherPeople,
    /** The Fassung this canvas's edits sit on now. */
    base: () => sync.current?.base() ?? settings.current.baseVersionId,
  }
}

export type SketchRoom = ReturnType<typeof useSketchRoom>
