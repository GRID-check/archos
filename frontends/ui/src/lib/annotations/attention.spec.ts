/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(),
  resolveInboxItemsAnchoredOn: vi.fn(),
  markInboxItemsInertAnchoredOn: vi.fn(),
  retractInboxOccurrenceAnchoredOn: vi.fn(),
  rewriteInboxPayloadsAnchoredOn: vi.fn(),
}))
vi.mock('./repository', () => ({ findDocumentAnnotation: vi.fn() }))
vi.mock('@/lib/assignments/repository', () => ({ listAssignmentsForResources: vi.fn() }))
vi.mock('@/lib/sharing/registry', () => ({ describeResource: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({
  getTenantContext: vi.fn(),
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
}))

import { getTenantContext, withTenant } from '@/lib/db/tenant-context'
import type { InboxEmission } from '@/lib/inbox/service'
import {
  emitInboxItems,
  markInboxItemsInertAnchoredOn,
  resolveInboxItemsAnchoredOn,
  retractInboxOccurrenceAnchoredOn,
  rewriteInboxPayloadsAnchoredOn,
} from '@/lib/inbox/service'
import { MARK_ANCHORED_INBOX_TYPES } from '@/lib/inbox/registry'
import { describeResource } from '@/lib/sharing/registry'
import { listAssignmentsForResources } from '@/lib/assignments/repository'
import { inboxItemCopy } from '@/lib/inbox/item-copy'
import type { InboxItemView } from '@/lib/inbox/types'
import { namespaceRoot, translatorFor } from '@/i18n/namespace'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import {
  markAuthor,
  markParticipants,
  onAssigneeChanged,
  onDueChanged,
  onMarkDue,
  remindedFor,
  onMarkDeleted,
  onMarkMentioned,
  onMarkMoved,
  onMarkReplied,
  onMarkSettledByPerson,
  onMarksSet,
  onPilotiWrote,
  onReplyDeleted,
  onReplyEdited,
  onWakeEnded,
  type MarkPeople,
  type MarkRef,
  type MayOpen,
} from './attention'
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
  vi.mocked(markInboxItemsInertAnchoredOn).mockResolvedValue(1)
  vi.mocked(listAssignmentsForResources).mockResolvedValue([])
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

  it('quotes what the mark says, on one line, so the person knows which one it was', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered', markText: '  Türbreite\n prüfen ' })

    expect(emitted().payload).toEqual({
      subject: 'Grundriss EG.pdf',
      related: '4',
      excerpt: 'Türbreite prüfen',
      // Every excerpt names its mentions, none here, so a folded row never keeps another's.
      mentions: [],
      variant: 'assigned',
    })
  })

  it.each([
    ['budget: The user LLM budget is exhausted. An org admin can raise limits under Organization → Usage & budgets.', 'budget'],
    ['The assistant is busy right now. Please send your message again in a moment.', 'busy'],
    ['token_expired', 'access'],
    ['the turn ended without an answer', 'error'],
    [null, 'error'],
  ] as const)('names why it failed („%s“ is %s), never the stored reason itself', async (reason, variant) => {
    await onWakeEnded({ ...wake, trigger: 'thread_mention', outcome: 'failed', reason })

    const payload = emitted().payload
    expect(payload).toMatchObject({ variant })
    expect(JSON.stringify(payload)).not.toContain('token_expired')
    expect(JSON.stringify(payload)).not.toContain('budget is exhausted')
  })

  it('names what woke Piloti on work that was done, never a cause, so a delegation’s end says the mark is back', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered', reason: 'ignored' })

    expect(emitted().payload).toMatchObject({ variant: 'assigned' })
  })

  it.each(['thread_mention', 'thread_reply'] as const)(
    'names the trigger (%s) on work done, so a folded row never keeps an earlier variant',
    async (trigger) => {
      await onWakeEnded({ ...wake, trigger, outcome: 'answered' })

      expect(emitted().payload).toMatchObject({ variant: trigger })
    },
  )

  it.each(['thread_mention', 'thread_reply'] as const)('tells who asked (%s) when Piloti answered', async (trigger) => {
    await onWakeEnded({ ...wake, trigger, outcome: 'answered' })

    expect(emitted()).toMatchObject({ type: 'piloti.work_done', recipientUserId: 'user_me' })
  })

  it.each(['thread_mention', 'thread_reply'] as const)(
    'tells who asked (%s) when Piloti could not answer',
    async (trigger) => {
      await onWakeEnded({ ...wake, trigger, outcome: 'failed' })

      expect(emitted()).toMatchObject({
        type: 'piloti.work_failed',
        recipientUserId: 'user_me',
        anchorId: 'ann_1',
        actorUserId: null,
        groupKey: 'piloti.work_failed:document:doc_1:ann_1',
        payload: { subject: 'Grundriss EG.pdf', related: '4', variant: 'error' },
      })
    },
  )

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

    expect(emitted().payload).toEqual({ related: '4', variant: 'assigned' })
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
  const settle = { organizationId: 'org_1', annotationId: 'ann_1' }

  it('resolves the Rückfrage for everyone once any person answered it: one answer answers it', async () => {
    await onMarkSettledByPerson({ ...settle, closed: false })

    const [input] = vi.mocked(resolveInboxItemsAnchoredOn).mock.calls[0]
    expect(input).toEqual({ organizationId: 'org_1', types: ['piloti.asks_you'], anchorId: 'ann_1' })
    expect(input).not.toHaveProperty('recipientUserId')
  })

  it('resolves the Rückfrage, the Zuständige’s row and every mention for everyone once the mark is closed', async () => {
    await onMarkSettledByPerson({ ...settle, closed: true, answeredBy: null })

    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledTimes(1)
    const [input] = vi.mocked(resolveInboxItemsAnchoredOn).mock.calls[0]
    expect(input).toEqual({
      organizationId: 'org_1',
      types: ['piloti.asks_you', 'annotation.assigned_to_you', 'annotation.mentioned'],
      anchorId: 'ann_1',
    })
    expect(input).not.toHaveProperty('recipientUserId')
  })

  it('settles the answering person’s own mention, and nobody else’s: a colleague asked in the same breath has not answered', async () => {
    await onMarkSettledByPerson({ ...settle, closed: false, answeredBy: 'user_anna' })

    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(resolveInboxItemsAnchoredOn).mock.calls[1][0]).toEqual({
      organizationId: 'org_1',
      types: ['annotation.mentioned'],
      anchorId: 'ann_1',
      recipientUserId: 'user_anna',
    })
  })

  it('never throws into the write that settled it', async () => {
    vi.mocked(resolveInboxItemsAnchoredOn).mockRejectedValue(new Error('database down'))

    await expect(onMarkSettledByPerson({ ...settle, closed: true })).resolves.toBeUndefined()
  })
})

describe('the tenant scope of the write', () => {
  it('keeps the caller’s own when there is one', async () => {
    await onMarkSettledByPerson({ organizationId: 'org_1', annotationId: 'ann_1', closed: true })

    expect(withTenant).not.toHaveBeenCalled()
  })

  it('states the event’s organization when the caller has none, because inbox_items is behind RLS', async () => {
    vi.mocked(getTenantContext).mockReturnValue(undefined)

    await onMarkSettledByPerson({ organizationId: 'org_1', annotationId: 'ann_1', closed: true })

    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalled()
  })
})

/** A mark's people, as the thread reads them. */
function people(overrides: Partial<MarkPeople & Pick<AnnotationRecord, 'kind' | 'status'>> = {}) {
  return {
    authorKind: 'person' as const,
    createdBy: 'user_author',
    acceptedBy: null,
    assigneeUserId: null,
    delegatedBy: null,
    replies: [],
    kind: 'defect' as const,
    status: 'open' as const,
    ...overrides,
  }
}

/** Everyone may open the document, unless a test says who may not. */
const everyone: MayOpen = async (userIds) => new Set(userIds)
const allBut =
  (...hidden: string[]): MayOpen =>
  async (userIds) =>
    new Set(userIds.filter((userId) => !hidden.includes(userId)))

/** Who the one emission went to. */
function recipients(): string[] {
  expect(emitInboxItems).toHaveBeenCalledTimes(1)
  return vi.mocked(emitInboxItems).mock.calls[0][0].map((emission) => emission.recipientUserId)
}

describe('markParticipants', () => {
  it('is the author, the Zuständige, who delegated and every person who replied, once each', () => {
    const mark = people({
      assigneeUserId: 'user_zustaendig',
      delegatedBy: 'user_delegator',
      replies: [
        { authorKind: 'person', createdBy: 'user_replier' },
        { authorKind: 'person', createdBy: 'user_author' },
        { authorKind: 'piloti', createdBy: 'user_asker' },
      ],
    })

    expect(markParticipants(mark)).toEqual(['user_author', 'user_zustaendig', 'user_delegator', 'user_replier'])
  })

  it('counts everyone the mark or a reply mentions as taking part, never Piloti', () => {
    const mark = people({
      mentions: [{ targetId: 'user_named', display: 'Nina' }],
      replies: [
        {
          authorKind: 'person',
          createdBy: 'user_replier',
          mentions: [
            { targetId: 'agent:piloti', display: 'Piloti' },
            { targetId: 'user_asked', display: 'Anna' },
          ],
        },
      ],
    })

    expect(markParticipants(mark)).toEqual(['user_author', 'user_replier', 'user_named', 'user_asked'])
  })

  it('takes the person who took Piloti’s mark over as its author, and nobody for an untaken proposal', () => {
    expect(markAuthor(people({ authorKind: 'piloti', createdBy: 'user_asker', acceptedBy: 'user_taker' }))).toBe('user_taker')
    expect(markParticipants(people({ authorKind: 'piloti', createdBy: 'user_asker', acceptedBy: null }))).toEqual([])
  })
})

describe('onAssigneeChanged', () => {
  const act = { ...ref, actorUserId: 'user_anna', byPiloti: false, markText: 'Tür  T30\nfehlt', open: true, dueOn: null }

  it('asks the new Zuständige, named by who did it, quoting the mark', async () => {
    await onAssigneeChanged({ ...act, previousAssigneeUserId: null, assigneeUserId: 'user_bob' })

    expect(emitted()).toMatchObject({
      recipientUserId: 'user_bob',
      type: 'annotation.assigned_to_you',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ann_1',
      actorUserId: 'user_anna',
      groupKey: 'annotation.assigned_to_you:document:doc_1:ann_1',
      payload: { subject: 'Grundriss EG.pdf', related: '4', excerpt: 'Tür T30 fehlt', variant: 'person', dueOn: null },
    })
    expect(resolveInboxItemsAnchoredOn).not.toHaveBeenCalled()
  })

  it('says by when, when the mark has a date', async () => {
    await onAssigneeChanged({ ...act, dueOn: '2026-10-24', previousAssigneeUserId: null, assigneeUserId: 'user_bob' })

    expect(emitted()).toMatchObject({ payload: { variant: 'person', dueOn: '2026-10-24' } })
  })

  it('clears the daily reminder’s stamp, so a mark handed back (A→B→A) is reminded of its Frist again', async () => {
    await onAssigneeChanged({ ...act, dueOn: '2026-10-18', previousAssigneeUserId: 'user_carol', assigneeUserId: 'user_bob' })

    // The row's payload merges (`payload || excluded.payload`): only an explicit null takes the old stamp off.
    const merged = { reminder: 'due_soon:2026-10-18', ...emitted().payload }
    expect(merged).toHaveProperty('reminder', null)
  })

  it('says Piloti did it for the asker when Piloti changed the mark', async () => {
    await onAssigneeChanged({ ...act, byPiloti: true, previousAssigneeUserId: null, assigneeUserId: 'user_bob' })

    expect(emitted()).toMatchObject({ actorUserId: 'user_anna', payload: { variant: 'piloti' } })
  })

  it('tells nobody when a person makes themselves responsible', async () => {
    await onAssigneeChanged({ ...act, previousAssigneeUserId: null, assigneeUserId: 'user_anna' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('tells nobody about a mark that is not open: a proposal is nobody’s yet, a closed mark nobody’s to do', async () => {
    await onAssigneeChanged({ ...act, open: false, previousAssigneeUserId: null, assigneeUserId: 'user_bob' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('settles the previous Zuständige’s row, and only theirs, when someone else takes it on', async () => {
    await onAssigneeChanged({ ...act, previousAssigneeUserId: 'user_carol', assigneeUserId: 'user_bob' })

    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.assigned_to_you'],
      anchorId: 'ann_1',
      recipientUserId: 'user_carol',
    })
    expect(recipients()).toEqual(['user_bob'])
  })

  it('settles the previous one’s row when nobody is responsible any more', async () => {
    await onAssigneeChanged({ ...act, previousAssigneeUserId: 'user_carol', assigneeUserId: null })

    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith(expect.objectContaining({ recipientUserId: 'user_carol' }))
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('never throws into the write when the inbox is down', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('database down'))

    await expect(
      onAssigneeChanged({ ...act, previousAssigneeUserId: null, assigneeUserId: 'user_bob' }),
    ).resolves.toBeUndefined()
  })
})

describe('onDueChanged', () => {
  const act = { ...ref, actorUserId: 'user_anna', byPiloti: false, markText: 'Tür T30 fehlt', open: true }

  it('tells the Zuständige the new date, in the row they have for the mark, named by who moved it', async () => {
    await onDueChanged({ ...act, assigneeUserId: 'user_bob', dueOn: '2026-10-24' })

    expect(emitted()).toMatchObject({
      recipientUserId: 'user_bob',
      type: 'annotation.assigned_to_you',
      actorUserId: 'user_anna',
      groupKey: 'annotation.assigned_to_you:document:doc_1:ann_1',
      payload: { variant: 'due', dueOn: '2026-10-24', related: '4' },
    })
  })

  it('clears the daily reminder’s stamp, so a date moved and moved back (18→20→18) is reminded of again', async () => {
    await onDueChanged({ ...act, assigneeUserId: 'user_bob', dueOn: '2026-10-18' })

    const merged = { reminder: 'due_soon:2026-10-18', ...emitted().payload }
    expect(merged).toHaveProperty('reminder', null)
  })

  it('says the date was cleared, and that Piloti did it for the person it worked for', async () => {
    await onDueChanged({ ...act, byPiloti: true, assigneeUserId: 'user_bob', dueOn: null })

    expect(emitted()).toMatchObject({ actorUserId: 'user_anna', payload: { variant: 'due_cleared_piloti', dueOn: null } })
  })

  it('tells nobody on a mark without a Zuständige, a closed mark, or the Zuständige’s own change', async () => {
    await onDueChanged({ ...act, assigneeUserId: null, dueOn: '2026-10-24' })
    await onDueChanged({ ...act, open: false, assigneeUserId: 'user_bob', dueOn: '2026-10-24' })
    await onDueChanged({ ...act, actorUserId: 'user_bob', assigneeUserId: 'user_bob', dueOn: '2026-10-24' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('onMarkDue', () => {
  it('asks the Zuständige again, without an actor, stamped with which reminder for which date', async () => {
    await onMarkDue({ ...ref, assigneeUserId: 'user_bob', dueOn: '2026-10-18', reminder: 'due_soon', markText: 'Tür T30 fehlt' })

    expect(emitted()).toMatchObject({
      recipientUserId: 'user_bob',
      type: 'annotation.assigned_to_you',
      actorUserId: null,
      groupKey: 'annotation.assigned_to_you:document:doc_1:ann_1',
      payload: { variant: 'due_soon', dueOn: '2026-10-18', reminder: 'due_soon:2026-10-18', excerpt: 'Tür T30 fehlt' },
    })
    expect(remindedFor('overdue', '2026-10-18')).toBe('overdue:2026-10-18')
  })

  it('throws when the inbox is down, so the job counts the mark it could not tell', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('database down'))

    await expect(
      onMarkDue({ ...ref, assigneeUserId: 'user_bob', dueOn: '2026-10-18', reminder: 'overdue', markText: null })
    ).rejects.toThrow('database down')
  })
})

describe('onMarkReplied', () => {
  const reply = { ...ref, actorUserId: 'user_replier', byPiloti: false, markText: 'Tür T30 fehlt', replyText: 'Ist bestellt.' }
  const thread = people({
    assigneeUserId: 'user_zustaendig',
    delegatedBy: 'user_delegator',
    replies: [{ authorKind: 'person', createdBy: 'user_replier' }],
  })

  it('tells every participant but the one who replied, one counted row per mark, quoting the reply', async () => {
    await onMarkReplied({ ...reply, mark: thread, mayOpen: everyone })

    expect(recipients()).toEqual(['user_author', 'user_zustaendig', 'user_delegator'])
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0]).toMatchObject({
      type: 'annotation.activity',
      actorUserId: 'user_replier',
      anchorId: 'ann_1',
      groupKey: 'annotation.activity:document:doc_1:ann_1',
      payload: { subject: 'Grundriss EG.pdf', related: '4', excerpt: 'Ist bestellt.', mentions: [], variant: 'reply' },
    })
  })

  it('quotes a reply with whom it mentions, and every excerpt names its own, so a folded row never keeps the last one’s', async () => {
    const anna = { targetId: 'user_anna', display: 'Anna Berger' }
    await onMarkReplied({ ...reply, replyText: '@Anna Berger ist bestellt.', replyMentions: [anna], mark: thread, mayOpen: everyone })
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0].payload).toMatchObject({ mentions: [anna] })

    // The next row folds into this one and its payload merges: a quote
    // without mentions writes `[]` rather than inheriting Anna's.
    await onMarkMoved({ ...ref, actorUserId: 'user_bob', byPiloti: false, markText: 'Tür T30 fehlt', move: 'resolved', mark: thread, mayOpen: everyone })
    expect(vi.mocked(emitInboxItems).mock.calls[1][0][0].payload).toMatchObject({ excerpt: 'Tür T30 fehlt', mentions: [] })
  })

  it('says to the mark’s author alone that the reply is on their mark, so it reaches them as an answer', async () => {
    await onMarkReplied({ ...reply, mark: thread, mayOpen: everyone })

    const rows = vi.mocked(emitInboxItems).mock.calls[0][0]
    const yours = Object.fromEntries(rows.map((row) => [row.recipientUserId, (row.payload as { yours?: boolean }).yours ?? false]))
    expect(yours).toEqual({ user_author: true, user_zustaendig: false, user_delegator: false })
  })

  it('tells nobody who may not open the document now', async () => {
    await onMarkReplied({ ...reply, mark: thread, mayOpen: allBut('user_delegator') })

    expect(recipients()).toEqual(['user_author', 'user_zustaendig'])
  })

  it('leaves out the person Piloti’s turn acted for, who woke it and hears that Piloti is done', async () => {
    await onMarkReplied({ ...reply, actorUserId: 'user_delegator', byPiloti: true, mark: thread, mayOpen: everyone })

    expect(recipients()).toEqual(['user_author', 'user_zustaendig', 'user_replier'])
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0].actorUserId).toBeNull()
  })

  it('leaves out the Zuständige Piloti’s open Rückfrage asks: they have that row', async () => {
    const question = { ...thread, authorKind: 'piloti' as const, acceptedBy: 'user_author', kind: 'question' as const }

    await onMarkReplied({ ...reply, actorUserId: 'user_delegator', byPiloti: true, mark: question, mayOpen: everyone })

    expect(recipients()).toEqual(['user_author', 'user_replier'])
  })

  it('tells nobody when nobody else takes part', async () => {
    await onMarkReplied({ ...reply, actorUserId: 'user_author', mark: people(), mayOpen: everyone })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('leaves out whom the reply mentions: they hear the mention, one row for one reply', async () => {
    await onMarkReplied({ ...reply, mark: thread, mayOpen: everyone, mentioned: ['user_author'] })

    expect(recipients()).toEqual(['user_zustaendig', 'user_delegator'])
  })
})

describe('onMarkMentioned', () => {
  const said = {
    ...ref,
    actorUserId: 'user_writer',
    byPiloti: false,
    markText: 'Tür T30 fehlt',
    text: '@Anna Berger   bitte\nprüfen',
    mentions: [{ targetId: 'user_anna', display: 'Anna Berger' }],
  }

  it('asks each person mentioned, at the mark, named by who wrote it, quoting the text with its mentions', async () => {
    await onMarkMentioned({ ...said, mentioned: ['user_anna', 'user_ben'], mayOpen: everyone })

    expect(recipients()).toEqual(['user_anna', 'user_ben'])
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0]).toMatchObject({
      type: 'annotation.mentioned',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ann_1',
      actorUserId: 'user_writer',
      groupKey: 'annotation.mentioned:document:doc_1:ann_1',
      payload: {
        subject: 'Grundriss EG.pdf',
        related: '4',
        excerpt: '@Anna Berger bitte prüfen',
        // The row draws them as the thread's chips.
        mentions: [{ targetId: 'user_anna', display: 'Anna Berger' }],
      },
    })
  })

  it('tells nobody who wrote it, or who may not open the document now', async () => {
    await onMarkMentioned({ ...said, mentioned: ['user_writer', 'user_anna', 'user_ben'], mayOpen: allBut('user_ben') })

    expect(recipients()).toEqual(['user_anna'])
  })

  it('writes nothing when nobody is left to tell', async () => {
    await onMarkMentioned({ ...said, mentioned: ['user_writer'], mayOpen: everyone })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('anchors on the mark, so the row opens the Prüfansicht there and a deleted mark turns it inert', () => {
    expect(MARK_ANCHORED_INBOX_TYPES).toContain('annotation.mentioned')
  })
})

describe('onMarkMoved', () => {
  const move = { ...ref, actorUserId: 'user_bob', byPiloti: false, markText: 'Tür T30 fehlt', mayOpen: everyone }

  it.each(['resolved', 'dismissed', 'reopened'] as const)('tells the author someone else %s their mark', async (moved) => {
    await onMarkMoved({ ...move, move: moved, mark: people() })

    expect(emitted()).toMatchObject({
      recipientUserId: 'user_author',
      type: 'annotation.activity',
      actorUserId: 'user_bob',
      payload: { related: '4', excerpt: 'Tür T30 fehlt', variant: moved, yours: true },
    })
  })

  it('tells the person who took Piloti’s mark over, as its author', async () => {
    await onMarkMoved({ ...move, move: 'resolved', mark: people({ authorKind: 'piloti', acceptedBy: 'user_taker' }) })

    expect(recipients()).toEqual(['user_taker'])
  })

  it('tells nobody when the author did it, a proposal nobody took over moved, or the author may not open it', async () => {
    await onMarkMoved({ ...move, actorUserId: 'user_author', move: 'resolved', mark: people() })
    await onMarkMoved({ ...move, move: 'dismissed', mark: people({ authorKind: 'piloti', acceptedBy: null }) })
    await onMarkMoved({ ...move, move: 'resolved', mark: people(), mayOpen: allBut('user_author') })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('onMarkDeleted', () => {
  it('turns every row about the mark inert, for everyone, but the „N Anmerkungen gesetzt“ rows anchored on it', async () => {
    await onMarkDeleted({ organizationId: 'org_1', annotationId: 'ann_1' })

    expect(markInboxItemsInertAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: MARK_ANCHORED_INBOX_TYPES,
      anchorId: 'ann_1',
      groupAnchor: { isNot: 'set:' },
    })
    expect(MARK_ANCHORED_INBOX_TYPES).toEqual(
      expect.arrayContaining(['piloti.asks_you', 'annotation.assigned_to_you', 'annotation.activity']),
    )
  })

  it('takes the deleted mark out of a „15 Anmerkungen gesetzt“ row: one less, no quote, inert only once it counts none', async () => {
    await onMarkDeleted({ organizationId: 'org_1', annotationId: 'ann_15' })

    expect(retractInboxOccurrenceAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.activity'],
      anchorId: 'ann_15',
      groupAnchor: { is: 'set:' },
      clear: ['excerpt', 'mentions', 'related'],
      inertWhenSpent: true,
    })
  })

  it('never throws into the delete', async () => {
    vi.mocked(markInboxItemsInertAnchoredOn).mockRejectedValue(new Error('database down'))

    await expect(onMarkDeleted({ organizationId: 'org_1', annotationId: 'ann_1' })).resolves.toBeUndefined()
  })
})

describe('onMarksSet', () => {
  const assigned = (...userIds: string[]) =>
    vi.mocked(listAssignmentsForResources).mockResolvedValue(
      userIds.map((subjectUserId) => ({
        resourceType: 'document' as const,
        resourceId: 'doc_1',
        subjectUserId,
        assignedBy: 'user_x',
        createdAt: new Date(),
      }))
    )
  const everyone: MayOpen = async (userIds) => new Set(userIds)
  const set = (number: number, toldOtherwise: Array<string | null> = []) => ({
    id: `ann_${number}`,
    number,
    body: `Anmerkung Nummer ${number}`,
    toldOtherwise,
  })
  const base = {
    organizationId: 'org_1',
    documentId: 'doc_1',
    projectId: 'proj_1',
    actorUserId: 'user_miriam',
    uploaderUserId: 'user_uploader',
    mayOpen: everyone,
  }
  const sent = () => vi.mocked(emitInboxItems).mock.calls.flatMap(([emissions]) => emissions)

  it('tells the document’s Verantwortliche and its uploader, as one row per document and setter, anchored on the newest', async () => {
    assigned('user_lead')
    await onMarksSet({ ...base, by: 'created', marks: [set(4)] })

    const rows = sent()
    expect(rows.map((row) => row.recipientUserId)).toEqual(['user_lead', 'user_uploader'])
    expect(rows[0]).toMatchObject({
      type: 'annotation.activity',
      resourceId: 'doc_1',
      anchorId: 'ann_4',
      actorUserId: 'user_miriam',
      groupKey: 'annotation.activity:document:doc_1:set:created:user_miriam',
      occurrences: 1,
      payload: { subject: 'Grundriss EG.pdf', related: '4', excerpt: 'Anmerkung Nummer 4', variant: 'created' },
    })
  })

  it('counts a batch in one emission per reader, and leaves out whom a mark already tells otherwise', async () => {
    assigned('user_lead', 'user_anna')
    // Anna is the Zuständige of 7 (she hears `annotation.assigned_to_you` about it).
    await onMarksSet({ ...base, by: 'created_piloti', marks: [set(5), set(6), set(7, ['user_anna'])] })

    const rows = sent()
    expect(rows.map((row) => [row.recipientUserId, row.occurrences, row.anchorId])).toEqual([
      ['user_lead', 3, 'ann_7'],
      ['user_uploader', 3, 'ann_7'],
      ['user_anna', 2, 'ann_6'],
    ])
    expect(rows.every((row) => row.groupKey === 'annotation.activity:document:doc_1:set:created_piloti:user_miriam')).toBe(true)
  })

  it('tells nobody who acted, nobody who may not open the document, and nobody when the document has no people', async () => {
    assigned('user_miriam', 'user_closed')
    await onMarksSet({
      ...base,
      uploaderUserId: 'user_miriam',
      by: 'created',
      marks: [set(1)],
      mayOpen: async (userIds) => new Set(userIds.filter((userId) => userId !== 'user_closed')),
    })
    expect(emitInboxItems).not.toHaveBeenCalled()

    assigned()
    await onMarksSet({ ...base, uploaderUserId: null, by: 'created', marks: [set(1)] })
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('reads as the colleague’s sentence, counted: „Miriam hat 15 Anmerkungen in „Grundriss EG“ gesetzt“', () => {
    const dictionary = namespaceRoot(collaborationCopy, 'de')
    const t = translatorFor(collaborationCopy, 'de')
    const row = (variant: string, count: number) =>
      ({
        type: 'annotation.activity',
        variant,
        count,
        actorName: 'Miriam',
        subject: 'Grundriss EG',
        related: '15',
        excerpt: 'x',
        href: '/x',
        state: 'unread',
        dueOn: null,
        answerIn: null,
        resourceType: 'document',
      }) as unknown as InboxItemView
    expect(inboxItemCopy(row('created', 15), t, dictionary)).toEqual({
      title: 'Miriam hat 15 Anmerkungen in „Grundriss EG“ gesetzt',
      body: 'Die neueste ist Anmerkung 15.',
    })
    expect(inboxItemCopy(row('created', 1), t, dictionary).title).toBe('Miriam hat Anmerkung 15 in „Grundriss EG“ gesetzt')
    expect(inboxItemCopy(row('created_piloti', 3), t, dictionary).title).toBe(
      'Piloti hat für Miriam 3 Anmerkungen in „Grundriss EG“ gesetzt'
    )
  })

  it('names nobody, never „Jemand“ or an empty name, when the person who set them is unknown', () => {
    const dictionary = namespaceRoot(collaborationCopy, 'de')
    const t = translatorFor(collaborationCopy, 'de')
    const row = (variant: string, count: number, subject: string | null) =>
      ({
        type: 'annotation.activity',
        variant,
        count,
        actorName: null,
        subject,
        related: '15',
        excerpt: 'x',
        href: '/x',
        state: count === 0 ? 'read' : 'unread',
        dueOn: null,
        answerIn: null,
        resourceType: 'document',
      }) as unknown as InboxItemView
    const titles = ['created', 'created_piloti'].flatMap((variant) =>
      [0, 1, 3].flatMap((count) => ['Grundriss EG', null].map((subject) => inboxItemCopy(row(variant, count, subject), t, dictionary).title))
    )
    for (const title of titles) {
      expect(title).not.toMatch(/Jemand|für\s+(Anmerkung|\d|eine)|\{actor\}/)
    }
    expect(inboxItemCopy(row('created_piloti', 3, 'Grundriss EG'), t, dictionary).title).toBe(
      'Piloti hat 3 Anmerkungen in „Grundriss EG“ gesetzt'
    )
    expect(inboxItemCopy(row('created', 0, null), t, dictionary).title).toBe('Neue Anmerkungen')
  })

  it('reads a row whose newest mark was deleted by its count alone, and says one of them is gone', () => {
    const dictionary = namespaceRoot(collaborationCopy, 'de')
    const t = translatorFor(collaborationCopy, 'de')
    const row = {
      type: 'annotation.activity',
      variant: 'created',
      count: 14,
      actorName: 'Miriam',
      subject: 'Grundriss EG',
      related: null,
      excerpt: null,
      href: '/x',
      state: 'unread',
      dueOn: null,
      answerIn: null,
      resourceType: 'document',
    } as unknown as InboxItemView
    expect(inboxItemCopy(row, t, dictionary)).toEqual({
      title: 'Miriam hat 14 Anmerkungen in „Grundriss EG“ gesetzt',
      body: 'Eine der Anmerkungen wurde inzwischen gelöscht.',
    })
  })
})

describe('onReplyDeleted', () => {
  const input = { organizationId: 'org_1', annotationId: 'ann_1', replyId: 'rep_2' }

  it('withdraws the mention only of whom nothing left on the mark names', async () => {
    await onReplyDeleted({ ...input, withdrawn: ['user_dana'] })

    expect(markInboxItemsInertAnchoredOn).toHaveBeenCalledTimes(1)
    expect(markInboxItemsInertAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.mentioned'],
      anchorId: 'ann_1',
      recipientUserId: 'user_dana',
    })
  })

  it('keeps a mention the mark still makes: its row counts one less and quotes nothing, but still asks', async () => {
    // Anna's mark names Ben; Carl's deleted reply named him again.
    await onReplyDeleted({ ...input, withdrawn: [] })

    expect(markInboxItemsInertAnchoredOn).not.toHaveBeenCalled()
    expect(retractInboxOccurrenceAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.mentioned'],
      anchorId: 'ann_1',
      payloadHas: { replyId: 'rep_2' },
      clear: ['excerpt', 'mentions', 'replyId'],
      inertWhenSpent: false,
    })
  })

  it('keeps the thread’s row with the replies before it: one less, no quote, inert only when it counted only this one', async () => {
    await onReplyDeleted({ ...input, withdrawn: [] })

    expect(retractInboxOccurrenceAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.activity'],
      anchorId: 'ann_1',
      payloadHas: { replyId: 'rep_2' },
      clear: ['excerpt', 'mentions', 'replyId'],
      inertWhenSpent: true,
    })
  })

  it('never throws into the delete', async () => {
    vi.mocked(retractInboxOccurrenceAnchoredOn).mockRejectedValue(new Error('database down'))

    await expect(onReplyDeleted({ ...input, withdrawn: [] })).resolves.toBeUndefined()
  })
})

describe('onReplyEdited', () => {
  it('rewrites the quote of every row still quoting the reply, with whom it now mentions', async () => {
    const mentions = [{ targetId: 'user_ben', start: 0, length: 10 }] as never
    await onReplyEdited({
      organizationId: 'org_1',
      annotationId: 'ann_1',
      replyId: 'rep_1',
      text: '@Ben Gruber   bitte\nprüfen',
      mentions,
    })

    expect(rewriteInboxPayloadsAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.activity', 'annotation.mentioned'],
      anchorId: 'ann_1',
      payloadHas: { replyId: 'rep_1' },
      facts: { excerpt: '@Ben Gruber bitte prüfen', mentions },
    })
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})
