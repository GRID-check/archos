/**
 * @vitest-environment node
 */
/**
 * The Anmerkungen routes and their service, driven through the TYPED CLIENT
 * (ADR-0055): the browser uses the same functions, so a path or a field the two
 * disagreed on would fail here.
 *
 * The document reader, the repository and the room are mocked; what is under
 * test is the service's rules between them: access follows the document, a
 * read-only reader gets the list without the controls, the Fassung a mark was
 * set on decides whether it is drawn, a region stays on its page, a proposal
 * becomes the office's only by a person, a status move carries its
 * bookkeeping and loses to a colleague's earlier move, only the person who set
 * a mark deletes it, and every write tells the room.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'a@grid.test',
    name: 'Anna Berger',
    role: 'member',
    permissions: [],
  }),
}))

vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({ canUserAccessProject: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/annotations/room', () => ({ publishToRoom: vi.fn().mockResolvedValue(undefined) }))
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

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import {
  AnnotationRequestError,
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  replyToAnnotation,
  updateAnnotation,
} from '@/lib/annotations/client'
import {
  AnnotationLimitReachedError,
  deleteDocumentAnnotation,
  findDocumentAnnotation,
  insertAnnotationReply,
  insertDocumentAnnotations,
  listDocumentAnnotations,
  updateDocumentAnnotation,
  type AnnotationRecord,
} from '@/lib/annotations/repository'
import { publishToRoom } from '@/lib/annotations/room'
import { canUserAccessProject } from '@/lib/authz/project-membership'
import type { Document } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'

import { GET as list, POST as create } from './route'
import { DELETE as remove, PATCH as patch } from './[annotationId]/route'
import { POST as reply } from './[annotationId]/replies/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'GET', handler: list, params: ['id'] },
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'POST', handler: create, params: ['id'] },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/,
    method: 'PATCH',
    handler: patch,
    params: ['id', 'annotationId'],
  },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/,
    method: 'DELETE',
    handler: remove,
    params: ['id', 'annotationId'],
  },
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

const DOC = {
  id: 'doc_1',
  organizationId: 'org_1',
  scope: 'project',
  projectId: 'proj_1',
  publishedVersionId: 'ver_2',
} as Partial<Document> as Document

const RECORD: AnnotationRecord = {
  id: 'ann_1',
  organizationId: 'org_1',
  documentId: 'doc_1',
  versionId: 'ver_2',
  number: 1,
  page: 3,
  shape: 'point',
  x: 0.25,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Tür T30 fehlt im Fluchtweg',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  dueOn: null,
  createdBy: 'user_1',
  createdAt: new Date('2026-10-01T08:00:00Z'),
  updatedAt: new Date('2026-10-01T08:00:00Z'),
  acceptedBy: null,
  acceptedAt: null,
  closedBy: null,
  closedAt: null,
  fassungNumber: 2,
  replies: [],
}

const PROPOSAL: AnnotationRecord = {
  ...RECORD,
  id: 'ann_p',
  authorKind: 'piloti',
  status: 'proposed',
  shape: 'region',
  w: 0.2,
  h: 0.1,
  basis: 'OIB-RL 2, Pkt. 3.5.2',
}

let writable = true
beforeEach(() => {
  vi.clearAllMocks()
  writable = true
  vi.mocked(getAccessibleDocument).mockImplementation(async (_session, _id, intent) => {
    if (intent === 'write' && !writable) throw new ForbiddenError()
    return DOC
  })
  vi.mocked(findDocumentAnnotation).mockResolvedValue(RECORD)
  vi.mocked(insertDocumentAnnotations).mockResolvedValue([RECORD])
  vi.mocked(updateDocumentAnnotation).mockResolvedValue(RECORD)
  vi.mocked(deleteDocumentAnnotation).mockResolvedValue(true)
  vi.mocked(insertAnnotationReply).mockResolvedValue({
    id: 'rep_1',
    organizationId: 'org_1',
    annotationId: 'ann_1',
    authorKind: 'person',
    body: 'x',
    createdBy: 'user_1',
    createdAt: new Date(),
  })
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      ['user_1', { userId: 'user_1', email: null, name: 'Anna Berger', profilePictureUrl: null }],
      ['user_in', { userId: 'user_in', email: null, name: 'Jakob Huber', profilePictureUrl: null }],
    ])
  )
})

describe('GET /api/documents/[id]/annotations', () => {
  it('lists live ones first, by page, and says which were set on an earlier Fassung', async () => {
    vi.mocked(listDocumentAnnotations).mockResolvedValue([
      { ...RECORD, id: 'a', number: 1, status: 'resolved', closedBy: 'user_2', closedAt: new Date() },
      { ...RECORD, id: 'b', number: 2, page: 4, versionId: 'ver_1', fassungNumber: 1 },
      { ...PROPOSAL, id: 'c', number: 3, page: 3 },
    ])

    const result = await listAnnotations('doc_1', run)

    expect(result.canAnnotate).toBe(true)
    expect(result.annotations.map((a) => a.id)).toEqual(['c', 'b', 'a'])
    expect(result.annotations.map((a) => a.onCurrentFassung)).toEqual([true, false, true])
    expect(result.annotations[0]).toMatchObject({
      shape: 'region',
      w: 0.2,
      authorKind: 'piloti',
      createdByName: 'Anna Berger',
    })
  })

  it('gives a reader who may not write the list without the controls', async () => {
    writable = false
    vi.mocked(listDocumentAnnotations).mockResolvedValue([RECORD])

    const result = await listAnnotations('doc_1', run)

    expect(result.canAnnotate).toBe(false)
    expect(result.annotations[0]).toMatchObject({ canEdit: false, canDelete: false })
  })

  it('lists them without names when the directory cannot be read', async () => {
    vi.mocked(listDocumentAnnotations).mockResolvedValue([{ ...RECORD, assigneeUserId: 'user_in' }])
    vi.mocked(loadOrganizationDirectory).mockRejectedValue(new Error('WorkOS down'))

    const result = await listAnnotations('doc_1', run)

    expect(result.annotations[0]).toMatchObject({ assigneeName: null, createdByName: null })
  })

  it('is not found for a document the reader cannot read', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())

    await expect(listAnnotations('doc_x', run)).rejects.toMatchObject({ status: 404 })
    expect(listDocumentAnnotations).not.toHaveBeenCalled()
  })

  it('carries none on a chat attachment', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue({ ...DOC, scope: 'session' } as Document)

    await expect(listAnnotations('doc_1', run)).resolves.toEqual({ annotations: [], canAnnotate: false })
  })
})

describe('POST /api/documents/[id]/annotations', () => {
  it('sets a region on the Fassung shown now, as a person, and tells the room which tab did it', async () => {
    await createAnnotation(
      'doc_1',
      { page: 3, shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.2, kind: 'defect', body: '  Brüstung zu niedrig  ' },
      { peerId: 'peer_abcdef12', run }
    )

    expect(insertDocumentAnnotations).toHaveBeenCalledWith({
      organizationId: 'org_1',
      documentId: 'doc_1',
      versionId: 'ver_2',
      authorKind: 'person',
      createdBy: 'user_1',
      marks: [expect.objectContaining({ shape: 'region', w: 0.3, h: 0.2, body: 'Brüstung zu niedrig', basis: null })],
    })
    expect(publishToRoom).toHaveBeenCalledWith('doc_1', {
      kind: 'annotations.changed',
      annotationIds: ['ann_1'],
      change: 'created',
      actor: { peerId: 'peer_abcdef12', userId: 'user_1', name: 'Anna Berger', kind: 'person' },
    })
  })

  it('refuses a point with a size, a region off its page, an empty body and a bad date before reading anything', async () => {
    for (const input of [
      { page: 1, shape: 'point', x: 0.2, y: 0.5, w: 0.1, h: 0.1, kind: 'hint', body: 'x' },
      { page: 1, shape: 'region', x: 0.8, y: 0.5, w: 0.3, h: 0.1, kind: 'hint', body: 'x' },
      { page: 1, shape: 'region', x: 0.2, y: 0.5, kind: 'hint', body: 'x' },
      { page: 1, shape: 'point', x: 0.2, y: 0.5, kind: 'hint', body: '   ' },
      { page: 1, shape: 'point', x: 0.2, y: 0.5, kind: 'hint', body: 'x', dueOn: '14.10.2026' },
    ]) {
      await expect(createAnnotation('doc_1', input as never, { run })).rejects.toMatchObject({ status: 400 })
    }
    expect(getAccessibleDocument).not.toHaveBeenCalled()
  })

  it('is refused to a reader who may not write in the folder', async () => {
    writable = false

    await expect(
      createAnnotation('doc_1', { page: 1, shape: 'point', x: 0.1, y: 0.1, kind: 'hint', body: 'x' }, { run })
    ).rejects.toMatchObject({ status: 403 })
    expect(insertDocumentAnnotations).not.toHaveBeenCalled()
  })

  it('refuses an assignee who cannot open the project', async () => {
    vi.mocked(canUserAccessProject).mockResolvedValueOnce(false)

    await expect(
      createAnnotation(
        'doc_1',
        { page: 1, shape: 'point', x: 0.1, y: 0.1, kind: 'question', body: 'x', assigneeUserId: 'user_out' },
        { run }
      )
    ).rejects.toMatchObject({ status: 422 })
    expect(insertDocumentAnnotations).not.toHaveBeenCalled()
  })

  it('says so when a document is full', async () => {
    vi.mocked(insertDocumentAnnotations).mockRejectedValue(new AnnotationLimitReachedError())

    await expect(
      createAnnotation('doc_1', { page: 1, shape: 'point', x: 0.1, y: 0.1, kind: 'hint', body: 'x' }, { run })
    ).rejects.toMatchObject({ status: 422 })
  })
})

describe('PATCH /api/documents/[id]/annotations/[annotationId]', () => {
  it('takes a proposal over: open, accepted by the person, compared against „proposed"', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)

    await updateAnnotation('doc_1', 'ann_p', { status: 'open' }, { run })

    expect(updateDocumentAnnotation).toHaveBeenCalledWith('org_1', 'doc_1', 'ann_p', 'proposed', {
      transition: {
        status: 'open',
        closedBy: null,
        closedAt: null,
        acceptedBy: 'user_1',
        acceptedAt: expect.any(Date),
      },
    })
  })

  it('dismisses a proposal as closed by the person', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)

    await updateAnnotation('doc_1', 'ann_p', { status: 'dismissed' }, { run })

    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][4]).toEqual({
      transition: { status: 'dismissed', closedBy: 'user_1', closedAt: expect.any(Date) },
    })
  })

  it('resolves an open one and reopens a resolved one', async () => {
    await updateAnnotation('doc_1', 'ann_1', { status: 'resolved' }, { run })
    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][4]).toEqual({
      transition: { status: 'resolved', closedBy: 'user_1', closedAt: expect.any(Date) },
    })

    vi.mocked(findDocumentAnnotation).mockResolvedValue({
      ...RECORD,
      status: 'resolved',
      closedBy: 'user_2',
      closedAt: new Date(),
    })
    await updateAnnotation('doc_1', 'ann_1', { status: 'open' }, { run })
    expect(vi.mocked(updateDocumentAnnotation).mock.calls[1][4]).toEqual({
      transition: { status: 'open', closedBy: null, closedAt: null },
    })
  })

  it('refuses a move that does not exist: a proposal cannot be resolved before anyone took it over', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)

    await expect(updateAnnotation('doc_1', 'ann_p', { status: 'resolved' }, { run })).rejects.toMatchObject({
      status: 409,
    })
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })

  it('loses to a colleague who moved it first, rather than overwriting them', async () => {
    vi.mocked(updateDocumentAnnotation).mockResolvedValue(null)

    await expect(updateAnnotation('doc_1', 'ann_1', { status: 'resolved' }, { run })).rejects.toMatchObject({
      status: 409,
    })
    expect(publishToRoom).not.toHaveBeenCalled()
  })

  it('refuses an empty change and a change to the place', async () => {
    await expect(updateAnnotation('doc_1', 'ann_1', {}, { run })).rejects.toMatchObject({ status: 400 })
    await expect(updateAnnotation('doc_1', 'ann_1', { x: 0.3 } as never, { run })).rejects.toMatchObject({
      status: 400,
    })
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/documents/[id]/annotations/[annotationId]', () => {
  it('deletes one the caller set, and tells the room', async () => {
    await expect(deleteAnnotation('doc_1', 'ann_1', { run })).resolves.toBeUndefined()
    expect(deleteDocumentAnnotation).toHaveBeenCalledWith('org_1', 'doc_1', 'ann_1')
    expect(publishToRoom).toHaveBeenCalledWith('doc_1', expect.objectContaining({ change: 'deleted' }))
  })

  it("refuses one somebody else set, and Piloti's proposals, which are dismissed instead", async () => {
    for (const record of [{ ...RECORD, createdBy: 'user_2' }, PROPOSAL]) {
      vi.mocked(findDocumentAnnotation).mockResolvedValue(record)
      const error = await deleteAnnotation('doc_1', record.id, { run }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AnnotationRequestError)
      expect(error).toMatchObject({ status: 403 })
    }
    expect(deleteDocumentAnnotation).not.toHaveBeenCalled()
  })
})

describe('POST /api/documents/[id]/annotations/[annotationId]/replies', () => {
  it('answers in the thread as the person, trimmed, and tells the room', async () => {
    await replyToAnnotation('doc_1', 'ann_1', { body: '  Ist im Index D drin.  ' }, { run })

    expect(insertAnnotationReply).toHaveBeenCalledWith({
      organizationId: 'org_1',
      annotationId: 'ann_1',
      authorKind: 'person',
      body: 'Ist im Index D drin.',
      createdBy: 'user_1',
    })
    expect(publishToRoom).toHaveBeenCalledWith('doc_1', expect.objectContaining({ change: 'replied' }))
  })

  it('is refused to a reader who may not write', async () => {
    writable = false

    await expect(replyToAnnotation('doc_1', 'ann_1', { body: 'x' }, { run })).rejects.toMatchObject({ status: 403 })
    expect(insertAnnotationReply).not.toHaveBeenCalled()
  })
})
