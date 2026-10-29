/**
 * @vitest-environment node
 */
/**
 * Sending in a live channel: who a message is from is the session's word,
 * never the client's; sending is reading the document; a grant is remembered
 * only as long as a stream re-checks; and the channel's rate limit is spent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))

import { z } from 'zod'
import { BadRequestError, ForbiddenError, NotFoundError, TooManyRequestsError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from '@/lib/documents/access'
import { createInProcessStore, ROOM_CLAIM_LIMIT, ROOM_LIMIT, setLimitStore, SKETCH_EDIT_LIMIT, SKETCH_WANT_LIMIT } from '@/lib/limits'
import { __resetGrantsForTests, defineChannel, forgetSendGrant, type AnyChannel } from './channel'
import { __setHubTransportForTests, subscribe } from './hub'
import { CHANNELS } from './registry'
import { sendToChannel } from './send'
import { upstreamBaseSchema } from './types'

const SESSION = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'a@example.test',
  name: 'Anna Berger',
} as Partial<AuthorizedSession> as AuthorizedSession

function listen(topic: string) {
  const heard: unknown[] = []
  const release = subscribe(topic, (payload) => heard.push(payload))
  return { heard, release }
}

beforeEach(async () => {
  vi.clearAllMocks()
  __resetGrantsForTests()
  setLimitStore(createInProcessStore())
  await __setHubTransportForTests(null)
  vi.mocked(getAccessibleDocument).mockResolvedValue({} as never)
})

describe('sendToChannel, the document room', () => {
  it('stamps who said it from the session, and relays presence, pointer with its draft and chat, and view', async () => {
    const room = listen('rt:doc:doc_1')

    await sendToChannel(SESSION, {
      ch: 'doc:doc_1',
      msg: {
        peerId: 'peer_abcdef12',
        presence: 'here',
        cursor: { page: 2, x: 0.25, y: 0.5 },
        tool: 'region',
        draft: { x: 0.2, y: 0.4, w: 0.05, h: 0.1 },
        chat: '  Hier fehlt die Kote ',
        viewport: { page: 2, y: 0.4 },
      },
    })
    room.release()

    const peer = { peerId: 'peer_abcdef12', userId: 'user_1', name: 'Anna Berger', kind: 'person' }
    expect(room.heard).toEqual([
      { kind: 'presence', peer, state: 'here', ttlMs: 25_000 },
      {
        kind: 'cursor',
        peer,
        cursor: { page: 2, x: 0.25, y: 0.5 },
        tool: 'region',
        draft: { x: 0.2, y: 0.4, w: 0.05, h: 0.1 },
        chat: 'Hier fehlt die Kote',
      },
      { kind: 'viewport', peer, viewport: { page: 2, y: 0.4 } },
    ])
  })

  it('refuses a message that names who it is from, and a chat longer than a line', async () => {
    const forged = { peerId: 'peer_abcdef12', presence: 'here', userId: 'user_ceo', name: 'Chefin' }
    await expect(sendToChannel(SESSION, { ch: 'doc:doc_1', msg: forged })).rejects.toBeInstanceOf(BadRequestError)
    const long = { peerId: 'peer_abcdef12', cursor: null, chat: 'x'.repeat(141) }
    await expect(sendToChannel(SESSION, { ch: 'doc:doc_1', msg: long })).rejects.toBeInstanceOf(BadRequestError)
  })

  it('drops a draft when the pointer leaves the pages', async () => {
    const room = listen('rt:doc:doc_1')
    await sendToChannel(SESSION, {
      ch: 'doc:doc_1',
      msg: { peerId: 'peer_abcdef12', cursor: null, draft: { x: 0.2, y: 0.4, w: 0.05, h: 0.1 } },
    })
    room.release()
    expect(room.heard).toEqual([expect.objectContaining({ kind: 'cursor', cursor: null, draft: null })])
  })

  it('is refused, and relays nothing, for a reader who cannot read the document', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    const room = listen('rt:doc:doc_1')

    await expect(
      sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_abcdef12', presence: 'here' } })
    ).rejects.toBeInstanceOf(NotFoundError)
    room.release()
    expect(room.heard).toEqual([])
  })

  it('refuses a channel that does not exist or takes no messages', async () => {
    await expect(sendToChannel(SESSION, { ch: 'nope:x', msg: {} })).rejects.toBeInstanceOf(BadRequestError)
  })

  it('remembers a grant for the pointer stream, per person and per document, until it is forgotten', async () => {
    const say = (session: AuthorizedSession, ch: string) =>
      sendToChannel(session, { ch, msg: { peerId: 'peer_abcdef12', presence: 'here' } })
    await say(SESSION, 'doc:doc_1')
    await say(SESSION, 'doc:doc_1')
    expect(getAccessibleDocument).toHaveBeenCalledTimes(1)

    await say({ ...SESSION, userId: 'user_2' }, 'doc:doc_1')
    await say(SESSION, 'doc:doc_2')
    expect(getAccessibleDocument).toHaveBeenCalledTimes(3)

    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    forgetSendGrant(SESSION, 'doc:doc_1')
    await expect(say(SESSION, 'doc:doc_1')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('sendToChannel, the limit', () => {
  const tight = defineChannel({
    kind: 'test',
    parse: (id) => ({ id }),
    topics: ({ id }) => [`rt:test:${id}`],
    authorize: async () => {},
    reauthorizeMs: 30_000,
    events: z.object({ kind: z.string() }),
    presence: { ttlMs: 25_000, refreshMs: 10_000 },
    upstream: {
      schema: upstreamBaseSchema,
      limit: { name: 'test-channel', limit: 2, windowMs: 60_000 },
      handle: () => [],
    },
  }) as AnyChannel
  const channels = { ...CHANNELS, test: tight }

  it('spends the channel’s own limit per member and channel, and refuses past it', async () => {
    const say = (ch = 'test:a') =>
      sendToChannel(SESSION, { ch, msg: { peerId: 'peer_abcdef12', presence: 'here' } }, channels)
    await say()
    await say()
    await expect(say()).rejects.toBeInstanceOf(TooManyRequestsError)
    await expect(
      sendToChannel({ ...SESSION, userId: 'user_2' }, { ch: 'test:a', msg: { peerId: 'peer_abcdef12' } }, channels)
    ).resolves.toBeNull()
    // The same person in a second document (another tab) has a budget of its own.
    await expect(say('test:b')).resolves.toBeNull()
  })

  it('takes a claim from its own budget, so motion past its limit never refuses presence or the selection', async () => {
    const claiming = defineChannel({
      ...tight,
      kind: 'claiming',
      upstream: {
        ...tight.upstream!,
        limit: { name: 'test-motion', limit: 2, windowMs: 60_000 },
        lanes: [{ name: 'claim', limit: { name: 'test-claim', limit: 3, windowMs: 60_000 }, fields: ['selected'], presence: true }],
      },
    }) as AnyChannel
    const send = (msg: Record<string, unknown>) =>
      sendToChannel(SESSION, { ch: 'claiming:a', msg: { peerId: 'peer_abcdef12', ...msg } }, { claiming })
    await send({ cursor: 1 })
    await send({ cursor: 2 })
    await expect(send({ cursor: 3 })).rejects.toBeInstanceOf(TooManyRequestsError)

    await expect(send({ presence: 'here' })).resolves.toBeNull()
    await expect(send({ selected: null })).resolves.toBeNull()
    await expect(send({ presence: 'gone' })).resolves.toBeNull()
    // Claims are bounded too, by their own budget.
    await expect(send({ presence: 'here' })).rejects.toBeInstanceOf(TooManyRequestsError)
  })

  it('gives the document room’s presence and selection the claim budget, and a sketch’s edits their own', () => {
    expect(CHANNELS.doc.upstream?.limit).toBe(ROOM_LIMIT)
    const lanes = CHANNELS.doc.upstream?.lanes?.map(({ name, fields, presence, limit }) => ({ name, fields, presence, limit }))
    expect(lanes).toEqual([
      { name: 'sketch-edit', fields: ['delta', 'saved'], presence: undefined, limit: SKETCH_EDIT_LIMIT },
      { name: 'sketch-want', fields: ['want'], presence: undefined, limit: SKETCH_WANT_LIMIT },
      { name: 'claim', fields: ['selected'], presence: true, limit: ROOM_CLAIM_LIMIT },
    ])
  })
})

describe('sendToChannel, a sketch in the document room', () => {
  const element = { id: 'el_1', type: 'rectangle', version: 3, versionNonce: 7, isDeleted: false, index: 'a0', x: 10 }
  const delta = { base: 'ver_1', seq: 1, elements: [element] }
  const send = (msg: Record<string, unknown>, session = SESSION) =>
    sendToChannel(session, { ch: 'doc:doc_1', msg: { peerId: 'peer_abcdef12', ...msg } })
  /** A reader: may read the document, may not write it. */
  const reader = () =>
    vi.mocked(getAccessibleDocument).mockImplementation(async (_session, _id, intent) => {
      if (intent === 'write') throw new ForbiddenError()
      return {} as never
    })

  it('relays a writer’s delta with every field of its elements, and asks for write access once', async () => {
    const room = listen('rt:doc:doc_1')
    await send({ delta })
    await send({ delta: { ...delta, seq: 2 } })
    room.release()
    expect(room.heard[0]).toEqual({ kind: 'scene.delta', peer: expect.objectContaining({ userId: 'user_1' }), ...delta })
    expect(vi.mocked(getAccessibleDocument).mock.calls.map(([, , intent]) => intent)).toEqual(['read', 'write'])
  })

  it('refuses a reader’s delta and save, also behind a claim, and relays nothing', async () => {
    reader()
    const room = listen('rt:doc:doc_1')
    await expect(send({ delta })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(send({ saved: { versionId: 'ver_2', sceneHash: 1 } })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(send({ selected: null, delta })).rejects.toBeInstanceOf(ForbiddenError)
    room.release()
    expect(room.heard).toEqual([])
  })

  it('lets a reader point, select, say its hash and ask for the scene', async () => {
    reader()
    const room = listen('rt:doc:doc_1')
    await expect(send({ scene: { pointer: { x: 1, y: 2 }, tool: 'laser', button: 'down' } })).resolves.toBeNull()
    await expect(send({ sceneSelection: ['el_1'] })).resolves.toBeNull()
    await expect(send({ hash: { base: 'ver_1', sceneHash: 42, count: 3 } })).resolves.toBeNull()
    await expect(send({ want: { requestId: 'req_abcdef12', base: 'ver_1' } })).resolves.toBeNull()
    room.release()
    expect(room.heard.map((event) => (event as { kind: string }).kind)).toEqual([
      'scene.pointer',
      'scene.selection',
      'scene.hash',
      'scene.want',
    ])
  })

  it('keeps the edit grant apart from the channel’s, and forgets both together', async () => {
    await send({ scene: { pointer: null, tool: 'pointer', button: 'up' } })
    await send({ delta })
    await send({ delta })
    expect(getAccessibleDocument).toHaveBeenCalledTimes(2)
    forgetSendGrant(SESSION, 'doc:doc_1')
    await send({ delta })
    expect(getAccessibleDocument).toHaveBeenCalledTimes(4)
  })

  it('spends the edit budget for edits, so motion past its limit never refuses an edit', async () => {
    for (let i = 0; i < ROOM_LIMIT.limit; i++) await send({ hash: { base: null, sceneHash: i, count: 0 } })
    await expect(send({ hash: { base: null, sceneHash: 0, count: 0 } })).rejects.toBeInstanceOf(TooManyRequestsError)
    await expect(send({ delta })).resolves.toBeNull()
  })

  it('bounds a reader’s requests for the whole scene by their own small budget, alone or riding on a claim', async () => {
    reader()
    const want = (i: number) => ({ want: { requestId: `req_${String(i).padStart(8, '0')}`, base: null } })
    for (let i = 0; i < SKETCH_WANT_LIMIT.limit; i++) await send(i % 2 ? want(i) : { ...want(i), selected: null })
    await expect(send({ ...want(99), selected: null })).rejects.toBeInstanceOf(TooManyRequestsError)
    await expect(send(want(100))).rejects.toBeInstanceOf(TooManyRequestsError)
    // The reader still points and stays present.
    await expect(send({ scene: { pointer: null, tool: 'pointer', button: 'up' } })).resolves.toBeNull()
    await expect(send({ presence: 'here' })).resolves.toBeNull()
  })

  it('refuses an image, an element without its version, and a delta over its byte cap', async () => {
    const image = { ...element, type: 'image' }
    await expect(send({ delta: { ...delta, elements: [image] } })).rejects.toBeInstanceOf(BadRequestError)
    const { version: _version, ...unversioned } = element
    await expect(send({ delta: { ...delta, elements: [unversioned] } })).rejects.toBeInstanceOf(BadRequestError)
    const heavy = { ...element, points: Array.from({ length: 6_000 }, (_, i) => [i, i]) }
    await expect(send({ delta: { ...delta, elements: [heavy] } })).rejects.toBeInstanceOf(BadRequestError)
  })
})
