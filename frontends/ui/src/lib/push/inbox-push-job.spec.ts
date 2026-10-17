/**
 * @vitest-environment node
 */
import { generateVAPIDKeys } from 'web-push'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({
  resolvePinnedRequesterSession: vi.fn(async () => null),
  resolvePinnedRequesterSessionStrict: vi.fn(),
}))
vi.mock('@/lib/inbox/repository', () => ({ findInboxItemForRecipient: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ viewInboxItemAs: vi.fn() }))
vi.mock('@/lib/user-preferences/repository', () => ({ findUserPreferences: vi.fn() }))
vi.mock('./repository', () => ({
  deleteAllSubscriptionsOf: vi.fn(),
  deleteSubscriptionById: vi.fn(),
  listSubscriptions: vi.fn(),
  recordDelivered: vi.fn(),
  recordFailure: vi.fn(),
}))

import { resolvePinnedRequesterSessionStrict } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { InboxItem } from '@/lib/db/schema'
import { findInboxItemForRecipient } from '@/lib/inbox/repository'
import { viewInboxItemAs } from '@/lib/inbox/service'
import type { InboxItemView } from '@/lib/inbox/types'
import { findUserPreferences } from '@/lib/user-preferences/repository'
import { MAX_CONSECUTIVE_FAILURES, runInboxPush } from './inbox-push-job'
import {
  deleteAllSubscriptionsOf,
  deleteSubscriptionById,
  listSubscriptions,
  recordDelivered,
  recordFailure,
} from './repository'
import type { PushSender, PushSendOptions, PushSendOutcome, PushTarget } from './sender'

const keys = generateVAPIDKeys()
const ORG = 'org_1'
const UPDATED = new Date('2026-10-15T10:00:00.000Z')
const payload = { itemId: 'i1', recipientUserId: 'u1', stamp: UPDATED.toISOString() }
const first = { last: false }
const last = { last: true }

function row(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'i1',
    organizationId: ORG,
    recipientUserId: 'u1',
    type: 'mention.requested',
    groupKey: 'mention.requested:conversation:c1:m1',
    updatedAt: UPDATED,
    readAt: null,
    archivedAt: null,
    resolvedAt: null,
    inertAt: null,
    ...overrides,
  } as InboxItem
}

const view = {
  id: 'i1',
  type: 'mention.requested',
  href: '/app/projects/p/chat?session=c1',
  actorName: 'Anna',
  subject: 'Atrium',
  related: null,
  excerpt: 'geheim',
  variant: null,
  count: 1,
} as InboxItemView

function device(id: string) {
  return { id, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: 'p', auth: 'a' } as never
}

function senderReturning(outcomes: Record<string, PushSendOutcome>) {
  const send = vi.fn(async (target: PushTarget, _body: string, _options: PushSendOptions) => {
    const id = target.endpoint.split('/').pop() ?? ''
    return outcomes[id] ?? ({ kind: 'delivered' } as const)
  })
  return { sender: { send } as PushSender, send }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GRID_WEB_PUSH_VAPID_PUBLIC_KEY', keys.publicKey)
  vi.stubEnv('GRID_WEB_PUSH_VAPID_PRIVATE_KEY', keys.privateKey)
  vi.stubEnv('GRID_WEB_PUSH_SUBJECT', 'mailto:ops@example.org')
  vi.mocked(resolvePinnedRequesterSessionStrict).mockResolvedValue({ userId: 'u1', organizationId: ORG } as AuthorizedSession)
  vi.mocked(findInboxItemForRecipient).mockResolvedValue(row())
  vi.mocked(findUserPreferences).mockResolvedValue(null)
  vi.mocked(viewInboxItemAs).mockResolvedValue(view)
  vi.mocked(listSubscriptions).mockResolvedValue([device('d1')])
  vi.mocked(recordFailure).mockResolvedValue(1)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('a push goes to the recipient’s devices with the item’s words', () => {
  it('sends one encrypted-by-the-library message per device with urgency, TTL and the group topic', async () => {
    vi.mocked(listSubscriptions).mockResolvedValue([device('d1'), device('d2')])
    const { sender, send } = senderReturning({})
    const result = await runInboxPush(ORG, payload, first, sender)
    expect(result).toEqual({ sent: true, delivered: 2, gone: 0, rejected: 0, transient: 0 })
    expect(send).toHaveBeenCalledTimes(2)
    const [, body, options] = send.mock.calls[0]!
    expect(JSON.parse(body)).toMatchObject({ title: 'Anna hat um Ihre Einschätzung gebeten', url: view.href, itemId: 'i1' })
    expect(body).not.toContain('geheim')
    expect(options).toMatchObject({ urgency: 'high', ttlSeconds: 86_400 })
    expect(options.topic).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(recordDelivered).toHaveBeenCalledTimes(2)
  })

  it('words it in English for a person who chose English, and without content when the preview is off', async () => {
    vi.mocked(findUserPreferences).mockResolvedValue({ locale: 'en', pushNotifications: { showContent: false } })
    const { sender, send } = senderReturning({})
    await runInboxPush(ORG, payload, first, sender)
    const body = JSON.parse(send.mock.calls[0]![1])
    expect(body.title).toBe('New message in Piloti')
    expect(body.body).toBeNull()
  })
})

describe('it decides again, at the moment it sends', () => {
  const cases: Array<[string, () => void, string]> = [
    ['the item is gone', () => vi.mocked(findInboxItemForRecipient).mockResolvedValue(null), 'no-longer-news'],
    ['the item was read meanwhile', () => vi.mocked(findInboxItemForRecipient).mockResolvedValue(row({ readAt: new Date() })), 'no-longer-news'],
    ['the item was resolved meanwhile', () => vi.mocked(findInboxItemForRecipient).mockResolvedValue(row({ resolvedAt: new Date() })), 'no-longer-news'],
    ['a newer occurrence has its own job', () => vi.mocked(findInboxItemForRecipient).mockResolvedValue(row({ updatedAt: new Date(UPDATED.getTime() + 1000) })), 'superseded'],
    ['the person switched the category off', () => vi.mocked(findUserPreferences).mockResolvedValue({ pushNotifications: { categories: { requests: false } } }), 'category-off'],
    ['the person can no longer see the item', () => vi.mocked(viewInboxItemAs).mockResolvedValue(null), 'not-visible'],
    ['the person has no device left', () => vi.mocked(listSubscriptions).mockResolvedValue([]), 'no-devices'],
  ]
  it.each(cases)('sends nothing when %s', async (_label, arrange, reason) => {
    arrange()
    const { sender, send } = senderReturning({})
    expect(await runInboxPush(ORG, payload, first, sender)).toEqual({ sent: false, reason })
    expect(send).not.toHaveBeenCalled()
  })

  it('removes the devices of a person who is no longer a member and sends nothing', async () => {
    vi.mocked(resolvePinnedRequesterSessionStrict).mockResolvedValue(null)
    const { sender, send } = senderReturning({})
    expect(await runInboxPush(ORG, payload, first, sender)).toEqual({ sent: false, reason: 'not-a-member' })
    expect(deleteAllSubscriptionsOf).toHaveBeenCalledWith(ORG, 'u1')
    expect(send).not.toHaveBeenCalled()
  })

  // The lenient resolver reads a failed WorkOS lookup as "not a member"; here
  // that removed every device the person had over one 503.
  it('keeps the devices and lets the queue retry when membership could not be looked up', async () => {
    vi.mocked(resolvePinnedRequesterSessionStrict).mockRejectedValue(new Error('workos 503'))
    const { sender, send } = senderReturning({})
    await expect(runInboxPush(ORG, payload, first, sender)).rejects.toThrow('workos 503')
    expect(deleteAllSubscriptionsOf).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('does nothing in a deployment without keys', async () => {
    vi.stubEnv('GRID_WEB_PUSH_VAPID_PUBLIC_KEY', '')
    vi.stubEnv('GRID_WEB_PUSH_VAPID_PRIVATE_KEY', '')
    vi.stubEnv('GRID_WEB_PUSH_SUBJECT', '')
    const { sender, send } = senderReturning({})
    expect(await runInboxPush(ORG, payload, first, sender)).toEqual({ sent: false, reason: 'off' })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('what the push service answers', () => {
  it('prunes a subscription the service says is gone (410) and keeps the others', async () => {
    vi.mocked(listSubscriptions).mockResolvedValue([device('alive'), device('dead')])
    const { sender } = senderReturning({ dead: { kind: 'gone' } })
    const result = await runInboxPush(ORG, payload, first, sender)
    expect(result).toMatchObject({ sent: true, delivered: 1, gone: 1 })
    expect(deleteSubscriptionById).toHaveBeenCalledTimes(1)
    expect(deleteSubscriptionById).toHaveBeenCalledWith('dead')
    expect(recordDelivered).toHaveBeenCalledWith('alive')
  })

  it('throws on a transient failure so the queue retries, without counting it against the device yet', async () => {
    const { sender } = senderReturning({ d1: { kind: 'transient', status: 503 } })
    await expect(runInboxPush(ORG, payload, first, sender)).rejects.toThrow(/trying again/)
    expect(recordFailure).not.toHaveBeenCalled()
    expect(deleteSubscriptionById).not.toHaveBeenCalled()
  })

  it('on the last attempt counts the failure and ends quietly', async () => {
    const { sender } = senderReturning({ d1: { kind: 'transient', status: 503 } })
    await expect(runInboxPush(ORG, payload, last, sender)).resolves.toMatchObject({ sent: true, transient: 1 })
    expect(recordFailure).toHaveBeenCalledWith('d1')
    expect(deleteSubscriptionById).not.toHaveBeenCalled()
  })

  it('drops a device after repeated final refusals, and does not retry them', async () => {
    vi.mocked(recordFailure).mockResolvedValue(MAX_CONSECUTIVE_FAILURES)
    const { sender } = senderReturning({ d1: { kind: 'rejected', status: 403 } })
    await expect(runInboxPush(ORG, payload, first, sender)).resolves.toMatchObject({ rejected: 1 })
    expect(deleteSubscriptionById).toHaveBeenCalledWith('d1')
  })
})
