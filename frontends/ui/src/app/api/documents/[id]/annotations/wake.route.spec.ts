/**
 * @vitest-environment node
 */
/**
 * The writes that wake Piloti (ADR-0106), driven through the TYPED CLIENT and
 * the real routes and service: a reply that addresses Piloti, a reply on
 * Piloti's open question, and a delegation enqueue exactly one wake, in the
 * write's own transaction; a reply Piloti wrote, a reply to people, and a
 * reader's refused write enqueue none; the organization's switch off answers
 * `wake: 'off'`, and the browser keeps asking Piloti itself.
 *
 * The repository is a fake that runs the write's transaction hook with a
 * transaction handle, which is how the test sees that the wake rides IN the
 * write's transaction. That a rolled-back write leaves no wake is held against
 * a real database in `lib/annotations/repository.integration.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'a@grid.test',
  name: 'Anna Berger',
  role: 'member',
  permissions: [] as string[],
  featureFlags: ['piloti-wakes'] as string[] | null,
}

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => session) }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({ canUserAccessProject: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn().mockResolvedValue(new Map()) }))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/annotations/wake-repository', () => ({ countWakes: vi.fn(), insertWake: vi.fn() }))
vi.mock('@/lib/annotations/repository', () => ({
  AnnotationLimitReachedError: class AnnotationLimitReachedError extends Error {},
  ReplyLimitReachedError: class ReplyLimitReachedError extends Error {},
  listDocumentAnnotations: vi.fn(),
  findDocumentAnnotation: vi.fn(),
  insertDocumentAnnotations: vi.fn(),
  updateDocumentAnnotation: vi.fn(),
  deleteDocumentAnnotation: vi.fn(),
  insertAnnotationReply: vi.fn(),
}))

import { ForbiddenError } from '@/lib/api/errors'
import { listAnnotations, replyToAnnotation, updateAnnotationWithWake } from '@/lib/annotations/client'
import {
  findDocumentAnnotation,
  insertAnnotationReply,
  listDocumentAnnotations,
  updateDocumentAnnotation,
  type AnnotationRecord,
} from '@/lib/annotations/repository'
import { countWakes, insertWake } from '@/lib/annotations/wake-repository'
import { delegationEventId, wakeTurnId } from '@/lib/annotations/wake-ids'
import { recordAuditEvent } from '@/lib/audit/service'
import type { DbTransaction } from '@/lib/db/executor'
import type { Document, DocumentAnnotationReplyRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'

import { GET as list } from './route'
import { PATCH as patch } from './[annotationId]/route'
import { POST as reply } from './[annotationId]/replies/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'GET', handler: list, params: ['id'] },
  { pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/, method: 'PATCH', handler: patch, params: ['id', 'annotationId'] },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)\/replies$/,
    method: 'POST',
    handler: reply,
    params: ['id', 'annotationId'],
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

const DOC_ID = '11111111-1111-4111-8111-111111111111'
const MARK_ID = '22222222-2222-4222-8222-222222222222'
const REPLY_ID = '33333333-3333-4333-8333-333333333333'

const DOC = { id: DOC_ID, organizationId: 'org_1', scope: 'project', projectId: 'proj_1', publishedVersionId: null } as Partial<Document> as Document

const MARK: AnnotationRecord = {
  id: MARK_ID,
  organizationId: 'org_1',
  documentId: DOC_ID,
  versionId: null,
  number: 4,
  page: 1,
  shape: 'point',
  x: 0.4,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Türbreite prüfen',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: 'user_2',
  dueOn: null,
  createdBy: 'user_2',
  createdAt: new Date('2026-10-13T08:00:00Z'),
  updatedAt: new Date('2026-10-13T08:00:00Z'),
  acceptedBy: null,
  acceptedAt: null,
  closedBy: null,
  closedAt: null,
  delegatedBy: null,
  delegatedAt: null,
  fassungNumber: null,
  replies: [],
}

/** The transaction the fake repository runs a write's hook in. */
const TX = { transaction: 'of the write' } as unknown as DbTransaction

let writable = true
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('REQUIRE_AUTH', 'true')
  session.featureFlags = ['piloti-wakes']
  writable = true
  vi.mocked(getAccessibleDocument).mockImplementation(async (_session, _id, intent) => {
    if (intent === 'write' && !writable) throw new ForbiddenError()
    return DOC
  })
  vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
  vi.mocked(listDocumentAnnotations).mockResolvedValue([MARK])
  vi.mocked(countWakes).mockResolvedValue(0)
  vi.mocked(insertWake).mockResolvedValue(true)
  vi.mocked(enqueueJob).mockResolvedValue({ jobId: 'job' })
  vi.mocked(insertAnnotationReply).mockImplementation(async (input, afterInsert) => {
    const { handBack: _handBack, ...values } = input
    const row: DocumentAnnotationReplyRow = {
      id: REPLY_ID,
      createdAt: new Date(),
      ...values,
      addressesAgent: values.addressesAgent ?? false,
    }
    await afterInsert?.(TX, row)
    return row
  })
  vi.mocked(updateDocumentAnnotation).mockImplementation(async (_org, _doc, _id, _expected, changes, afterUpdate) => {
    const { transition, delegation, ...fields } = changes
    const row = { ...MARK, ...fields, ...(transition ?? {}), ...(delegation ?? {}) }
    await afterUpdate?.(TX, row)
    return row
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('a reply that wakes Piloti', () => {
  it('enqueues exactly one wake, in the reply’s transaction, under the id of the reply, and says the server answers', async () => {
    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Stimmt das?', addressesPiloti: true }, { run })

    expect(result.wake).toBe('queued')
    expect(result.replyId).toBe(REPLY_ID)
    expect(insertAnnotationReply).toHaveBeenCalledWith(
      expect.objectContaining({ addressesAgent: true, authorKind: 'person' }),
      expect.any(Function)
    )
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    const [job, executor] = vi.mocked(enqueueJob).mock.calls[0]
    expect(executor).toBe(TX)
    expect(job).toMatchObject({
      kind: 'piloti_wake',
      organizationId: 'org_1',
      jobId: wakeTurnId(REPLY_ID),
      payload: {
        wakeId: wakeTurnId(REPLY_ID),
        trigger: 'thread_mention',
        eventId: REPLY_ID,
        documentId: DOC_ID,
        annotationId: MARK_ID,
        actor: { userId: 'user_1', email: 'a@grid.test' },
      },
    })
    expect(insertWake).toHaveBeenCalledWith(TX, expect.objectContaining({ id: wakeTurnId(REPLY_ID), status: 'queued' }))
  })

  it('wakes Piloti for a reply on its own open question, without an @', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, authorKind: 'piloti', kind: 'question', status: 'proposed' })

    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: '1,20 m.' }, { run })

    expect(result.wake).toBe('queued')
    expect(vi.mocked(enqueueJob).mock.calls[0][0].payload).toMatchObject({ trigger: 'thread_reply' })
  })

  it('enqueues nothing for a reply to people on a person’s mark', async () => {
    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Erledige ich.' }, { run })

    expect(result.wake).toBe('none')
    expect(vi.mocked(insertAnnotationReply).mock.calls[0][1]).toBeUndefined()
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(insertWake).not.toHaveBeenCalled()
  })

  it('refuses a reader: a person who may not write the document cannot wake Piloti on it', async () => {
    writable = false

    await expect(
      replyToAnnotation(DOC_ID, MARK_ID, { body: 'Stimmt das?', addressesPiloti: true }, { run })
    ).rejects.toMatchObject({ status: 403 })
    expect(insertAnnotationReply).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('answers `off` and enqueues nothing while the organization’s switch is off', async () => {
    session.featureFlags = []

    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Stimmt das?', addressesPiloti: true }, { run })

    expect(result.wake).toBe('off')
    // The reply still says it addressed Piloti: the browser asks it under the reply's turn id.
    expect(insertAnnotationReply).toHaveBeenCalledWith(expect.objectContaining({ addressesAgent: true }), undefined)
    expect(enqueueJob).not.toHaveBeenCalled()
    await expect(listAnnotations(DOC_ID, run)).resolves.toMatchObject({ pilotiWakes: false })
  })

  it('answers `suppressed` when a cap holds the wake, records it, and puts it in the audit trail', async () => {
    vi.mocked(countWakes).mockImplementation(async (_tx, query) => (query.annotationId ? 6 : 0))

    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Stimmt das?', addressesPiloti: true }, { run })

    expect(result.wake).toBe('suppressed')
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(insertWake).toHaveBeenCalledWith(TX, expect.objectContaining({ status: 'suppressed', reason: 'cap:mark-hour' }))
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'piloti.wake.suppressed',
        targetId: MARK_ID,
        metadata: expect.objectContaining({ reason: 'cap:mark-hour', stage: 'enqueue', status: 'suppressed' }),
      })
    )
  })
})

describe('a delegation to Piloti', () => {
  it('keeps the assignee, records who delegated, and enqueues one wake in the change’s transaction', async () => {
    const result = await updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: true }, { run })

    expect(result.wake).toBe('queued')
    const changes = vi.mocked(updateDocumentAnnotation).mock.calls[0][4]
    expect(changes.delegation).toEqual({ delegatedBy: 'user_1', delegatedAt: expect.any(Date) })
    expect(changes).not.toHaveProperty('assigneeUserId')
    const delegatedAt = changes.delegation?.delegatedAt as Date
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enqueueJob).mock.calls[0][1]).toBe(TX)
    expect(vi.mocked(enqueueJob).mock.calls[0][0].payload).toMatchObject({
      trigger: 'assigned',
      eventId: delegationEventId(MARK_ID, delegatedAt),
    })
  })

  it('is not a second event when the mark is already delegated', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_1', delegatedAt: new Date() })

    const result = await updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: true }, { run })

    expect(result.wake).toBeUndefined()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('takes the work back without waking Piloti', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_1', delegatedAt: new Date() })

    await updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: false }, { run })

    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][4].delegation).toEqual({ delegatedBy: null, delegatedAt: null })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('is refused on a mark that is not open, and while the switch is off', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, authorKind: 'piloti', status: 'proposed' })
    await expect(updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: true }, { run })).rejects.toMatchObject({
      status: 422,
    })

    vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
    session.featureFlags = []
    await expect(updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: true }, { run })).rejects.toMatchObject({
      status: 403,
    })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('never wakes Piloti when a person takes over or dismisses its proposal', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, authorKind: 'piloti', kind: 'question', status: 'proposed' })

    await updateAnnotationWithWake(DOC_ID, MARK_ID, { status: 'open' }, { run })
    await updateAnnotationWithWake(DOC_ID, MARK_ID, { status: 'dismissed' }, { run })

    expect(vi.mocked(updateDocumentAnnotation).mock.calls.every((call) => call[5] === undefined)).toBe(true)
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('ends with the mark: resolving a delegated mark clears the delegation', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_1', delegatedAt: new Date() })

    await updateAnnotationWithWake(DOC_ID, MARK_ID, { status: 'resolved' }, { run })

    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][4].delegation).toEqual({ delegatedBy: null, delegatedAt: null })
  })
})
