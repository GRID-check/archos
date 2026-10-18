/**
 * @vitest-environment node
 */
/**
 * Rewording and deleting one's own reply, driven through the TYPED CLIENT and
 * the real routes, service and inbox emitters (ADR-0055): only the document
 * reader, the repository, the wake record, who may open the document and the
 * inbox's writes are faked.
 *
 * What is pinned: only the person who wrote a reply changes it, never
 * Piloti's and never a colleague's; only while the mark is live; never once
 * Piloti took it up (it answered after it, or its wake is queued or ran); an
 * edit tells only whom it adds, withdraws whom it drops, keeps an @Piloti only
 * when the reply had one, and wakes nobody; a delete takes the rows that still
 * quote the reply with it; and both tell the room.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_me',
    organizationId: 'org_1',
    email: 'miriam@buero.at',
    name: 'Miriam Hofer',
    role: 'member',
    permissions: [],
  }),
}))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/authz/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/feature-flags')>()),
  isCollaborationEnabled: vi.fn(() => true),
}))
vi.mock('@/lib/documents/may-open', () => ({ mayOpenDocument: vi.fn(), mayWriteDocument: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({
  PERMISSION_CHECKS_AT_ONCE: 8,
  userHoldsProjectPermission: vi.fn(),
  resolveSubjectMembership: vi.fn(),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/sharing/registry', () => ({
  describeResource: () => ({ describeRef: async () => ({ title: 'Grundriss EG' }) }),
}))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/mentions/service', () => ({ enforceMentionBounds: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn().mockResolvedValue(1),
  resolveInboxItemsAnchoredOn: vi.fn().mockResolvedValue(1),
  markInboxItemsInertAnchoredOn: vi.fn().mockResolvedValue(1),
}))
vi.mock('@/lib/annotations/wake-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/annotations/wake-repository')>()),
  findWake: vi.fn(),
  listAnsweringWakes: vi.fn().mockResolvedValue([]),
  listLatestWakes: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/annotations/repository', () => ({
  AnnotationLimitReachedError: class AnnotationLimitReachedError extends Error {},
  ReplyLimitReachedError: class ReplyLimitReachedError extends Error {},
  listDocumentAnnotations: vi.fn(),
  findDocumentAnnotation: vi.fn(),
  insertDocumentAnnotations: vi.fn(),
  updateDocumentAnnotation: vi.fn(),
  deleteDocumentAnnotation: vi.fn(),
  deleteAnnotationReply: vi.fn(),
  insertAnnotationReply: vi.fn(),
  updateAnnotationReply: vi.fn(),
}))

import { AnnotationRequestError, deleteReply, editReply, replyToAnnotation } from '@/lib/annotations/client'
import {
  deleteAnnotationReply,
  findDocumentAnnotation,
  insertAnnotationReply,
  updateAnnotationReply,
  type AnnotationRecord,
} from '@/lib/annotations/repository'
import { REPLY_MARK_CLOSED_REASON, REPLY_TAKEN_UP_REASON, type MarkMention } from '@/lib/annotations/types'
import { wakeTurnId } from '@/lib/annotations/wake-ids'
import { findWake } from '@/lib/annotations/wake-repository'
import type { Document, DocumentAnnotationReplyRow, PilotiWakeRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { mayOpenDocument } from '@/lib/documents/may-open'
import { emitInboxItems, markInboxItemsInertAnchoredOn, type InboxEmission } from '@/lib/inbox/service'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'

import { POST as reply } from './[annotationId]/replies/route'
import { DELETE as remove, PATCH as patch } from './[annotationId]/replies/[replyId]/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)\/replies$/,
    method: 'POST',
    handler: reply,
    params: ['id', 'annotationId'],
  },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)\/replies\/([^/]+)$/,
    method: 'PATCH',
    handler: patch,
    params: ['id', 'annotationId', 'replyId'],
  },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)\/replies\/([^/]+)$/,
    method: 'DELETE',
    handler: remove,
    params: ['id', 'annotationId', 'replyId'],
  },
]

const run = async (path: string, init?: RequestInit) => {
  const url = new URL(path, 'https://grid.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  const params = Object.fromEntries(route.params.map((name, index) => [name, decodeURIComponent(matched[index + 1])]))
  return route.handler(new Request(url, init), { params: Promise.resolve(params) })
}

const DOC = {
  id: 'doc_1',
  organizationId: 'org_1',
  scope: 'project',
  projectId: 'proj_1',
  publishedVersionId: 'ver_2',
} as Partial<Document> as Document

const ANNA: MarkMention = { targetId: 'user_anna', display: 'Anna Berger' }
const BEN: MarkMention = { targetId: 'user_ben', display: 'Ben Gruber' }
const PILOTI: MarkMention = { targetId: 'agent:piloti', display: 'Piloti' }

const POSTED = new Date('2026-10-01T09:00:00Z')

const replyRow = (patch: Partial<DocumentAnnotationReplyRow> = {}): DocumentAnnotationReplyRow => ({
  id: 'rep_1',
  organizationId: 'org_1',
  annotationId: 'ann_1',
  authorKind: 'person',
  body: '@Anna Berger bitte prüfen',
  createdBy: 'user_me',
  createdAt: POSTED,
  addressesAgent: false,
  mentions: [ANNA],
  editedAt: null,
  ...patch,
})

const MARK: AnnotationRecord = {
  id: 'ann_1',
  organizationId: 'org_1',
  documentId: 'doc_1',
  versionId: 'ver_2',
  number: 4,
  page: 1,
  shape: 'point',
  x: 0.25,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Tür T30 fehlt im Fluchtweg',
  mentions: [],
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  dueOn: null,
  createdBy: 'user_ben',
  createdAt: new Date('2026-10-01T08:00:00Z'),
  updatedAt: new Date('2026-10-01T08:00:00Z'),
  acceptedBy: null,
  acceptedAt: null,
  closedBy: null,
  closedAt: null,
  delegatedBy: null,
  delegatedAt: null,
  carriedFromId: null,
  fassungNumber: 2,
  replies: [replyRow()],
}

const withReplies = (replies: DocumentAnnotationReplyRow[], patch: Partial<AnnotationRecord> = {}) =>
  vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, ...patch, replies })

const wake = (status: PilotiWakeRow['status']) =>
  ({ id: wakeTurnId('rep_1'), status }) as Partial<PilotiWakeRow> as PilotiWakeRow

async function rows(): Promise<InboxEmission[]> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return vi.mocked(emitInboxItems).mock.calls.flatMap(([emissions]) => emissions)
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof AnnotationRequestError ? { status: error.status, reason: error.reason } : error)
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAccessibleDocument).mockResolvedValue(DOC)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map(
      [ANNA, BEN, { targetId: 'user_me', display: 'Miriam Hofer' }].map((person) => [
        person.targetId,
        { userId: person.targetId, email: null, name: person.display, profilePictureUrl: null },
      ])
    )
  )
  vi.mocked(mayOpenDocument).mockImplementation(async (_tenant, _doc, userIds) => new Set(userIds))
  vi.mocked(findWake).mockResolvedValue(null)
  vi.mocked(deleteAnnotationReply).mockResolvedValue(true)
  vi.mocked(updateAnnotationReply).mockImplementation(async (_org, _ann, replyId, _expected, changes) =>
    replyRow({ id: replyId, ...changes, editedAt: new Date('2026-10-01T09:05:00Z') })
  )
  withReplies([replyRow()])
})

describe('rewording one’s own reply', () => {
  it('stores the new words with whom they still mention, compared against the words it read', async () => {
    vi.mocked(findDocumentAnnotation)
      .mockResolvedValueOnce({ ...MARK, replies: [replyRow()] })
      .mockResolvedValue({
        ...MARK,
        replies: [replyRow({ body: '@Ben Gruber bitte prüfen', mentions: [BEN], editedAt: new Date('2026-10-01T09:05:00Z') })],
      })

    const after = await editReply(
      'doc_1',
      'ann_1',
      'rep_1',
      { body: '@Ben Gruber bitte prüfen', mentions: [ANNA, BEN] },
      { run, peerId: 'peer_1' }
    )

    expect(updateAnnotationReply).toHaveBeenCalledWith('org_1', 'ann_1', 'rep_1', '@Anna Berger bitte prüfen', {
      body: '@Ben Gruber bitte prüfen',
      mentions: [BEN],
    })
    expect(after.replies[0]).toMatchObject({ body: '@Ben Gruber bitte prüfen', editedAt: '2026-10-01T09:05:00.000Z' })
    expect(publishToDocumentRoom).toHaveBeenCalledWith(
      'doc_1',
      expect.objectContaining({ kind: 'annotations.changed', annotationIds: ['ann_1'], change: 'updated' })
    )
  })

  it('tells only whom the edit adds, as the reply, and withdraws whom it drops', async () => {
    await editReply('doc_1', 'ann_1', 'rep_1', { body: '@Ben Gruber bitte prüfen', mentions: [BEN] }, { run })
    const emitted = await rows()

    expect(emitted.map((row) => [row.type, row.recipientUserId])).toEqual([['annotation.mentioned', 'user_ben']])
    expect(emitted[0].payload).toMatchObject({ excerpt: '@Ben Gruber bitte prüfen', replyId: 'rep_1' })
    // An edit is not a reply: the thread hears nothing new.
    expect(emitted.some((row) => row.type === 'annotation.activity')).toBe(false)
    expect(markInboxItemsInertAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.mentioned'],
      anchorId: 'ann_1',
      recipientUserId: 'user_anna',
    })
  })

  it('keeps the mentions stored when it sends none, while their names stand', async () => {
    await editReply('doc_1', 'ann_1', 'rep_1', { body: '@Anna Berger bitte bis Freitag prüfen' }, { run })

    expect(updateAnnotationReply).toHaveBeenCalledWith('org_1', 'ann_1', 'rep_1', expect.any(String), {
      body: '@Anna Berger bitte bis Freitag prüfen',
      mentions: [ANNA],
    })
    expect(await rows()).toEqual([])
    expect(markInboxItemsInertAnchoredOn).not.toHaveBeenCalled()
  })

  it('never wakes Piloti: an @Piloti added in an edit is not kept', async () => {
    await editReply('doc_1', 'ann_1', 'rep_1', { body: '@Piloti @Anna Berger bitte prüfen', mentions: [PILOTI, ANNA] }, { run })

    expect(updateAnnotationReply).toHaveBeenCalledWith('org_1', 'ann_1', 'rep_1', expect.any(String), {
      body: '@Piloti @Anna Berger bitte prüfen',
      mentions: [ANNA],
    })
    expect(insertAnnotationReply).not.toHaveBeenCalled()
  })

  it('keeps an @Piloti the reply already had, while Piloti has not taken it up', async () => {
    withReplies([replyRow({ body: '@Piloti stimmt das?', mentions: [PILOTI], addressesAgent: true })])
    // A cap held its wake: Piloti never read it.
    vi.mocked(findWake).mockResolvedValue(wake('suppressed'))

    await editReply('doc_1', 'ann_1', 'rep_1', { body: '@Piloti stimmt die Breite?', mentions: [PILOTI] }, { run })

    expect(updateAnnotationReply).toHaveBeenCalledWith('org_1', 'ann_1', 'rep_1', '@Piloti stimmt das?', {
      body: '@Piloti stimmt die Breite?',
      mentions: [PILOTI],
    })
  })

  it('is a conflict when the reply changed or went since it was read', async () => {
    vi.mocked(updateAnnotationReply).mockResolvedValue(null)

    expect(await refusal(editReply('doc_1', 'ann_1', 'rep_1', { body: 'Neu' }, { run }))).toMatchObject({ status: 409 })
  })
})

describe('deleting one’s own reply', () => {
  it('deletes it, compared against the words it read, takes its rows with it and tells the room', async () => {
    withReplies([replyRow({ mentions: [ANNA] })])

    await deleteReply('doc_1', 'ann_1', 'rep_1', { run, peerId: 'peer_1' })
    await rows()

    expect(deleteAnnotationReply).toHaveBeenCalledWith('org_1', 'ann_1', 'rep_1', '@Anna Berger bitte prüfen')
    expect(markInboxItemsInertAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.activity', 'annotation.mentioned'],
      anchorId: 'ann_1',
      payloadHas: { replyId: 'rep_1' },
    })
    // Anna was mentioned only there: her mention goes too.
    expect(markInboxItemsInertAnchoredOn).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['annotation.mentioned'], recipientUserId: 'user_anna' })
    )
    expect(publishToDocumentRoom).toHaveBeenCalledWith(
      'doc_1',
      expect.objectContaining({ annotationIds: ['ann_1'], change: 'updated' })
    )
  })

  it('is a conflict when the reply was reworded or deleted since it was read', async () => {
    vi.mocked(deleteAnnotationReply).mockResolvedValue(false)

    expect(await refusal(deleteReply('doc_1', 'ann_1', 'rep_1', { run }))).toMatchObject({ status: 409 })
  })
})

describe('who may change a reply, and when', () => {
  const both = (replyId = 'rep_1') => [
    refusal(editReply('doc_1', 'ann_1', replyId, { body: 'Neu' }, { run })),
    refusal(deleteReply('doc_1', 'ann_1', replyId, { run })),
  ]

  it('refuses a colleague’s reply', async () => {
    withReplies([replyRow({ createdBy: 'user_anna' })])

    expect(await Promise.all(both())).toEqual([
      { status: 403, reason: null },
      { status: 403, reason: null },
    ])
    expect(updateAnnotationReply).not.toHaveBeenCalled()
    expect(deleteAnnotationReply).not.toHaveBeenCalled()
  })

  it('refuses Piloti’s reply, even one posted for this person: that goes by undo', async () => {
    withReplies([replyRow({ authorKind: 'piloti', mentions: [] })])

    expect(await Promise.all(both())).toEqual([
      { status: 403, reason: null },
      { status: 403, reason: null },
    ])
  })

  it('answers 404 for a reply the thread does not have', async () => {
    expect(await Promise.all(both('rep_9'))).toEqual([
      { status: 404, reason: null },
      { status: 404, reason: null },
    ])
  })

  it('refuses on a closed mark: its thread is the record', async () => {
    withReplies([replyRow()], { status: 'resolved', closedBy: 'user_ben', closedAt: new Date() })

    expect(await Promise.all(both())).toEqual([
      { status: 422, reason: REPLY_MARK_CLOSED_REASON },
      { status: 422, reason: REPLY_MARK_CLOSED_REASON },
    ])
  })

  it('refuses a reply to Piloti that Piloti answered after', async () => {
    withReplies([
      replyRow({ body: '@Piloti stimmt das?', mentions: [PILOTI], addressesAgent: true }),
      replyRow({ id: 'rep_2', authorKind: 'piloti', body: 'Ja.', mentions: [], createdAt: new Date('2026-10-01T09:01:00Z') }),
    ])

    expect(await Promise.all(both())).toEqual([
      { status: 409, reason: REPLY_TAKEN_UP_REASON },
      { status: 409, reason: REPLY_TAKEN_UP_REASON },
    ])
    expect(findWake).not.toHaveBeenCalled()
  })

  it.each(['queued', 'started', 'answered', 'stopped'] as const)(
    'refuses a reply to Piloti whose wake is %s',
    async (status) => {
      withReplies([replyRow({ body: '@Piloti stimmt das?', mentions: [PILOTI], addressesAgent: true })])
      vi.mocked(findWake).mockResolvedValue(wake(status))

      expect(await Promise.all(both())).toEqual([
        { status: 409, reason: REPLY_TAKEN_UP_REASON },
        { status: 409, reason: REPLY_TAKEN_UP_REASON },
      ])
      expect(findWake).toHaveBeenCalledWith('org_1', wakeTurnId('rep_1'))
    }
  )

  it('refuses an answer on Piloti’s own Rückfrage once its wake ran, with no @Piloti in it', async () => {
    withReplies([replyRow({ body: 'Ja, 1,00 m.', mentions: [] })], {
      authorKind: 'piloti',
      kind: 'question',
      acceptedBy: 'user_me',
    })
    vi.mocked(findWake).mockResolvedValue(wake('answered'))

    expect((await Promise.all(both()))[0]).toEqual({ status: 409, reason: REPLY_TAKEN_UP_REASON })
  })

  it.each(['suppressed', 'refused', 'failed'] as const)(
    'lets its author change a reply to Piloti whose wake was %s: Piloti never answered it',
    async (status) => {
      withReplies([replyRow({ body: '@Piloti stimmt das?', mentions: [PILOTI], addressesAgent: true })])
      vi.mocked(findWake).mockResolvedValue(wake(status))

      await deleteReply('doc_1', 'ann_1', 'rep_1', { run })

      expect(deleteAnnotationReply).toHaveBeenCalled()
    }
  )

  it('does not ask after Piloti for a reply that was not for it, whatever Piloti wrote since', async () => {
    withReplies([
      replyRow(),
      replyRow({ id: 'rep_2', authorKind: 'piloti', body: 'Notiz', mentions: [], createdAt: new Date('2026-10-01T09:01:00Z') }),
    ])

    await editReply('doc_1', 'ann_1', 'rep_1', { body: '@Anna Berger bitte', mentions: [ANNA] }, { run })

    expect(updateAnnotationReply).toHaveBeenCalled()
    expect(findWake).not.toHaveBeenCalled()
  })
})

describe('the rows a reply writes', () => {
  it('name the reply, so deleting it finds them', async () => {
    withReplies([], { createdBy: 'user_ben' })
    vi.mocked(insertAnnotationReply).mockImplementation(
      async (input) =>
        ({ id: 'rep_new', createdAt: new Date(), editedAt: null, ...input, addressesAgent: false, mentions: input.mentions ?? [] }) as DocumentAnnotationReplyRow
    )

    await replyToAnnotation('doc_1', 'ann_1', { body: '@Anna Berger schau', mentions: [ANNA] }, { run })
    const emitted = await rows()

    expect(emitted.find((row) => row.type === 'annotation.mentioned')?.payload).toMatchObject({ replyId: 'rep_new' })
    expect(emitted.find((row) => row.type === 'annotation.activity')?.payload).toMatchObject({ replyId: 'rep_new' })
  })
})
