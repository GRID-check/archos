/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(),
  resolveInboxItemsAnchoredOn: vi.fn(),
}))
vi.mock('./repository', () => ({ findDocumentAnnotation: vi.fn() }))
vi.mock('@/lib/sharing/registry', () => ({ describeResource: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({
  getTenantContext: vi.fn(),
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
}))

import { getTenantContext, withTenant } from '@/lib/db/tenant-context'
import type { InboxEmission } from '@/lib/inbox/service'
import { emitInboxItems, resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import { describeResource } from '@/lib/sharing/registry'
import { onMarkSettledByPerson, onPilotiWrote, onWakeEnded, type MarkRef } from './attention'
import { findDocumentAnnotation, type AnnotationRecord } from './repository'

const ref: MarkRef = {
  organizationId: 'org_1',
  documentId: 'doc_1',
  annotationId: 'ann_1',
  annotationNumber: 4,
  projectId: 'proj_1',
}

function mark(overrides: Partial<AnnotationRecord> = {}): AnnotationRecord {
  return {
    id: 'ann_1',
    kind: 'question',
    authorKind: 'piloti',
    status: 'open',
    body: 'Ist die Brüstungshöhe hier 1,00 m?',
    replies: [],
    ...overrides,
  } as AnnotationRecord
}

/** The one emission the call made. */
function emitted(): InboxEmission {
  expect(emitInboxItems).toHaveBeenCalledTimes(1)
  const [emissions] = vi.mocked(emitInboxItems).mock.calls[0]
  expect(emissions).toHaveLength(1)
  return emissions[0]
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getTenantContext).mockReturnValue({ kind: 'tenant', organizationId: 'org_1', userId: 'user_me' })
  vi.mocked(withTenant).mockImplementation(async (_scope, fn) => await fn())
  vi.mocked(describeResource).mockReturnValue({
    describeRef: vi.fn().mockResolvedValue({ title: 'Grundriss EG.pdf' }),
  } as never)
  vi.mocked(emitInboxItems).mockResolvedValue(1)
  vi.mocked(resolveInboxItemsAnchoredOn).mockResolvedValue(1)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('onWakeEnded', () => {
  const wake = { ...ref, actorUserId: 'user_me' }

  it('tells who delegated a mark that Piloti is done with it', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered' })

    expect(emitted()).toMatchObject({
      organizationId: 'org_1',
      recipientUserId: 'user_me',
      type: 'piloti.work_done',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ann_1',
      groupKey: 'piloti.work_done:document:doc_1:ann_1',
      payload: { subject: 'Grundriss EG.pdf', related: '4' },
    })
  })

  it('tells who delegated a mark that Piloti could not work it', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'failed' })

    expect(emitted()).toMatchObject({ type: 'piloti.work_failed', recipientUserId: 'user_me', anchorId: 'ann_1' })
  })

  it.each(['thread_mention', 'thread_reply'] as const)('tells who asked (%s) when Piloti answered', async (trigger) => {
    await onWakeEnded({ ...wake, trigger, outcome: 'answered' })

    expect(emitted()).toMatchObject({ type: 'piloti.work_done', recipientUserId: 'user_me' })
  })

  it.each(['thread_mention', 'thread_reply'] as const)('stays quiet when a %s did not get an answer', async (trigger) => {
    await onWakeEnded({ ...wake, trigger, outcome: 'failed' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it.each(['assigned', 'thread_mention', 'thread_reply'] as const)(
    'stays quiet when the person stopped it (%s)',
    async (trigger) => {
      await onWakeEnded({ ...wake, trigger, outcome: 'stopped' })

      expect(emitInboxItems).not.toHaveBeenCalled()
    },
  )

  it('carries no actor, so the person is told about Piloti’s work and not dropped as their own act', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered' })

    expect(emitted().actorUserId).toBeNull()
  })

  it('names no file when the document cannot be described, and still tells', async () => {
    vi.mocked(describeResource).mockReturnValue({ describeRef: vi.fn().mockRejectedValue(new Error('gone')) } as never)

    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered' })

    expect(emitted().payload).toEqual({ related: '4' })
  })

  it('never throws into the turn when the inbox write fails', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('database down'))

    await expect(onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered' })).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })
})

describe('onPilotiWrote', () => {
  const write = { ...ref, onBehalfOf: 'user_me', assigneeUserId: null, replyId: null }

  it('asks the person the turn acted for when Piloti sets a Rückfrage nobody is responsible for', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark({ status: 'proposed' }))

    await onPilotiWrote({ ...write, what: 'question' })

    expect(emitted()).toMatchObject({
      recipientUserId: 'user_me',
      type: 'piloti.asks_you',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ann_1',
      actorUserId: null,
      groupKey: 'piloti.asks_you:document:doc_1:ann_1',
      payload: { subject: 'Grundriss EG.pdf', related: '4', excerpt: 'Ist die Brüstungshöhe hier 1,00 m?' },
    })
  })

  it('asks the responsible person instead when the mark has one', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark())

    await onPilotiWrote({ ...write, what: 'question', assigneeUserId: 'user_zustaendig' })

    expect(emitted().recipientUserId).toBe('user_zustaendig')
  })

  it('quotes the reply, not the mark, when Piloti follows up in the thread', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(
      mark({ replies: [{ id: 'reply_1', body: 'Und die Absturzsicherung?' } as AnnotationRecord['replies'][number]] }),
    )

    await onPilotiWrote({ ...write, what: 'reply', replyId: 'reply_1' })

    expect(emitted()).toMatchObject({ type: 'piloti.asks_you', payload: { excerpt: 'Und die Absturzsicherung?' } })
  })

  it('cuts a long question to a line', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark({ body: `Frage\n${'sehr lang '.repeat(60)}` }))

    await onPilotiWrote({ ...write, what: 'question' })

    const excerpt = emitted().payload?.excerpt as string
    expect(excerpt.length).toBeLessThanOrEqual(160)
    expect(excerpt).not.toContain('\n')
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('says nothing about an ordinary mark', async () => {
    await onPilotiWrote({ ...write, what: 'mark' })

    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(findDocumentAnnotation).not.toHaveBeenCalled()
  })

  it.each([
    ['a reply on a Hinweis', { kind: 'hint' as const }],
    ['a reply on a Mangel', { kind: 'defect' as const }],
    ['an answer to a person’s own Rückfrage', { authorKind: 'person' as const }],
    ['a reply on a resolved Rückfrage', { status: 'resolved' as const }],
    ['a reply on a dismissed Rückfrage', { status: 'dismissed' as const }],
  ])('says nothing for %s: it waits on nobody', async (_name, overrides) => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark(overrides))

    await onPilotiWrote({ ...write, what: 'reply', replyId: 'reply_1' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing when the mark is gone by now', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(null)

    await onPilotiWrote({ ...write, what: 'question' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('never throws into the turn when the mark cannot be read or the inbox write fails', async () => {
    vi.mocked(findDocumentAnnotation).mockRejectedValueOnce(new Error('database down'))
    await expect(onPilotiWrote({ ...write, what: 'question' })).resolves.toBeUndefined()

    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark())
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('database down'))
    await expect(onPilotiWrote({ ...write, what: 'question' })).resolves.toBeUndefined()
  })
})

describe('onMarkSettledByPerson', () => {
  const settle = { organizationId: 'org_1', annotationId: 'ann_1', userId: 'user_me' }

  it('resolves the Rückfrage for the person who answered, and for nobody else', async () => {
    await onMarkSettledByPerson({ ...settle, closed: false })

    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['piloti.asks_you'],
      anchorId: 'ann_1',
      recipientUserId: 'user_me',
    })
  })

  it('resolves it for everyone once the mark is closed', async () => {
    await onMarkSettledByPerson({ ...settle, closed: true })

    const [input] = vi.mocked(resolveInboxItemsAnchoredOn).mock.calls[0]
    expect(input).toEqual({ organizationId: 'org_1', types: ['piloti.asks_you'], anchorId: 'ann_1' })
    expect(input).not.toHaveProperty('recipientUserId')
  })

  it('never throws into the write that settled it', async () => {
    vi.mocked(resolveInboxItemsAnchoredOn).mockRejectedValue(new Error('database down'))

    await expect(onMarkSettledByPerson({ ...settle, closed: true })).resolves.toBeUndefined()
  })
})

describe('the tenant scope of the write', () => {
  it('keeps the caller’s own when there is one', async () => {
    await onMarkSettledByPerson({ organizationId: 'org_1', annotationId: 'ann_1', userId: 'u', closed: true })

    expect(withTenant).not.toHaveBeenCalled()
  })

  it('states the event’s organization when the caller has none, because inbox_items is behind RLS', async () => {
    vi.mocked(getTenantContext).mockReturnValue(undefined)

    await onMarkSettledByPerson({ organizationId: 'org_1', annotationId: 'ann_1', userId: 'u', closed: true })

    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalled()
  })
})
