/**
 * The header a browser tab names itself in when it writes an Anmerkung, so the
 * room's `annotations.changed` can say which tab did it and that tab need not
 * re-read what it already holds. A hint, never an identity: who wrote is the
 * session's user, always.
 */
export const ROOM_PEER_HEADER = 'x-grid-room-peer'

/** The tab id from a request, when it is a plausible one. */
export function roomPeerOf(request: Request): string | null {
  const value = request.headers.get(ROOM_PEER_HEADER)
  return value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null
}
