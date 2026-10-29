/**
 * Who else is on a Skizze, as Excalidraw draws them: the document room's
 * peers (`features/documents/hooks/use-document-room.ts`) turned into
 * Excalidraw's `collaborators` map, so its own pointers, name tags, selection
 * outlines and user list show the room.
 *
 * Each person keeps the colour they have everywhere else (`identityInk`): the
 * same hue as their avatar, their pointer on a PDF, their marks. Piloti is a
 * collaborator too while it works on the document, named with the person it
 * acts for (ADR-0105). A peer that is in the room but on no canvas (reading
 * the document's preview) is listed without a pointer.
 *
 * Pure, and typed against the slice of Excalidraw's `Collaborator` it fills,
 * so this module never imports Excalidraw (`sketch-isolation.spec.ts`).
 */

import { identityInk } from '@/components/ui/avatar-identity'
import type { RealtimePeer } from '@/lib/realtime/types'
import type { ScenePointer } from '@/lib/diagrams/sketch-room-types'

/** What this module reads of a room peer (`RoomPeerState` in `features/documents/hooks/use-document-room.ts`). */
export interface SketchPeerState {
  peer: RealtimePeer
  /** Their pointer on a canvas; null when on none. */
  scene: ScenePointer | null
  sceneSelection: readonly string[]
}

/** The fields of Excalidraw's `Collaborator` the room fills. */
export interface SketchCollaborator {
  id: string
  socketId: string
  username: string
  color: { background: string; stroke: string }
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' }
  button?: 'up' | 'down'
  selectedElementIds?: Record<string, true>
  isCurrentUser: false
}

export interface CollaboratorOptions {
  /** What a peer is called on the canvas; the caller's copy names Piloti with the person it acts for. */
  nameOf?: (peer: RealtimePeer) => string
}

const selectedOf = (ids: readonly string[]): Record<string, true> =>
  Object.fromEntries(ids.map((id) => [id, true as const]))

/** One peer as Excalidraw draws them. */
export function collaboratorOf(state: SketchPeerState, { nameOf }: CollaboratorOptions = {}): SketchCollaborator {
  const ink = identityInk(state.peer.userId)
  const { scene } = state
  return {
    id: state.peer.userId,
    socketId: state.peer.peerId,
    username: nameOf?.(state.peer) ?? state.peer.name,
    color: { background: ink, stroke: ink },
    ...(scene?.pointer ? { pointer: { ...scene.pointer, tool: scene.tool }, button: scene.button } : {}),
    ...(state.sceneSelection.length > 0 ? { selectedElementIds: selectedOf(state.sceneSelection) } : {}),
    isCurrentUser: false,
  }
}

/** The room's peers, keyed by tab (Excalidraw's `SocketId`): one person in two tabs is two pointers. */
export function collaboratorsOf(
  peers: readonly SketchPeerState[],
  options: CollaboratorOptions = {}
): Map<string, SketchCollaborator> {
  return new Map(peers.map((state) => [state.peer.peerId, collaboratorOf(state, options)]))
}
