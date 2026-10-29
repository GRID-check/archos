/**
 * @vitest-environment node
 */
/** The room's peers as Excalidraw's collaborators: one per tab, in the person's own colour, pointing where they point. */

import { describe, expect, it } from 'vitest'
import { identityInk } from '@/components/ui/avatar-identity'
import type { RoomPeerState } from '@/features/documents/hooks/use-document-room'
import { collaboratorsOf } from './sketch-collaborators'

const state = (overrides: Partial<RoomPeerState> & Pick<RoomPeerState, 'peer'>): RoomPeerState => ({
  cursor: null,
  movedAt: null,
  tool: 'select',
  viewport: null,
  draft: null,
  chat: null,
  label: null,
  selected: null,
  activity: null,
  highlight: null,
  scene: null,
  sceneSelection: [],
  expiresAt: 0,
  ...overrides,
})

const ANNA = { peerId: 'tab-anna-1', userId: 'user_anna', name: 'Anna Berger', kind: 'person' as const }
/** The agent, as the server stamps it: a peer of its own, named with the person it acts for. Its kind does not change the name. */
const AGENT = { peerId: 'agent-conv-1', userId: 'user_anna', name: 'Agent', kind: 'person' as const, forName: 'Anna Berger' }

describe('collaboratorsOf', () => {
  it('keys each tab, colours it as the person, and carries pointer, button and selection', () => {
    const peers = [
      state({ peer: ANNA, scene: { pointer: { x: 12, y: -4 }, tool: 'laser', button: 'down' }, sceneSelection: ['el_1', 'el_2'] }),
      state({ peer: { ...ANNA, peerId: 'tab-anna-2' } }),
    ]
    const collaborators = collaboratorsOf(peers)
    expect([...collaborators.keys()]).toEqual(['tab-anna-1', 'tab-anna-2'])
    expect(collaborators.get('tab-anna-1')).toEqual({
      id: 'user_anna',
      socketId: 'tab-anna-1',
      username: 'Anna Berger',
      color: { background: identityInk('user_anna'), stroke: identityInk('user_anna') },
      pointer: { x: 12, y: -4, tool: 'laser' },
      button: 'down',
      selectedElementIds: { el_1: true, el_2: true },
      isCurrentUser: false,
    })
    // In the room, on no canvas: listed, but with nothing to draw.
    expect(collaborators.get('tab-anna-2')).not.toHaveProperty('pointer')
    expect(collaborators.get('tab-anna-2')).not.toHaveProperty('selectedElementIds')
  })

  it('names a peer with the caller’s copy: the agent with the person it acts for', () => {
    const collaborators = collaboratorsOf([state({ peer: AGENT })], {
      nameOf: (peer) => (peer.forName ? `${peer.name} · für ${peer.forName}` : peer.name),
    })
    expect(collaborators.get('agent-conv-1')?.username).toBe('Agent · für Anna Berger')
  })
})
