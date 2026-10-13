/**
 * The document room for a session: may it be in the room, and what it says
 * there (`./room-types`, `./room`).
 *
 * Being in the room is reading the document: `getAccessibleDocument(read)`,
 * so a held upload, a restricted folder and a document of another tenant have
 * no room for this reader, by the same rule that hides the document. A pointer
 * arrives up to twelve times a second, and resolving folder access for each one
 * would cost more than the pointer is worth, so a grant is remembered for
 * {@link ROOM_REAUTHORIZE_MS}, the same interval the live stream re-checks on.
 * A revoked reader can therefore keep sending a pointer for at most that long,
 * to a room whose stream already closed on them.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from '@/lib/documents/access'
import { publishToRoom, ROOM_REAUTHORIZE_MS } from './room'
import { PRESENCE_TTL_MS, type RoomPeer, type RoomPost } from './room-types'

const grants = new Map<string, number>()
const MAX_GRANTS = 5_000

const grantKey = (session: AuthorizedSession, documentId: string) =>
  `${session.organizationId}:${session.userId}:${documentId}`

/** Throws as `getAccessibleDocument` does when the session may not read the document. */
export async function requireRoomAccess(session: AuthorizedSession, documentId: string): Promise<void> {
  const key = grantKey(session, documentId)
  const until = grants.get(key)
  if (until && until > Date.now()) return
  await getAccessibleDocument(session, documentId, 'read')
  if (grants.size >= MAX_GRANTS) grants.clear()
  grants.set(key, Date.now() + ROOM_REAUTHORIZE_MS)
}

/** Whether the session may still read the document, for an open stream's re-check. Never cached. */
export async function stillInRoom(session: AuthorizedSession, documentId: string): Promise<boolean> {
  grants.delete(grantKey(session, documentId))
  try {
    await getAccessibleDocument(session, documentId, 'read')
    return true
  } catch {
    return false
  }
}

/** Who the session is in the room: the server's word for it, never the client's. */
export function selfInRoom(session: AuthorizedSession): Omit<RoomPeer, 'peerId'> {
  return { userId: session.userId, name: session.name ?? session.email, kind: 'person' }
}

/** Relay what a viewer says to everyone else in the room. */
export async function postToRoom(session: AuthorizedSession, documentId: string, post: RoomPost): Promise<null> {
  await requireRoomAccess(session, documentId)
  const peer: RoomPeer = { ...selfInRoom(session), peerId: post.peerId }
  const sends: Promise<void>[] = []
  if (post.presence) {
    sends.push(publishToRoom(documentId, { kind: 'presence', peer, state: post.presence, ttlMs: PRESENCE_TTL_MS }))
  }
  if (post.cursor !== undefined) {
    sends.push(publishToRoom(documentId, { kind: 'cursor', peer, cursor: post.cursor, tool: post.tool }))
  }
  if (post.viewport) sends.push(publishToRoom(documentId, { kind: 'viewport', peer, viewport: post.viewport }))
  await Promise.all(sends)
  return null
}

/** Clear the remembered grants: for tests. */
export function __resetRoomGrantsForTests(): void {
  grants.clear()
}
