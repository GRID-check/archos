/**
 * @vitest-environment node
 */
/**
 * The document room on the server: who a message is from is the session's
 * word, never the client's; being in the room is reading the document; a grant
 * is remembered only as long as a stream re-checks; and a message reaches each
 * subscriber once, whether or not a cross-replica transport echoes it back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from '@/lib/documents/access'
import type { EventTransport } from '@/lib/events/bus'
import { __setRoomTransportForTests, publishToRoom, subscribeToRoom } from './room'
import { __resetRoomGrantsForTests, postToRoom, requireRoomAccess, stillInRoom } from './room-service'
import type { RoomEvent } from './room-types'

const SESSION = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'a@grid.test',
  name: 'Anna Berger',
} as Partial<AuthorizedSession> as AuthorizedSession

/** A cross-replica transport that echoes every publish back to its own subscribers, as Redis does. */
function echoingTransport(): EventTransport & { published: string[] } {
  const handlers = new Map<string, Set<(payload: string) => void>>()
  const published: string[] = []
  return {
    published,
    async publish(channel, payload) {
      published.push(payload)
      for (const handler of handlers.get(channel) ?? []) handler(payload)
    },
    async subscribe(channel, onMessage) {
      const set = handlers.get(channel) ?? new Set()
      set.add(onMessage)
      handlers.set(channel, set)
      return async () => {
        set.delete(onMessage)
      }
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetRoomGrantsForTests()
  __setRoomTransportForTests(null)
  vi.mocked(getAccessibleDocument).mockResolvedValue({} as never)
})

describe('postToRoom', () => {
  it("stamps who said it from the session, and relays presence, pointer and view to the room", async () => {
    const heard: RoomEvent[] = []
    const release = await subscribeToRoom('doc_1', (event) => heard.push(event))

    await postToRoom(SESSION, 'doc_1', {
      peerId: 'peer_abcdef12',
      presence: 'here',
      cursor: { page: 2, x: 0.25, y: 0.5 },
      tool: 'region',
      viewport: { page: 2, y: 0.4 },
    })
    await release()

    const peer = { peerId: 'peer_abcdef12', userId: 'user_1', name: 'Anna Berger', kind: 'person' }
    expect(heard).toEqual([
      { kind: 'presence', peer, state: 'here', ttlMs: 25_000 },
      { kind: 'cursor', peer, cursor: { page: 2, x: 0.25, y: 0.5 }, tool: 'region' },
      { kind: 'viewport', peer, viewport: { page: 2, y: 0.4 } },
    ])
  })

  it('is refused, and relays nothing, for a reader who cannot read the document', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    const heard: RoomEvent[] = []
    const release = await subscribeToRoom('doc_1', (event) => heard.push(event))

    await expect(postToRoom(SESSION, 'doc_1', { peerId: 'peer_abcdef12', presence: 'here' })).rejects.toBeInstanceOf(
      NotFoundError
    )
    await release()
    expect(heard).toEqual([])
  })
})

describe('room access', () => {
  it('remembers a grant for the pointer stream, and asks again for an open stream re-check', async () => {
    await requireRoomAccess(SESSION, 'doc_1')
    await requireRoomAccess(SESSION, 'doc_1')
    expect(getAccessibleDocument).toHaveBeenCalledTimes(1)

    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    await expect(stillInRoom(SESSION, 'doc_1')).resolves.toBe(false)
    await expect(requireRoomAccess(SESSION, 'doc_1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('keeps grants apart per person and per document', async () => {
    await requireRoomAccess(SESSION, 'doc_1')
    await requireRoomAccess({ ...SESSION, userId: 'user_2' }, 'doc_1')
    await requireRoomAccess(SESSION, 'doc_2')
    expect(getAccessibleDocument).toHaveBeenCalledTimes(3)
  })
})

describe('the transport', () => {
  it("delivers once on the publishing replica although the shared transport echoes it back", async () => {
    const transport = echoingTransport()
    __setRoomTransportForTests(transport)
    const heard: RoomEvent[] = []
    const release = await subscribeToRoom('doc_1', (event) => heard.push(event))

    const event: RoomEvent = {
      kind: 'presence',
      peer: { peerId: 'peer_abcdef12', userId: 'user_1', name: 'Anna', kind: 'person' },
      state: 'here',
      ttlMs: 25_000,
    }
    await publishToRoom('doc_1', event)

    expect(heard).toEqual([event])
    expect(transport.published).toHaveLength(1)
    await release()
  })

  it('delivers what another replica published, and only to its own document', async () => {
    const transport = echoingTransport()
    __setRoomTransportForTests(transport)
    const one: RoomEvent[] = []
    const two: RoomEvent[] = []
    const releaseOne = await subscribeToRoom('doc_1', (event) => one.push(event))
    const releaseTwo = await subscribeToRoom('doc_2', (event) => two.push(event))

    const event: RoomEvent = {
      kind: 'viewport',
      peer: { peerId: 'peer_other123', userId: 'user_9', name: 'Jakob', kind: 'person' },
      viewport: { page: 1, y: 0.2 },
    }
    await transport.publish('doc:doc_1:room', JSON.stringify({ origin: 'another-replica', event }))

    expect(one).toEqual([event])
    expect(two).toEqual([])
    await releaseOne()
    await releaseTwo()
  })

  it('drops a message that is not a room event rather than guess at it', async () => {
    const transport = echoingTransport()
    __setRoomTransportForTests(transport)
    const heard: RoomEvent[] = []
    const release = await subscribeToRoom('doc_1', (event) => heard.push(event))

    await transport.publish('doc:doc_1:room', JSON.stringify({ origin: 'x', event: { kind: 'cursor', peer: 'forged' } }))
    await transport.publish('doc:doc_1:room', 'not json')

    expect(heard).toEqual([])
    await release()
  })
})
