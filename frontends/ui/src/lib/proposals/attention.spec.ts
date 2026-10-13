/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(),
  resolveInboxItemsAnchoredOn: vi.fn(),
}))
vi.mock('@/lib/db/tenant-context', () => ({
  getTenantContext: vi.fn(),
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
}))

import { getTenantContext } from '@/lib/db/tenant-context'
import type { InboxEmission } from '@/lib/inbox/service'
import { emitInboxItems, resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import { onProposalCreated, onProposalDecided } from './attention'

const created = {
  organizationId: 'org_1',
  projectId: 'proj_1',
  proposalId: 'prop_1',
  originConversationId: 'conv_1',
  onBehalfOf: 'user_me',
  summary: '3 Dateien in „Pläne“ verschieben',
}

function emitted(): InboxEmission {
  expect(emitInboxItems).toHaveBeenCalledTimes(1)
  const [emissions] = vi.mocked(emitInboxItems).mock.calls[0]
  expect(emissions).toHaveLength(1)
  return emissions[0]
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getTenantContext).mockReturnValue({ kind: 'tenant', organizationId: 'org_1', userId: 'user_me' })
  vi.mocked(emitInboxItems).mockResolvedValue(1)
  vi.mocked(resolveInboxItemsAnchoredOn).mockResolvedValue(1)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('onProposalCreated', () => {
  it('waits on the person it was made for, at the chat that shows the card', async () => {
    await onProposalCreated(created)

    expect(emitted()).toMatchObject({
      organizationId: 'org_1',
      recipientUserId: 'user_me',
      type: 'piloti.proposal_waiting',
      resourceType: 'conversation',
      resourceId: 'conv_1',
      anchorId: 'prop_1',
      groupKey: 'piloti.proposal_waiting:conversation:conv_1:prop_1',
      payload: { excerpt: '3 Dateien in „Pläne“ verschieben' },
    })
  })

  it('points at the project when the proposal was made outside a chat', async () => {
    await onProposalCreated({ ...created, originConversationId: null })

    expect(emitted()).toMatchObject({
      resourceType: 'project',
      resourceId: 'proj_1',
      anchorId: 'prop_1',
      groupKey: 'piloti.proposal_waiting:project:proj_1:prop_1',
    })
  })

  it('carries no actor, so the person it was made for is told, not dropped as the actor', async () => {
    await onProposalCreated(created)

    expect(emitted().actorUserId).toBeNull()
  })

  it('keys two proposals in one chat apart', async () => {
    await onProposalCreated(created)
    await onProposalCreated({ ...created, proposalId: 'prop_2' })

    const keys = vi.mocked(emitInboxItems).mock.calls.map(([emissions]) => emissions[0].groupKey)
    expect(new Set(keys).size).toBe(2)
  })

  it('keeps the summary to one line and bounds it', async () => {
    await onProposalCreated({ ...created, summary: `Zeile eins\n   Zeile zwei ${'x'.repeat(400)}` })

    const excerpt = emitted().payload?.excerpt as string
    expect(excerpt.startsWith('Zeile eins Zeile zwei')).toBe(true)
    expect(excerpt.length).toBeLessThanOrEqual(200)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('omits the excerpt for a blank summary', async () => {
    await onProposalCreated({ ...created, summary: '  ' })

    expect(emitted().payload).toEqual({})
  })

  it('never throws into the write that stored the proposal', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('database down'))

    await expect(onProposalCreated(created)).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })
})

describe('onProposalDecided', () => {
  it('resolves the item of everyone it waited on', async () => {
    await onProposalDecided({ organizationId: 'org_1', proposalId: 'prop_1' })

    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['piloti.proposal_waiting'],
      anchorId: 'prop_1',
    })
  })

  it('never throws into the decision', async () => {
    vi.mocked(resolveInboxItemsAnchoredOn).mockRejectedValue(new Error('database down'))

    await expect(onProposalDecided({ organizationId: 'org_1', proposalId: 'prop_1' })).resolves.toBeUndefined()
  })
})
