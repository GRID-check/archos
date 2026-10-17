/**
 * @vitest-environment node
 */
/**
 * „Gilt weiter": carrying an open mark to the document's current Fassung,
 * driven through the TYPED CLIENT and the real route, service and inbox
 * emitters (ADR-0055). The document reader, the repository, the Fassung facts
 * and the inbox's writes are faked.
 *
 * What is pinned: under the same name the mark moves in place, compared and
 * swapped on its status and the Fassung it was read on, and tells nobody;
 * only an open mark goes on, and nothing else changes with it; a document
 * another one replaced hands its mark to that one as a linked mark, its own
 * closed in the same write, the Zuständige asked again on the new mark only
 * while they may still answer there; a second carry, a delegated mark and a
 * colleague's earlier move are refused; and a link names only a document the
 * reader may open.
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
vi.mock('@/lib/documents/may-open', () => ({ mayOpenDocument: vi.fn(), mayWriteDocument: vi.fn() }))
vi.mock('@/lib/documents/fassung-facts', () => ({ loadFassungFacts: vi.fn() }))
vi.mock('@/lib/upload-screening/quarantine-reviewers', () => ({
  shelfReaderFor: vi.fn(async () => ({ kind: 'member', userId: 'user_me' })),
}))
vi.mock('@/lib/authz/project-membership', () => ({
  PERMISSION_CHECKS_AT_ONCE: 8,
  userHoldsProjectPermission: vi.fn(),
  resolveSubjectMembership: vi.fn(),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/sharing/registry', () => ({
  describeResource: () => ({ describeRef: async () => ({ title: 'Grundriss EG Index C' }) }),
}))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn().mockResolvedValue(1),
  resolveInboxItemsAnchoredOn: vi.fn().mockResolvedValue(1),
  markInboxItemsInertAnchoredOn: vi.fn().mockResolvedValue(1),
}))
vi.mock('@/lib/annotations/repository', () => ({
  AnnotationLimitReachedError: class AnnotationLimitReachedError extends Error {},
  ReplyLimitReachedError: class ReplyLimitReachedError extends Error {},
  AlreadyCarriedError: class AlreadyCarriedError extends Error {},
  listDocumentAnnotations: vi.fn(),
  findDocumentAnnotation: vi.fn(),
  insertDocumentAnnotations: vi.fn(),
  updateDocumentAnnotation: vi.fn(),
  carryAnnotationToDocument: vi.fn(),
  deleteDocumentAnnotation: vi.fn(),
  deleteAnnotationReply: vi.fn(),
  insertAnnotationReply: vi.fn(),
}))

import { AnnotationRequestError, listAnnotations, updateAnnotation } from '@/lib/annotations/client'
import {
  AlreadyCarriedError,
  carryAnnotationToDocument,
  findDocumentAnnotation,
  listDocumentAnnotations,
  updateDocumentAnnotation,
  type AnnotationRecord,
} from '@/lib/annotations/repository'
import { NotFoundError } from '@/lib/api/errors'
import type { Document, DocumentAnnotationRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import type { FassungFacts } from '@/lib/documents/fassung'
import { loadFassungFacts } from '@/lib/documents/fassung-facts'
import { mayOpenDocument, mayWriteDocument } from '@/lib/documents/may-open'
import type { InboxEmission } from '@/lib/inbox/service'
import { emitInboxItems, resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'

import { GET as list } from './route'
import { PATCH as patch } from './[annotationId]/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'GET', handler: list, params: ['id'] },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/,
    method: 'PATCH',
    handler: patch,
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

const doc = (id: string, fields: Partial<Document> = {}) =>
  ({
    id,
    organizationId: 'org_1',
    scope: 'project',
    projectId: 'proj_1',
    folderId: null,
    filename: `${id}.pdf`,
    displayName: null,
    publishedVersionId: `${id}_ver_2`,
    ...fields,
  }) as Partial<Document> as Document

/** The document under its own name, with a newer Fassung published. */
const SAME = doc('doc_a')
/** Index B, replaced by Index C under another name. */
const B = doc('doc_b', { filename: 'Grundriss EG Index B.pdf' })
const C = doc('doc_c', { filename: 'Grundriss EG Index C.pdf' })
const DOCS = new Map([SAME, B, C].map((entry) => [entry.id, entry]))

const MARK: AnnotationRecord = {
  id: 'ann_1',
  organizationId: 'org_1',
  documentId: 'doc_a',
  versionId: 'doc_a_ver_1',
  number: 4,
  page: 2,
  shape: 'region',
  x: 0.2,
  y: 0.3,
  w: 0.1,
  h: 0.05,
  kind: 'defect',
  body: 'Brüstung unter 1,00 m',
  mentions: [],
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: 'user_anna',
  dueOn: '2026-10-24',
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
  fassungNumber: 1,
  replies: [],
}

const ON_B: AnnotationRecord = { ...MARK, id: 'ann_b', documentId: 'doc_b', versionId: 'doc_b_ver_2', fassungNumber: 2 }
const ON_C: AnnotationRecord = {
  ...MARK,
  id: 'ann_c',
  documentId: 'doc_c',
  versionId: 'doc_c_ver_2',
  number: 1,
  fassungNumber: 2,
  carriedFromId: 'ann_b',
  carriedFrom: { annotationId: 'ann_b', documentId: 'doc_b', number: 4 },
}

const replacedBy = (older: Document, newer: Document): Map<string, FassungFacts> =>
  new Map([[older.id, { supersededBy: { id: newer.id, filename: newer.filename }, supersedes: [], suggestion: null, changeSummary: null }]])

async function rows(): Promise<InboxEmission[]> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return vi.mocked(emitInboxItems).mock.calls.flatMap(([emissions]) => emissions)
}

const carry = (documentId: string, annotationId: string) =>
  updateAnnotation(documentId, annotationId, { carryToCurrent: true, expectedStatus: 'open' }, { run })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id) => {
    const found = DOCS.get(id)
    if (!found) throw new NotFoundError()
    return found
  })
  vi.mocked(loadFassungFacts).mockResolvedValue(new Map())
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
  vi.mocked(mayOpenDocument).mockImplementation(async (_tenant, _doc, userIds) => new Set(userIds))
  vi.mocked(mayWriteDocument).mockImplementation(async (_tenant, _doc, userIds) => new Set(userIds))
  vi.mocked(findDocumentAnnotation).mockImplementation(async (_org, documentId, id) => {
    if (id === 'ann_1') return { ...MARK, documentId }
    if (id === 'ann_b') return ON_B
    if (id === 'ann_c') return ON_C
    return null
  })
})

describe('carrying a mark to the current Fassung of its own document', () => {
  it('moves it in place, compared against its status and the Fassung it was read on, and tells only the room', async () => {
    vi.mocked(updateDocumentAnnotation).mockResolvedValue({ ...MARK, versionId: 'doc_a_ver_2' } as DocumentAnnotationRow)
    vi.mocked(findDocumentAnnotation)
      .mockResolvedValueOnce(MARK)
      .mockResolvedValueOnce({ ...MARK, versionId: 'doc_a_ver_2', fassungNumber: 2 })

    const annotation = await carry('doc_a', 'ann_1')

    expect(updateDocumentAnnotation).toHaveBeenCalledWith('org_1', 'doc_a', 'ann_1', 'open', {
      fassung: { from: 'doc_a_ver_1', to: 'doc_a_ver_2' },
    })
    expect(annotation).toMatchObject({ id: 'ann_1', number: 4, onCurrentFassung: true, x: 0.2, y: 0.3 })
    expect(publishToDocumentRoom).toHaveBeenCalledWith('doc_a', expect.objectContaining({ annotationIds: ['ann_1'] }))
    expect(await rows()).toEqual([])
    expect(carryAnnotationToDocument).not.toHaveBeenCalled()
  })

  it('changes nothing for a mark already on the current Fassung', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, versionId: 'doc_a_ver_2' })

    await expect(carry('doc_a', 'ann_1')).resolves.toMatchObject({ onCurrentFassung: true })
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })

  it('is a conflict when a colleague closed or carried it a moment ago', async () => {
    vi.mocked(updateDocumentAnnotation).mockResolvedValue(null)

    await expect(carry('doc_a', 'ann_1')).rejects.toMatchObject({ status: 409 })
  })

  it('carries only an open mark, and nothing else changes with it', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, status: 'resolved', closedBy: 'user_me', closedAt: new Date() })
    await expect(
      updateAnnotation('doc_a', 'ann_1', { carryToCurrent: true }, { run })
    ).rejects.toMatchObject({ status: 422 })

    const mixed = await run('/api/documents/doc_a/annotations/ann_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ carryToCurrent: true, dueOn: '2026-11-01' }),
    })
    expect(mixed.status).toBe(400)
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })

  it('is refused to a reader who may not write the document', async () => {
    vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id, intent) => {
      if (intent === 'write') throw new NotFoundError()
      return DOCS.get(id) as Document
    })

    await expect(carry('doc_a', 'ann_1')).rejects.toBeInstanceOf(AnnotationRequestError)
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })
})

describe('carrying a mark of a document another one replaced', () => {
  beforeEach(() => {
    vi.mocked(loadFassungFacts).mockImplementation(async (_session, subjects) =>
      subjects[0]?.id === 'doc_b' ? replacedBy(B, C) : new Map()
    )
    vi.mocked(carryAnnotationToDocument).mockResolvedValue({ ...ON_C } as DocumentAnnotationRow)
  })

  it('sets it on the replacing document, linked back, closes the original, and asks its Zuständige there', async () => {
    const annotation = await carry('doc_b', 'ann_b')

    expect(carryAnnotationToDocument).toHaveBeenCalledWith({
      organizationId: 'org_1',
      source: ON_B,
      target: { documentId: 'doc_c', versionId: 'doc_c_ver_2' },
      values: { mentions: [], assigneeUserId: 'user_anna' },
      closedBy: 'user_me',
    })
    expect(annotation).toMatchObject({
      id: 'ann_c',
      documentId: 'doc_c',
      onCurrentFassung: true,
      carriedFrom: { annotationId: 'ann_b', documentId: 'doc_b', number: 4, documentName: 'Grundriss EG Index B.pdf' },
    })
    const rooms = vi.mocked(publishToDocumentRoom).mock.calls.map(([documentId, event]) => [documentId, event.kind === 'annotations.changed' ? event.change : null])
    expect(rooms).toEqual([
      ['doc_b', 'updated'],
      ['doc_c', 'created'],
    ])
    const sent = await rows()
    expect(sent.map((row) => [row.type, row.recipientUserId, row.resourceId, row.anchorId])).toEqual([
      ['annotation.assigned_to_you', 'user_anna', 'doc_c', 'ann_c'],
    ])
    // What B's mark asked of people is settled: it is closed.
    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: 'ann_b', types: expect.arrayContaining(['annotation.assigned_to_you']) })
    )
  })

  it('follows the chain to its end, and drops a Zuständige who could not answer on the new document', async () => {
    const D = doc('doc_d', { filename: 'Grundriss EG Index D.pdf' })
    DOCS.set('doc_d', D)
    vi.mocked(loadFassungFacts).mockImplementation(async (_session, subjects) => {
      if (subjects[0]?.id === 'doc_b') return replacedBy(B, C)
      if (subjects[0]?.id === 'doc_c') return replacedBy(C, D)
      return new Map()
    })
    vi.mocked(mayWriteDocument).mockImplementation(async () => new Set())

    await carry('doc_b', 'ann_b')

    expect(vi.mocked(carryAnnotationToDocument).mock.calls[0]?.[0]).toMatchObject({
      target: { documentId: 'doc_d', versionId: 'doc_d_ver_2' },
      values: { assigneeUserId: null },
    })
    DOCS.delete('doc_d')
  })

  it('refuses a second carry, a colleague’s earlier move, and a mark Piloti is working', async () => {
    vi.mocked(carryAnnotationToDocument).mockRejectedValueOnce(new AlreadyCarriedError())
    await expect(carry('doc_b', 'ann_b')).rejects.toMatchObject({ status: 409 })

    vi.mocked(carryAnnotationToDocument).mockResolvedValueOnce(null)
    await expect(carry('doc_b', 'ann_b')).rejects.toMatchObject({ status: 409 })

    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...ON_B, delegatedBy: 'user_me', delegatedAt: new Date() })
    await expect(carry('doc_b', 'ann_b')).rejects.toMatchObject({ status: 422, reason: 'delegated' })
    expect(carryAnnotationToDocument).toHaveBeenCalledTimes(2)
  })

  it('needs the right to write the replacing document too', async () => {
    vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id, intent) => {
      if (id === 'doc_c' && intent === 'write') throw new NotFoundError()
      return DOCS.get(id) as Document
    })

    await expect(carry('doc_b', 'ann_b')).rejects.toMatchObject({ status: 404 })
    expect(carryAnnotationToDocument).not.toHaveBeenCalled()
  })
})

describe('the links a carried mark shows', () => {
  it('names the other document only to a reader who may open it', async () => {
    const ORIGINAL: AnnotationRecord = {
      ...ON_B,
      status: 'resolved',
      closedBy: 'user_me',
      closedAt: new Date(),
      carriedTo: { annotationId: 'ann_c', documentId: 'doc_c', number: 1 },
    }
    vi.mocked(listDocumentAnnotations).mockResolvedValue([ORIGINAL])

    const shown = await listAnnotations('doc_b', run)
    expect(shown.annotations[0]?.carriedTo).toEqual({
      annotationId: 'ann_c',
      documentId: 'doc_c',
      number: 1,
      documentName: 'Grundriss EG Index C.pdf',
    })

    vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id) => {
      if (id === 'doc_c') throw new NotFoundError()
      return DOCS.get(id) as Document
    })
    const hidden = await listAnnotations('doc_b', run)
    expect(hidden.annotations[0]?.carriedTo).toBeNull()
  })
})
