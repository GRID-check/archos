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
vi.mock('@/lib/inbox/repository', () => ({ findInboxItemForRecipient: vi.fn(), listTouchedOfType: vi.fn() }))
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
import type { InboxItem } from '@/lib/db/schema/inbox'
import { findInboxItemForRecipient, listTouchedOfType } from '@/lib/inbox/repository'
import { viewInboxItemAs } from '@/lib/inbox/service'
import type { InboxItemView } from '@/lib/inbox/types'
import { findUserPreferences } from '@/lib/user-preferences/repository'
import { captureServer } from '@/lib/analytics/posthog-server'
import { MAX_CONSECUTIVE_FAILURES, runInboxPush } from './inbox-push-job'
import {
  deleteAllSubscriptionsOf,
  deleteSubscriptionById,
  listSubscriptions,
  recordDelivered,
  recordFailure,
} from './repository'
import type { PushSender, PushSendOptions, PushSendOutcome, PushTarget } from './sender'
import { PRODUCT_NAME } from '@/lib/brand'

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
  vi.stubEnv('WEB_PUSH_VAPID_PUBLIC_KEY', keys.publicKey)
  vi.stubEnv('WEB_PUSH_VAPID_PRIVATE_KEY', keys.privateKey)
  vi.stubEnv('WEB_PUSH_SUBJECT', 'mailto:ops@example.org')
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
    expect(body.title).toBe(`New message in ${PRODUCT_NAME}`)
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
    vi.stubEnv('WEB_PUSH_VAPID_PUBLIC_KEY', '')
    vi.stubEnv('WEB_PUSH_VAPID_PRIVATE_KEY', '')
    vi.stubEnv('WEB_PUSH_SUBJECT', '')
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

describe('a burst of one type’s rows is one notification (the fold)', () => {
  const reminder = (id: string, secondsBefore: number, variant: string) => ({
    row: row({
      id,
      type: 'annotation.assigned_to_you',
      groupKey: `annotation.assigned_to_you:document:d1:${id}`,
      updatedAt: new Date(UPDATED.getTime() - secondsBefore * 1000),
      payload: { variant },
    }),
    view: {
      ...view,
      id,
      type: 'annotation.assigned_to_you',
      href: `/app/projects/p/files?doc=d1&review=1&mark=${id}`,
      variant,
      related: '4',
    } as InboxItemView,
  })
  const newest = reminder('i1', 0, 'due_soon')
  const morning = [newest, reminder('i2', 1, 'overdue'), reminder('i3', 2, 'due_soon'), reminder('i4', 3, 'due_soon')]

  beforeEach(() => {
    vi.mocked(findInboxItemForRecipient).mockResolvedValue(newest.row)
    vi.mocked(listTouchedOfType).mockResolvedValue(morning.map((entry) => entry.row))
    vi.mocked(viewInboxItemAs).mockImplementation(async (_session, item) => morning.find((entry) => entry.row.id === item.id)?.view ?? null)
  })

  it('sends once, from the newest row’s job, counting every row of the burst the person may see', async () => {
    const { sender, send } = senderReturning({})
    await expect(runInboxPush(ORG, payload, first, sender)).resolves.toMatchObject({ sent: true, delivered: 1 })

    expect(send).toHaveBeenCalledTimes(1)
    const [, body, options] = send.mock.calls[0]!
    expect(JSON.parse(body)).toMatchObject({
      title: '4 Anmerkungen für Sie',
      body: '1 überfällig, 3 heute oder morgen fällig',
      url: '/app/inbox',
      itemId: '',
    })
    expect(options.topic).toBe(JSON.parse(body).tag)
    expect(vi.mocked(captureServer).mock.calls[0]?.[0].properties).toMatchObject({ item_type: 'annotation.assigned_to_you', items: 4 })
  })

  it('leaves an earlier row to the burst’s newest, sending nothing itself', async () => {
    const earlier = morning[3]!
    vi.mocked(findInboxItemForRecipient).mockResolvedValue(earlier.row)
    const { sender, send } = senderReturning({})

    await expect(
      runInboxPush(ORG, { ...payload, itemId: 'i4', stamp: earlier.row.updatedAt.toISOString() }, first, sender)
    ).resolves.toEqual({ sent: false, reason: 'folded' })
    expect(send).not.toHaveBeenCalled()
  })

  it('tells the rows before it when the newest row was read before its job ran: they left the telling to it', async () => {
    // i1's job runs after the person read i1 alone; i2–i4 folded into it and are still news.
    const read = { ...newest.row, readAt: new Date() }
    vi.mocked(findInboxItemForRecipient).mockResolvedValue(read)
    vi.mocked(listTouchedOfType).mockResolvedValue([read, ...morning.slice(1).map((entry) => entry.row)])
    const { sender, send } = senderReturning({})

    await expect(runInboxPush(ORG, payload, first, sender)).resolves.toMatchObject({ sent: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({
      title: '3 Anmerkungen für Sie',
      body: '1 überfällig, 2 heute oder morgen fällig',
    })
    expect(vi.mocked(viewInboxItemAs).mock.calls.map(([, item]) => item.id)).toEqual(['i2', 'i3', 'i4'])
  })

  it('keeps a burst whole across a row read in its middle, and still leaves it to its newest', async () => {
    // i3 was read; i4's job must not tell i4 on its own: i3 still links it to i2 and i1.
    const earlier = morning[3]!
    vi.mocked(findInboxItemForRecipient).mockResolvedValue(earlier.row)
    vi.mocked(listTouchedOfType).mockResolvedValue(
      morning.map((entry) => (entry.row.id === 'i3' ? { ...entry.row, readAt: new Date() } : entry.row))
    )
    const { sender, send } = senderReturning({})

    await expect(
      runInboxPush(ORG, { ...payload, itemId: 'i4', stamp: earlier.row.updatedAt.toISOString() }, first, sender)
    ).resolves.toEqual({ sent: false, reason: 'folded' })
    expect(send).not.toHaveBeenCalled()
  })

  it('sends nothing for a read row whose burst holds nothing else still news', async () => {
    vi.mocked(findInboxItemForRecipient).mockResolvedValue({ ...newest.row, readAt: new Date() })
    vi.mocked(listTouchedOfType).mockResolvedValue(morning.map((entry) => ({ ...entry.row, readAt: new Date() })))
    const { sender, send } = senderReturning({})

    await expect(runInboxPush(ORG, payload, first, sender)).resolves.toEqual({ sent: false, reason: 'no-longer-news' })
    expect(send).not.toHaveBeenCalled()
  })

  it('counts only what the person may still see, and tells a lone survivor in its own words', async () => {
    vi.mocked(viewInboxItemAs).mockImplementation(async (_session, item) => (item.id === 'i2' ? morning[1]!.view : null))
    const { sender, send } = senderReturning({})
    await runInboxPush(ORG, payload, first, sender)

    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({ itemId: 'i2', url: morning[1]!.view.href })
  })
})

describe('a burst of news on the reader’s own marks is one notification', () => {
  // A colleague resolves the reader's marks one after another: each row is `yours` (results, on by default).
  const news = (id: string, secondsBefore: number, variant: string, yours: boolean) => ({
    row: row({
      id,
      type: 'annotation.activity',
      groupKey: `annotation.activity:document:d1:${id}`,
      updatedAt: new Date(UPDATED.getTime() - secondsBefore * 1000),
      payload: { variant, ...(yours ? { yours: true } : {}) },
    }),
    view: {
      ...view,
      id,
      type: 'annotation.activity',
      href: `/app/projects/p/files?doc=d1&review=1&mark=${id}`,
      variant,
      related: '4',
    } as InboxItemView,
  })

  function serveBurst(rows: ReturnType<typeof news>[], own: ReturnType<typeof news>) {
    vi.mocked(findInboxItemForRecipient).mockResolvedValue(own.row)
    vi.mocked(listTouchedOfType).mockResolvedValue(rows.map((entry) => entry.row))
    vi.mocked(viewInboxItemAs).mockImplementation(async (_session, item) => rows.find((entry) => entry.row.id === item.id)?.view ?? null)
  }

  it('tells fifteen marks resolved as one counted notification, from the newest row’s job', async () => {
    const burst = Array.from({ length: 15 }, (_, index) => news(`i${index + 1}`, index, index === 3 ? 'reply' : 'resolved', true))
    serveBurst(burst, burst[0]!)
    const { sender, send } = senderReturning({})

    await expect(runInboxPush(ORG, payload, first, sender)).resolves.toMatchObject({ sent: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({
      title: '15 Neuigkeiten zu Anmerkungen',
      body: '1 mit neuer Antwort, 14 erledigt',
      url: '/app/inbox',
    })

    // Every earlier row's job leaves it to the newest.
    vi.mocked(findInboxItemForRecipient).mockResolvedValue(burst[7]!.row)
    await expect(
      runInboxPush(ORG, { ...payload, itemId: 'i8', stamp: burst[7]!.row.updatedAt.toISOString() }, first, sender)
    ).resolves.toEqual({ sent: false, reason: 'folded' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('counts only the rows the reader’s categories push, and a newer row they get no push for does not take the telling', async () => {
    // i1 is a reply in a thread the reader only takes part in (activity, off by default); i2–i4 are on their own marks.
    const participant = news('i1', 0, 'reply', false)
    const own = [news('i2', 1, 'resolved', true), news('i3', 2, 'resolved', true), news('i4', 3, 'dismissed', true)]
    serveBurst([participant, ...own], own[0]!)
    const { sender, send } = senderReturning({})

    await expect(
      runInboxPush(ORG, { ...payload, itemId: 'i2', stamp: own[0]!.row.updatedAt.toISOString() }, first, sender)
    ).resolves.toMatchObject({ sent: true })
    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({
      title: '3 Neuigkeiten zu Anmerkungen',
      body: '2 erledigt, 1 verworfen',
    })
    expect(vi.mocked(viewInboxItemAs).mock.calls.map(([, item]) => item.id)).not.toContain('i1')

    // The participant's own row is not pushed at all.
    vi.mocked(findInboxItemForRecipient).mockResolvedValue(participant.row)
    await expect(runInboxPush(ORG, payload, first, sender)).resolves.toEqual({ sent: false, reason: 'category-off' })
  })
})
