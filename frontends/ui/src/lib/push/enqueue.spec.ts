/**
 * @vitest-environment node
 */
import { generateVAPIDKeys } from 'web-push'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn(async () => ({ jobId: 'j' })) }))
vi.mock('./repository', () => ({ userIdsWithSubscription: vi.fn() }))

import type { InboxItem } from '@/lib/db/schema'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BURST_HOLD_MS, enqueueInboxPushes } from './enqueue'
import { userIdsWithSubscription } from './repository'

const keys = generateVAPIDKeys()
const NOW = new Date('2026-10-15T10:00:00.000Z')

function row(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'i1',
    organizationId: 'org_1',
    recipientUserId: 'u1',
    type: 'mention.requested',
    count: 1,
    updatedAt: NOW,
    readAt: null,
    archivedAt: null,
    resolvedAt: null,
    inertAt: null,
    ...overrides,
  } as InboxItem
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('WEB_PUSH_VAPID_PUBLIC_KEY', keys.publicKey)
  vi.stubEnv('WEB_PUSH_VAPID_PRIVATE_KEY', keys.privateKey)
  vi.stubEnv('WEB_PUSH_SUBJECT', 'mailto:ops@example.org')
  vi.mocked(userIdsWithSubscription).mockResolvedValue(new Set(['u1']))
})

describe('queueing a push at the inbox write path', () => {
  it('queues one interactive job per recipient who holds a device, carrying ids and a stamp only', async () => {
    vi.mocked(userIdsWithSubscription).mockResolvedValue(new Set(['u1']))
    const queued = await enqueueInboxPushes([row(), row({ id: 'i2', recipientUserId: 'u2' })], NOW)
    expect(queued).toBe(1)
    expect(enqueueJob).toHaveBeenCalledWith({
      kind: 'inbox_push',
      organizationId: 'org_1',
      priority: 0,
      payload: { itemId: 'i1', recipientUserId: 'u1', stamp: NOW.toISOString() },
    })
  })

  it('holds a job for a row folded into an unread group, so a burst sends its last occurrence', async () => {
    await enqueueInboxPushes([row({ count: 4 })], NOW)
    expect(vi.mocked(enqueueJob).mock.calls[0][0].notBefore).toEqual(new Date(NOW.getTime() + BURST_HOLD_MS))
  })

  it('holds even the first row of a type that folds across rows, so its burst is there before anything is told', async () => {
    await enqueueInboxPushes([row({ type: 'annotation.assigned_to_you', count: 1 })], NOW)
    expect(vi.mocked(enqueueJob).mock.calls[0][0].notBefore).toEqual(new Date(NOW.getTime() + BURST_HOLD_MS))
  })

  it('queues nothing in a deployment without keys, and does not even look for devices', async () => {
    vi.stubEnv('WEB_PUSH_VAPID_PUBLIC_KEY', '')
    vi.stubEnv('WEB_PUSH_VAPID_PRIVATE_KEY', '')
    vi.stubEnv('WEB_PUSH_SUBJECT', '')
    expect(await enqueueInboxPushes([row()], NOW)).toBe(0)
    expect(userIdsWithSubscription).not.toHaveBeenCalled()
  })

  it('skips rows that are already read or of a type this build does not know', async () => {
    expect(await enqueueInboxPushes([row({ readAt: NOW }), row({ type: 'from.the.future' as never })], NOW)).toBe(0)
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('never throws: a queue that is down costs a notification, not the inbox write', async () => {
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error('queue down'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(enqueueInboxPushes([row()], NOW)).resolves.toBe(0)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
