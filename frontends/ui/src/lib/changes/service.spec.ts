/**
 * @vitest-environment node
 */
/**
 * The change record's routes and service (ADR-0109), driven through the TYPED
 * CLIENT (ADR-0055): the card uses the same two functions, so a path, a field
 * or a refusal code the two disagreed on would fail here.
 *
 * The record's repository is an in-memory fake that keeps the undo claim a
 * compare-and-swap on `undone_at IS NULL` and holds every row to the CHECKs of
 * migration 0139. The annotations service is a fake over an in-memory set of
 * marks at its seam (`listAnnotations`, `updateAnnotation`, `createAnnotation`),
 * with `updateAnnotation`'s compare-and-swap on `expectedStatus`; its real
 * state machine (`transition`) decides which status moves have a way back.
 * What is under test is that undo reads the object first, refuses what moved
 * on, and runs the inverse through THAT service as the person clicking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const SESSION = vi.hoisted(() => ({
  userId: 'user_1',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  email: 'anna@grid.test',
  name: 'Anna Berger',
  role: 'member',
  permissions: [] as string[],
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => SESSION) }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/langfuse/decision-score', () => ({ recordDecisionScore: vi.fn(async () => undefined) }))
vi.mock('@/lib/annotations/service', async (original) => ({
  ...(await original<typeof import('@/lib/annotations/service')>()),
  listAnnotations: vi.fn(),
  updateAnnotation: vi.fn(),
  createAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  deleteReply: vi.fn(),
}))
vi.mock('@/lib/changes/repository', () => ({
  insertPilotiChanges: vi.fn(),
  listTurnChangeRows: vi.fn(),
  findPilotiChange: vi.fn(),
  claimUndo: vi.fn(),
  releaseUndo: vi.fn(),
}))

import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { createAnnotation, deleteAnnotation, deleteReply, listAnnotations, updateAnnotation } from '@/lib/annotations/service'
import type { AnnotationReplyView, AnnotationView, CreateAnnotationRequest, UpdateAnnotationRequest } from '@/lib/annotations/types'
import type { PilotiChangeRow } from '@/lib/db/schema/piloti-changes'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { DirectoryPerson } from '@/lib/sharing/types'
import { ChangeRequestError, getTurnChanges, undoChange } from './client'
import { claimUndo, findPilotiChange, listTurnChangeRows, releaseUndo } from './repository'
import { markState } from './state'

import { GET as listChanges } from '@/app/api/conversations/[id]/messages/[messageId]/changes/route'
import { POST as undo } from '@/app/api/piloti-changes/[id]/undo/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; keys: string[]; handler: Handler }> = [
  { pattern: /^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/changes$/, method: 'GET', keys: ['id', 'messageId'], handler: listChanges },
  { pattern: /^\/api\/piloti-changes\/([^/]+)\/undo$/, method: 'POST', keys: ['id'], handler: undo },
]

/** `fetch` as the browser's client calls it, answered by the route handlers. */
async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'https://grid.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(matched[index + 1])]))
  return route.handler(new Request(url, { method }), { params: Promise.resolve(params) })
}

const DOC = '11111111-1111-4111-8111-111111111111'
const HIDDEN_DOC = '22222222-2222-4222-8222-222222222222'
const MARK = '33333333-3333-4333-8333-333333333333'
const OTHER_MARK = '44444444-4444-4444-8444-444444444444'
const ANSWER = '55555555-5555-4555-8555-555555555555'
const REPLY = '66666666-6666-4666-8666-666666666666'
const CONVERSATION = 'conv_1'
const NOW = new Date('2026-10-13T08:00:00.000Z')

const change = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`

const mark = (patch: Partial<AnnotationView> = {}): AnnotationView => ({
  id: MARK,
  documentId: DOC,
  number: 4,
  page: 1,
  shape: 'point',
  x: 0.4,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Laufbreite im Treppenhaus unter 1,20 m.',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  fassungNumber: null,
  onCurrentFassung: true,
  createdBy: 'user_2',
  createdByName: 'Bernd Huber',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  delegatedBy: null,
  delegatedByName: null,
  delegatedAt: null,
  replies: [],
  canEdit: true,
  canDelete: false,
  ...patch,
})

const reply = (patch: Partial<AnnotationReplyView> = {}): AnnotationReplyView => ({
  id: REPLY,
  annotationId: MARK,
  authorKind: 'piloti',
  body: 'Ich habe es auf Mittwoch gesetzt.',
  createdBy: 'user_1',
  createdByName: 'Anna Berger',
  createdAt: NOW.toISOString(),
  addressesPiloti: false,
  ...patch,
})

/** A mark Piloti set open for user_1, the person clicking: accepted by them in the same move. */
const setOpenForAsker = (patch: Partial<AnnotationView> = {}) =>
  mark({ authorKind: 'piloti', status: 'open', createdBy: 'user_1', acceptedBy: 'user_1', canDelete: true, ...patch })

const row = (extra: Partial<PilotiChangeRow> = {}): PilotiChangeRow => ({
  id: change(1),
  organizationId: 'org_1',
  documentId: DOC,
  annotationId: MARK,
  objectKind: 'annotation',
  objectId: MARK,
  op: 'update',
  before: { status: 'open' },
  after: { status: 'resolved' },
  originConversationId: CONVERSATION,
  originMessageId: ANSWER,
  onBehalfOf: 'user_2',
  createdAt: NOW,
  undoneAt: null,
  undoneBy: null,
  ...extra,
})

/** The CHECKs of migration 0139, held against every row the fake stores. */
function assertChecks(stored: PilotiChangeRow): void {
  expect(stored.objectKind !== 'annotation_reply' || stored.op === 'create', 'piloti_changes_reply_is_created').toBe(true)
  expect(stored.objectKind !== 'annotation' || stored.objectId === stored.annotationId, 'piloti_changes_annotation_is_object').toBe(true)
  const states =
    (stored.op === 'create' && stored.before === null && stored.after !== null) ||
    (stored.op === 'update' && stored.before !== null && stored.after !== null) ||
    (stored.op === 'delete' && stored.before !== null && stored.after === null)
  expect(states, 'piloti_changes_states_by_op').toBe(true)
  expect(stored.undoneAt === null, 'piloti_changes_undo_complete').toBe(stored.undoneBy === null)
}

/** The record, in memory, with the repository's compare-and-swap. */
let changes: Map<string, PilotiChangeRow>
const put = (next: PilotiChangeRow) => {
  assertChecks(next)
  changes.set(next.id, next)
  return next
}
/** The marks, by document, as the reader sees them. */
let documents: Map<string, Map<string, AnnotationView>>
const marksOf = (documentId: string) => documents.get(documentId) ?? new Map<string, AnnotationView>()
const current = (id = MARK) => marksOf(DOC).get(id)

const person = (userId: string, name: string): DirectoryPerson => ({ userId, name, email: `${userId}@grid.test`, profilePictureUrl: null })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', serve)
  changes = new Map()
  documents = new Map([[DOC, new Map([[MARK, mark({ status: 'resolved', closedBy: 'user_1', closedAt: NOW.toISOString() })]])]])

  vi.mocked(findPilotiChange).mockImplementation(async (_org, id) => changes.get(id) ?? null)
  vi.mocked(listTurnChangeRows).mockImplementation(async (_org, conversationId, messageId) =>
    [...changes.values()]
      .filter((entry) => entry.originConversationId === conversationId && entry.originMessageId === messageId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  )
  vi.mocked(claimUndo).mockImplementation(async (_org, id, userId) => {
    const stored = changes.get(id)
    if (!stored || stored.undoneAt) return null
    return put({ ...stored, undoneAt: new Date(), undoneBy: userId })
  })
  vi.mocked(releaseUndo).mockImplementation(async (_org, claim) => {
    const stored = changes.get(claim.id)
    if (stored && stored.undoneBy === claim.undoneBy && stored.undoneAt === claim.undoneAt) {
      put({ ...stored, undoneAt: null, undoneBy: null })
    }
  })

  vi.mocked(requireResourceAccess).mockResolvedValue({} as never)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      ['user_1', person('user_1', 'Anna Berger')],
      ['user_2', person('user_2', 'Bernd Huber')],
    ])
  )
  vi.mocked(listAnnotations).mockImplementation(async (_session, documentId) => {
    if (!documents.has(documentId)) throw new NotFoundError()
    return { annotations: [...marksOf(documentId).values()], canAnnotate: true, pilotiWakes: false }
  })
  // A person's PATCH: compare-and-swap on the status the caller saw.
  vi.mocked(updateAnnotation).mockImplementation(async (_session, documentId, id, input: UpdateAnnotationRequest) => {
    const before = marksOf(documentId).get(id)
    if (!before) throw new NotFoundError()
    if (input.expectedStatus && input.expectedStatus !== before.status) throw new ConflictError('moved')
    const { expectedStatus: _, delegateToPiloti: __, ...fields } = input
    const after = { ...before, ...fields } as AnnotationView
    marksOf(documentId).set(id, after)
    return { annotation: after }
  })
  vi.mocked(deleteAnnotation).mockImplementation(async (_session, documentId, id) => {
    if (!marksOf(documentId).delete(id)) throw new NotFoundError()
    return null
  })
  // A reply goes for the person it was posted for, and only while it says what the caller saw.
  vi.mocked(deleteReply).mockImplementation(async (session, documentId, id, replyId, options) => {
    const held = marksOf(documentId).get(id)
    const found = held?.replies.find((candidate) => candidate.id === replyId)
    if (!held || !found) throw new NotFoundError()
    if (found.createdBy !== session.userId) throw new ForbiddenError()
    if (options?.expectedBody !== undefined && options.expectedBody !== found.body) throw new ConflictError('moved')
    marksOf(documentId).set(id, { ...held, replies: held.replies.filter((candidate) => candidate.id !== replyId) })
    return null
  })
  vi.mocked(createAnnotation).mockImplementation(async (_session, documentId, input: CreateAnnotationRequest) => {
    const created = mark({ ...input, id: OTHER_MARK, number: 9, createdBy: SESSION.userId, status: 'open' } as Partial<AnnotationView>)
    marksOf(documentId).set(created.id, created)
    return { annotation: created }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/conversations/[id]/messages/[messageId]/changes', () => {
  it('reads what the turn changed, oldest first, as it stands now, with names, numbers and canUndo', async () => {
    put(row({ id: change(2), createdAt: new Date(NOW.getTime() + 1000) }))
    put(row({ id: change(1), op: 'create', before: null, after: markState(mark({ status: 'open' })), createdAt: NOW }))

    const { changes: read } = await getTurnChanges(CONVERSATION, ANSWER)

    expect(read.map((entry) => entry.id)).toEqual([change(1), change(2)])
    expect(read[1]).toEqual({
      id: change(2),
      documentId: DOC,
      annotationId: MARK,
      annotationNumber: 4,
      objectKind: 'annotation',
      objectId: MARK,
      op: 'update',
      before: { status: 'open' },
      after: { status: 'resolved' },
      onBehalfOf: 'user_2',
      onBehalfOfName: 'Bernd Huber',
      createdAt: NOW.toISOString().replace('08:00:00', '08:00:01'),
      undoneAt: null,
      undoneBy: null,
      undoneByName: null,
      canUndo: true,
    })
    // A mark Piloti set open for the asker has moved on here (it is resolved now), so there is nothing to undo.
    expect(read[0].canUndo).toBe(false)
    expect(requireResourceAccess).toHaveBeenCalledWith(SESSION, 'conversation', CONVERSATION, 'viewer')
    expect(listTurnChangeRows).toHaveBeenCalledWith('org_1', CONVERSATION, ANSWER)
  })

  it('leaves out changes on a document the reader may not see', async () => {
    put(row({ id: change(1) }))
    put(row({ id: change(2), documentId: HIDDEN_DOC }))

    const { changes: read } = await getTurnChanges(CONVERSATION, ANSWER)

    expect(read.map((entry) => entry.id)).toEqual([change(1)])
    expect(listAnnotations).toHaveBeenCalledWith(SESSION, HIDDEN_DOC)
  })

  it('names no number for a mark that is gone, offers undo of a reply while it stands, and none to a reader who may not edit', async () => {
    put(row({ id: change(1), op: 'delete', before: markState(mark()), after: null, annotationId: OTHER_MARK, objectId: OTHER_MARK }))
    put(row({ id: change(2), objectKind: 'annotation_reply', objectId: REPLY, op: 'create', before: null, after: { body: reply().body } }))
    documents.get(DOC)?.set(MARK, mark({ replies: [reply()] }))

    const first = await getTurnChanges(CONVERSATION, ANSWER)
    expect(first.changes.map((entry) => [entry.annotationNumber, entry.canUndo])).toEqual([
      [null, true],
      [4, true],
    ])

    vi.mocked(listAnnotations).mockImplementation(async () => ({
      annotations: [...marksOf(DOC).values()].map((entry) => ({ ...entry, canEdit: false })),
      canAnnotate: false,
      pilotiWakes: false,
    }))
    put(row({ id: change(3) }))
    const readOnly = await getTurnChanges(CONVERSATION, ANSWER)
    expect(readOnly.changes.every((entry) => !entry.canUndo)).toBe(true)
  })

  it('is a 404 to a reader without the conversation, and a 400 for an id that is no answer id', async () => {
    vi.mocked(requireResourceAccess).mockRejectedValueOnce(new NotFoundError())
    await expect(getTurnChanges(CONVERSATION, ANSWER)).rejects.toMatchObject({ status: 404 })
    await expect(getTurnChanges(CONVERSATION, 'msg_1')).rejects.toMatchObject({ status: 400 })
    expect(listTurnChangeRows).toHaveBeenCalledTimes(0)
  })
})

describe('POST /api/piloti-changes/[id]/undo', () => {
  it('reverts a change through the annotations service, as the person clicking, naming the status Piloti left', async () => {
    put(row())

    const { change: undone } = await undoChange(change(1))

    expect(updateAnnotation).toHaveBeenCalledWith(SESSION, DOC, MARK, { status: 'open', expectedStatus: 'resolved' })
    expect(current()?.status).toBe('open')
    expect(undone).toMatchObject({ id: change(1), undoneBy: 'user_1', undoneByName: 'Anna Berger', canUndo: false })
    expect(undone.undoneAt).not.toBeNull()
    expect(recordDecisionScore).toHaveBeenCalledWith({
      organizationId: 'org_1',
      subject: 'change',
      subjectId: change(1),
      decision: 'undone',
      decidedBy: 'user_1',
      origin: { conversationId: CONVERSATION, messageId: ANSWER },
    })
  })

  it('puts back the assignee and the wording a change moved', async () => {
    documents.get(DOC)?.set(MARK, mark({ assigneeUserId: 'user_2', body: 'Neu' }))
    put(row({ before: { assigneeUserId: null, body: 'Alt' }, after: { assigneeUserId: 'user_2', body: 'Neu' } }))

    await undoChange(change(1))

    expect(updateAnnotation).toHaveBeenCalledWith(SESSION, DOC, MARK, { assigneeUserId: null, body: 'Alt', expectedStatus: 'open' })
    expect(current()).toMatchObject({ assigneeUserId: null, body: 'Alt' })
  })

  it('dismisses a mark Piloti proposed, which is how a proposal is taken back', async () => {
    const proposed = mark({ authorKind: 'piloti', status: 'proposed' })
    documents.get(DOC)?.set(MARK, proposed)
    put(row({ op: 'create', before: null, after: markState(proposed) }))

    await undoChange(change(1))

    expect(updateAnnotation).toHaveBeenCalledWith(SESSION, DOC, MARK, { status: 'dismissed', expectedStatus: 'proposed' })
  })

  it('sets a deleted mark again, resolved again if it was', async () => {
    const deleted = mark({ id: OTHER_MARK, status: 'resolved', kind: 'question', dueOn: '2026-10-20' })
    put(row({ annotationId: OTHER_MARK, objectId: OTHER_MARK, op: 'delete', before: markState(deleted), after: null }))
    documents.get(DOC)?.delete(OTHER_MARK)

    await undoChange(change(1))

    expect(createAnnotation).toHaveBeenCalledWith(SESSION, DOC, {
      kind: 'question',
      body: deleted.body,
      basis: null,
      assigneeUserId: null,
      dueOn: '2026-10-20',
      page: 1,
      shape: 'point',
      x: 0.4,
      y: 0.5,
      w: null,
      h: null,
    })
    expect(updateAnnotation).toHaveBeenCalledWith(SESSION, DOC, OTHER_MARK, { status: 'resolved', expectedStatus: 'open' })
  })

  it("refuses `moved-on` when a colleague changed the mark since, and changes nothing", async () => {
    // Piloti reworded it; a colleague reworded it again.
    documents.get(DOC)?.set(MARK, mark({ body: 'Anders' }))
    put(row({ before: { body: 'Alt' }, after: { body: 'Neu' } }))

    const refusal = await undoChange(change(1)).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(ChangeRequestError)
    expect(refusal).toMatchObject({ status: 409, code: 'moved-on' })
    expect((refusal as Error).message).not.toMatch(/^Request failed/)
    expect(updateAnnotation).not.toHaveBeenCalled()
    expect(changes.get(change(1))?.undoneAt).toBeNull()
  })

  it('refuses `moved-on`, and gives the claim back, when the mark moves between the read and the write', async () => {
    put(row())
    vi.mocked(updateAnnotation).mockRejectedValueOnce(new ConflictError('moved'))

    await expect(undoChange(change(1))).rejects.toMatchObject({ status: 409, code: 'moved-on' })
    expect(changes.get(change(1))).toMatchObject({ undoneAt: null, undoneBy: null })
    expect(recordDecisionScore).not.toHaveBeenCalled()
  })

  it('refuses `moved-on` for a status Piloti moved that has no way back, and for a reply that is gone', async () => {
    documents.get(DOC)?.set(MARK, mark({ status: 'open', authorKind: 'piloti', acceptedBy: 'user_2' }))
    put(row({ id: change(1), before: { status: 'proposed' }, after: { status: 'open' } }))
    put(row({ id: change(2), objectKind: 'annotation_reply', objectId: REPLY, op: 'create', before: null, after: { body: 'Ja.' } }))

    for (const id of [change(1), change(2)]) {
      await expect(undoChange(id)).rejects.toMatchObject({ status: 409, code: 'moved-on' })
    }
    expect(updateAnnotation).not.toHaveBeenCalled()
    expect(deleteReply).not.toHaveBeenCalled()
  })

  it('scores `change undone` once for a change, and not for a proposal, whose dismissal the annotations service scores', async () => {
    const proposed = mark({ authorKind: 'piloti', status: 'proposed' })
    documents.get(DOC)?.set(MARK, proposed)
    put(row({ op: 'create', before: null, after: markState(proposed) }))
    await undoChange(change(1))
    // The service's `annotation dismissed` is the one score of that decision.
    expect(recordDecisionScore).not.toHaveBeenCalled()

    put(row({ id: change(2) }))
    documents.get(DOC)?.set(MARK, mark({ status: 'resolved' }))
    await undoChange(change(2))
    expect(recordDecisionScore).toHaveBeenCalledTimes(1)
  })

  describe('a mark Piloti set open for the asker', () => {
    const setUp = (patch: Partial<AnnotationView> = {}) => {
      const open = setOpenForAsker(patch)
      documents.get(DOC)?.set(MARK, open)
      put(row({ op: 'create', before: null, after: markState(open) }))
    }

    it('is deleted, as the person it was set for, and scored', async () => {
      setUp()

      const { change: undone } = await undoChange(change(1))

      expect(deleteAnnotation).toHaveBeenCalledWith(SESSION, DOC, MARK)
      expect(current()).toBeUndefined()
      expect(updateAnnotation).not.toHaveBeenCalled()
      expect(undone).toMatchObject({ undoneBy: 'user_1', annotationNumber: null, canUndo: false })
      expect(recordDecisionScore).toHaveBeenCalledWith(expect.objectContaining({ subject: 'change', decision: 'undone' }))
    })

    it('is offered undo to that person, and not to another member, who gets a 403', async () => {
      setUp()
      expect((await getTurnChanges(CONVERSATION, ANSWER)).changes[0].canUndo).toBe(true)

      documents.get(DOC)?.set(MARK, setOpenForAsker({ canDelete: false }))
      expect((await getTurnChanges(CONVERSATION, ANSWER)).changes[0].canUndo).toBe(false)
      await expect(undoChange(change(1))).rejects.toMatchObject({ status: 403 })
      expect(claimUndo).not.toHaveBeenCalled()
    })

    it('refuses `moved-on` once the mark moved on: resolved, reworded or reassigned', async () => {
      setUp()
      for (const patch of [{ status: 'resolved' as const }, { body: 'Anders' }, { assigneeUserId: 'user_2' }]) {
        documents.get(DOC)?.set(MARK, setOpenForAsker(patch))
        await expect(undoChange(change(1))).rejects.toMatchObject({ status: 409, code: 'moved-on' })
      }
      expect(deleteAnnotation).not.toHaveBeenCalled()
      expect(changes.get(change(1))?.undoneAt).toBeNull()
    })

    it('refuses `moved-on` when somebody besides Piloti answered in the thread, so their answer is not deleted with it', async () => {
      setUp({ replies: [reply({ id: 'r1' }), reply({ id: 'r2', authorKind: 'person', createdBy: 'user_2' })] })

      const refusal = await undoChange(change(1)).catch((error: unknown) => error)

      expect(refusal).toMatchObject({ status: 409, code: 'moved-on' })
      expect((refusal as Error).message).toMatch(/answered/)
      expect(deleteAnnotation).not.toHaveBeenCalled()
    })

    it("still deletes when only Piloti's own notes are in the thread", async () => {
      setUp({ replies: [reply({ id: 'r1' })] })
      await undoChange(change(1))
      expect(deleteAnnotation).toHaveBeenCalledTimes(1)
    })
  })

  describe('a reply Piloti posted', () => {
    const setUp = (replies: AnnotationReplyView[] = [reply()]) => {
      documents.get(DOC)?.set(MARK, mark({ replies }))
      put(row({ objectKind: 'annotation_reply', objectId: REPLY, op: 'create', before: null, after: { body: reply().body } }))
    }

    it('is deleted while it still says what Piloti wrote, as the person it was posted for, and scored', async () => {
      setUp([reply({ id: 'r0', body: 'Davor' }), reply()])

      const { change: undone } = await undoChange(change(1))

      expect(deleteReply).toHaveBeenCalledWith(SESSION, DOC, MARK, REPLY, { expectedBody: reply().body })
      expect(current()?.replies.map((entry) => entry.id)).toEqual(['r0'])
      expect(undone).toMatchObject({ objectKind: 'annotation_reply', undoneBy: 'user_1', canUndo: false })
      expect(recordDecisionScore).toHaveBeenCalledWith(expect.objectContaining({ subject: 'change', decision: 'undone' }))
    })

    it('refuses `moved-on` when the reply says something else now, or is gone', async () => {
      setUp([reply({ body: 'Geändert' })])
      await expect(undoChange(change(1))).rejects.toMatchObject({ status: 409, code: 'moved-on' })

      setUp([])
      await expect(undoChange(change(1))).rejects.toMatchObject({ status: 409, code: 'moved-on' })
      expect(deleteReply).not.toHaveBeenCalled()
    })

    it('gives the claim back when the reply changes between the read and the delete', async () => {
      setUp()
      vi.mocked(deleteReply).mockRejectedValueOnce(new ConflictError('moved'))

      await expect(undoChange(change(1))).rejects.toMatchObject({ status: 409, code: 'moved-on' })
      expect(changes.get(change(1))).toMatchObject({ undoneAt: null, undoneBy: null })
      expect(recordDecisionScore).not.toHaveBeenCalled()
    })

    it('is a 403 to a person it was not posted for, before anything is claimed', async () => {
      setUp([reply({ createdBy: 'user_2' })])

      expect((await getTurnChanges(CONVERSATION, ANSWER)).changes[0].canUndo).toBe(false)
      await expect(undoChange(change(1))).rejects.toMatchObject({ status: 403 })
      expect(claimUndo).not.toHaveBeenCalled()
    })
  })

  it('refuses `already-undone` the second time', async () => {
    put(row())
    await undoChange(change(1))
    await expect(undoChange(change(1))).rejects.toMatchObject({ status: 409, code: 'already-undone' })
    expect(updateAnnotation).toHaveBeenCalledTimes(1)
  })

  it('lets one of two undos at the same moment through, and refuses the other', async () => {
    put(row())

    const outcomes = await Promise.allSettled([undoChange(change(1)), undoChange(change(1))])

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    expect(updateAnnotation).toHaveBeenCalledTimes(1)
    expect(current()?.status).toBe('open')
  })

  it('is a 403 to a reader who may not edit the mark, before anything is claimed', async () => {
    documents.get(DOC)?.set(MARK, mark({ status: 'resolved', canEdit: false }))
    put(row())

    await expect(undoChange(change(1))).rejects.toMatchObject({ status: 403 })
    expect(claimUndo).not.toHaveBeenCalled()
  })

  it('is a 404 for a change in a conversation or on a document the reader cannot see, and for an unknown id', async () => {
    put(row())
    vi.mocked(requireResourceAccess).mockRejectedValueOnce(new NotFoundError())
    await expect(undoChange(change(1))).rejects.toMatchObject({ status: 404 })

    put(row({ id: change(2), documentId: HIDDEN_DOC }))
    await expect(undoChange(change(2))).rejects.toMatchObject({ status: 404 })

    await expect(undoChange(change(7))).rejects.toMatchObject({ status: 404 })
    await expect(undoChange('not-a-uuid')).rejects.toMatchObject({ status: 404 })
    expect(claimUndo).not.toHaveBeenCalled()
  })
})
