/**
 * @vitest-environment node
 */
/**
 * The inbox row a reading leaves its requester (`piloti.intake_ready`). The
 * setup page tells a person they may leave; this is the half of that promise
 * the server keeps. A fold merges payloads, so every field a wording reads is
 * written on every emission, empty when there is nothing to say.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbox/best-effort', () => ({
  bestEffortInbox: async (_label: string, _org: string, write: () => Promise<unknown>) => {
    await write()
  },
}))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(async () => []),
  resolveInboxItemsAnchoredOn: vi.fn(async () => 0),
}))

import { emitInboxItems } from '@/lib/inbox/service'
import { onIntakeReady } from './attention'

const BASE = {
  organizationId: 'org_1',
  projectId: 'project-1',
  intakeId: 'intake-1',
  recipientUserId: 'user_2',
  projectName: 'Wohnbau Seestraße',
}

const emitted = () => vi.mocked(emitInboxItems).mock.calls[0][0][0]

beforeEach(() => vi.clearAllMocks())

describe('onIntakeReady', () => {
  it('tells the requester a finished reading is ready, with its decisive questions and summary', async () => {
    await onIntakeReady({ ...BASE, outcome: 'ready', decisiveOpen: 3, summary: '23 Dokumente   gelesen.' })

    expect(emitted()).toMatchObject({
      recipientUserId: 'user_2',
      type: 'piloti.intake_ready',
      resourceId: 'project-1',
      anchorId: 'intake-1',
      payload: { subject: 'Wohnbau Seestraße', variant: 'ready', related: '3', excerpt: '23 Dokumente gelesen.' },
    })
  })

  it('words a failed reading as failed, and clears what an earlier emission said', async () => {
    await onIntakeReady({ ...BASE, outcome: 'failed', decisiveOpen: 4, summary: null })

    expect(emitted().payload).toEqual({ subject: 'Wohnbau Seestraße', variant: 'failed', related: '', excerpt: '' })
  })

  it('clears the count of Rückfragen when a later reading leaves none', async () => {
    await onIntakeReady({ ...BASE, outcome: 'ready', decisiveOpen: 0, summary: null })
    expect(emitted().payload).toMatchObject({ variant: 'ready', related: '', excerpt: '' })
  })
})
