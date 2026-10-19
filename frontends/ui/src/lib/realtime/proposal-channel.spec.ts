/**
 * @vitest-environment node
 */
/**
 * A proposal as a live channel (`proposal:<id>`): who may be in it (whoever may
 * read the proposal, by the service's own rule), what travels on it (one hint,
 * from the server), and that a decision published by the service reaches a
 * listener of the channel's topic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/proposals/service', () => ({ requireReadableProposal: vi.fn() }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { proposalChannelKey, proposalEventSchema, proposalTopic } from '@/lib/proposals/live-events'
import { publishProposalDecided } from '@/lib/proposals/live'
import { requireReadableProposal } from '@/lib/proposals/service'
import { __setHubTransportForTests, subscribe } from './hub'
import { proposalChannel } from './proposal-channel'
import { CHANNELS, resolveChannel } from './registry'

const SESSION = { userId: 'user_1', organizationId: 'org_1' } as Partial<AuthorizedSession> as AuthorizedSession
const ID = '0b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c'

beforeEach(async () => {
  vi.clearAllMocks()
  await __setHubTransportForTests(null)
})

describe('the proposal channel', () => {
  it('is registered, and a card’s key resolves to it', () => {
    expect(CHANNELS.proposal).toBe(proposalChannel)
    expect(resolveChannel(proposalChannelKey(ID))).toMatchObject({ params: { proposalId: ID } })
  })

  it('refuses a key that is not an id', () => {
    expect(proposalChannel.parse('has space')).toBeNull()
    expect(proposalChannel.parse('')).toBeNull()
    expect(proposalChannel.parse('x'.repeat(129))).toBeNull()
  })

  it('lets a reader in exactly when the service lets them read the proposal', async () => {
    vi.mocked(requireReadableProposal).mockResolvedValueOnce({} as never)
    await expect(proposalChannel.authorize(SESSION, { proposalId: ID })).resolves.toBeUndefined()
    expect(requireReadableProposal).toHaveBeenCalledWith(SESSION, ID)

    vi.mocked(requireReadableProposal).mockRejectedValueOnce(new NotFoundError())
    await expect(proposalChannel.authorize(SESSION, { proposalId: ID })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('takes nothing from a browser', () => {
    expect(proposalChannel.upstream).toBeUndefined()
  })

  it('re-checks an open stream, so a withdrawn grant ends it', () => {
    expect(proposalChannel.reauthorizeMs).toBeGreaterThan(0)
    expect(proposalChannel.reauthorizeMs).toBeLessThanOrEqual(60_000)
  })
})

describe('publishProposalDecided', () => {
  it('reaches a listener of the channel’s topic with an event the channel accepts', async () => {
    const heard: unknown[] = []
    const release = subscribe(proposalChannel.topics({ proposalId: ID }, 'org_1')[0], (payload) => heard.push(payload))

    await publishProposalDecided(ID, 'partially_applied')
    release()

    expect(heard).toEqual([{ kind: 'proposal.decided', proposalId: ID, status: 'partially_applied' }])
    expect(proposalChannel.events.safeParse(heard[0]).success).toBe(true)
    expect(proposalTopic(ID)).toBe(`rt:proposal:${ID}`)
  })

  it('does not publish a status that is not a decision', async () => {
    await expect(publishProposalDecided(ID, 'proposed' as never)).rejects.toThrow()
  })
})

describe('proposalEventSchema', () => {
  it('drops a hint that is not a decision', () => {
    expect(proposalEventSchema.safeParse({ kind: 'proposal.decided', proposalId: ID, status: 'proposed' }).success).toBe(false)
    expect(proposalEventSchema.safeParse({ kind: 'other', proposalId: ID, status: 'applied' }).success).toBe(false)
  })
})
