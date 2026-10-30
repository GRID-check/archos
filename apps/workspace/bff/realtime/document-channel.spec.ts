/**
 * @vitest-environment node
 */
/**
 * Piloti in the document room, and the server's snapshot of who is there:
 * Piloti is one peer per conversation, stamped by the server with the person
 * it acts for, and impossible for a browser to be or to name; and the snapshot holds what people last said about
 * their page, view, selection and draft, per organization, bounded and TTL'd.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))

import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from '@/lib/documents/access'
import { createInProcessStore, setLimitStore } from '@/lib/limits'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { __resetGrantsForTests } from './channel'
import { publishAsAgent, roomSnapshot } from './document-channel'
import { __setHubTransportForTests, subscribe } from './hub'
import {
  __setRosterBackendForTests,
  createInProcessRosterBackend,
  flushRoster,
  MAX_PEERS,
  noteRosterPeer,
  readRoster,
  rosterKey,
} from './roster'
import { sendToChannel } from './send'

const SESSION = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'a@example.test',
  name: 'Anna Berger',
} as Partial<AuthorizedSession> as AuthorizedSession

const AGENT = { conversationId: 'conv_42', onBehalfOf: 'user_1' }
const AGENT_PEER = { peerId: 'piloti-conv_42', userId: 'user_1', name: 'Piloti', kind: 'piloti', forName: 'Anna Berger' }
const DIRECTORY = new Map([['user_1', { userId: 'user_1', email: 'a@example.test', name: 'Anna Berger', profilePictureUrl: null }]])

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useRealTimers()
  __resetGrantsForTests()
  setLimitStore(createInProcessStore())
  await __setHubTransportForTests(null)
  __setRosterBackendForTests(createInProcessRosterBackend())
  vi.mocked(getAccessibleDocument).mockResolvedValue({} as never)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(DIRECTORY)
})

const listen = () => {
  const heard: unknown[] = []
  const release = subscribe('rt:doc:doc_1', (payload) => heard.push(payload))
  return { heard, release }
}

describe('publishAsAgent', () => {
  it('speaks as Piloti, one peer per conversation, in each of its ops', async () => {
    const room = listen()
    const box = { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.1 }

    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'presence', state: 'here' })
    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'cursor', cursor: { page: 2, x: 0.4, y: 0.5 }, label: ' Treppe ' })
    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'activity', label: 'sieht sich Seite 2 an' })
    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'highlight', box, label: 'Laufbreite' })
    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'presence', state: 'gone' })
    room.release()

    expect(room.heard).toEqual([
      { kind: 'presence', peer: AGENT_PEER, state: 'here', ttlMs: 25_000 },
      { kind: 'cursor', peer: AGENT_PEER, cursor: { page: 2, x: 0.4, y: 0.5 }, tool: 'select', label: 'Treppe' },
      { kind: 'activity', peer: AGENT_PEER, state: 'reading', label: 'sieht sich Seite 2 an' },
      { kind: 'highlight', peer: AGENT_PEER, box, label: 'Laufbreite', ttlMs: 6_000 },
      { kind: 'presence', peer: AGENT_PEER, state: 'gone', ttlMs: 25_000 },
    ])
  })

  it('names the person it acts for, from that organization’s directory', async () => {
    const room = listen()
    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'presence', state: 'here' })
    room.release()
    expect(loadOrganizationDirectory).toHaveBeenCalledWith('org_1')
    expect(room.heard).toEqual([expect.objectContaining({ peer: expect.objectContaining({ forName: 'Anna Berger' }) })])
  })

  it('still acts when the name cannot be read, without one', async () => {
    const room = listen()
    vi.mocked(loadOrganizationDirectory).mockRejectedValueOnce(new Error('WorkOS down'))
    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'presence', state: 'here' })
    vi.mocked(loadOrganizationDirectory).mockResolvedValueOnce(new Map())
    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'presence', state: 'gone' })
    room.release()
    const { forName: _, ...nameless } = AGENT_PEER
    expect(room.heard).toEqual([
      { kind: 'presence', peer: nameless, state: 'here', ttlMs: 25_000 },
      { kind: 'presence', peer: nameless, state: 'gone', ttlMs: 25_000 },
    ])
  })

  it('refuses a box off the page rather than draw it', async () => {
    await expect(
      publishAsAgent('doc_1', 'org_1', AGENT, { op: 'highlight', box: { page: 1, x: 0.9, y: 0, w: 2, h: 0.1 } })
    ).rejects.toThrow()
  })
})

describe('a browser cannot be Piloti', () => {
  it('is stamped a person whatever it sends, names nobody it acts for, and cannot send Piloti’s vocabulary', async () => {
    const room = listen()
    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'piloti-conv_42', presence: 'here' } })
    room.release()
    expect(room.heard).toEqual([
      expect.objectContaining({ peer: { peerId: 'piloti-conv_42', userId: 'user_1', name: 'Anna Berger', kind: 'person' } }),
    ])

    for (const forged of [
      { peerId: 'peer_abcdef12', kind: 'piloti' },
      { peerId: 'peer_abcdef12', name: 'Piloti' },
      { peerId: 'peer_abcdef12', cursor: { page: 1, x: 0.1, y: 0.1 }, label: 'Piloti' },
      { peerId: 'peer_abcdef12', highlight: { page: 1, x: 0, y: 0, w: 0.1, h: 0.1 } },
      { peerId: 'peer_abcdef12', presence: 'here', forName: 'Ben Huber' },
      { peerId: 'peer_abcdef12', peer: { kind: 'piloti', forName: 'Ben Huber' } },
    ]) {
      await expect(sendToChannel(SESSION, { ch: 'doc:doc_1', msg: forged })).rejects.toBeInstanceOf(BadRequestError)
    }
  })
})

describe('roomSnapshot', () => {
  it('holds each peer’s page, view, selection and draft, as the room last heard them', async () => {
    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_anna_001', presence: 'here' } })
    await sendToChannel(SESSION, {
      ch: 'doc:doc_1',
      msg: { peerId: 'peer_anna_001', cursor: { page: 3, x: 0.5, y: 0.5 }, draft: { x: 0.4, y: 0.4, w: 0.1, h: 0.2 } },
    })
    await sendToChannel(SESSION, {
      ch: 'doc:doc_1',
      msg: { peerId: 'peer_anna_001', viewport: { page: 3, y: 0.4 }, selected: 'ann_7' },
    })
    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'presence', state: 'here' })

    const snapshot = await roomSnapshot('doc_1', 'org_1')
    expect(snapshot).toEqual([
      {
        peerId: 'peer_anna_001',
        userId: 'user_1',
        name: 'Anna Berger',
        kind: 'person',
        page: 3,
        viewport: { page: 3, y: 0.4 },
        selected: 'ann_7',
        draft: { page: 3, x: 0.4, y: 0.4, w: 0.1, h: 0.2 },
        expiresAt: expect.any(String),
      },
      expect.objectContaining({ peerId: 'piloti-conv_42', kind: 'piloti', forName: 'Anna Berger', page: null, selected: null }),
    ])

    // A selection alone changes only the selection.
    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_anna_001', selected: null } })
    expect((await roomSnapshot('doc_1', 'org_1'))[0]).toMatchObject({ selected: null, viewport: { page: 3, y: 0.4 } })
  })

  it('lists a person once however many tabs they are in, as the tab heard last (C5)', async () => {
    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_anna_001', presence: 'here' } })
    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_anna_002', presence: 'here' } })
    await publishAsAgent('doc_1', 'org_1', AGENT, { op: 'presence', state: 'here' })
    const snapshot = await roomSnapshot('doc_1', 'org_1')
    expect(snapshot.filter((peer) => peer.kind === 'person').map((peer) => peer.userId)).toEqual(['user_1'])
    expect(snapshot.filter((peer) => peer.kind !== 'person')).toHaveLength(1)
  })

  // The coherence review's finding 9: the tab heard last may be an idle preview beside the editor the person acts in.
  it('of a person in two tabs, keeps the one they act in, not the idle one heard last', async () => {
    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_anna_001', viewport: { page: 1, y: 0.2 }, selected: 'ann_7' } })
    // The idle tab is heard a second later, so its claim runs longest.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 1_000)
    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_anna_002', presence: 'here' } })
    const people = (await roomSnapshot('doc_1', 'org_1')).filter((peer) => peer.kind === 'person')
    vi.useRealTimers()
    expect(people).toEqual([expect.objectContaining({ peerId: 'peer_anna_001', selected: 'ann_7' })])
  })

  it('lets a peer go when they leave, and keeps organizations apart', async () => {
    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_anna_001', presence: 'here' } })
    expect(await roomSnapshot('doc_1', 'org_2')).toEqual([])

    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_anna_001', presence: 'gone' } })
    expect(await roomSnapshot('doc_1', 'org_1')).toEqual([])
  })

  it('drops a peer whose claim ran out', async () => {
    await sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_anna_001', presence: 'here' } })
    await flushRoster()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 26_000)
    expect(await roomSnapshot('doc_1', 'org_1')).toEqual([])
    vi.useRealTimers()
  })

  it('records at most MAX_PEERS peers', async () => {
    const key = rosterKey('org_1', 'doc:doc_1')
    for (let index = 0; index < MAX_PEERS + 5; index += 1) {
      noteRosterPeer(key, { peerId: `peer_${String(index).padStart(6, '0')}`, userId: `u${index}`, name: 'N', kind: 'person' }, 25_000)
    }
    expect(await roomSnapshot('doc_1', 'org_1')).toHaveLength(MAX_PEERS)
  })
})

describe('a sketch in the room’s snapshot', () => {
  const say = (msg: Record<string, unknown>, peerId = 'peer_abcdef12') =>
    sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId, ...msg } })

  it('keeps a canvas pointer’s peer in the snapshot, and nobody for an edit, a hash, a request or a save', async () => {
    await say({ scene: { pointer: { x: 4, y: 5 }, tool: 'pointer', button: 'up' } }, 'peer_pointing1')
    await say({ sceneSelection: ['el_1'] }, 'peer_selecting')
    const element = { id: 'el_1', type: 'ellipse', version: 2, versionNonce: 1, isDeleted: false, index: 'a0' }
    await say({ delta: { base: 'ver_1', seq: 1, elements: [element] } }, 'peer_drawing01')
    await say({ hash: { base: 'ver_1', sceneHash: 9, count: 1 } }, 'peer_hashing01')
    await say({ want: { requestId: 'req_abcdef12', base: 'ver_1' } }, 'peer_wanting01')
    await say({ saved: { versionId: 'ver_2', sceneHash: 9 } }, 'peer_saving001')

    // The roster holds the two that spoke a fact; the snapshot shows the one person they both are.
    await flushRoster()
    const roster = await readRoster(rosterKey('org_1', 'doc:doc_1'))
    expect(roster.map((entry) => entry.peer.peerId).sort()).toEqual(['peer_pointing1', 'peer_selecting'])
    const snapshot = await roomSnapshot('doc_1', 'org_1')
    expect(snapshot).toHaveLength(1)
    expect(['peer_pointing1', 'peer_selecting']).toContain(snapshot[0].peerId)
  })
})
