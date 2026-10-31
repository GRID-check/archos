/**
 * @vitest-environment node
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
vi.mock('@/lib/documents/revision-links-loader', () => ({ loadRevisionLinks: vi.fn() }))
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
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
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

vi.mock('@/lib/bim/repository', () => ({ findBimModelByDocument: vi.fn() }))
vi.mock('@/lib/annotations/viewpoint-repository', () => ({
  findViewpoint: vi.fn(),
  findViewpoints: vi.fn(),
  viewpointSummariesOfMarks: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/annotations/viewpoint-carry-repository', () => ({
  presentGlobalIds: vi.fn(),
  versionNumberOf: vi.fn(),
  carryViewpointMarkInPlace: vi.fn(),
  carryViewpointMarkAcross: vi.fn(),
  markViewpointAnchorLost: vi.fn(),
}))

import { AnnotationRequestError, listAnnotations, updateAnnotation } from '@/lib/annotations/client'
import { findDocumentAnnotation, listDocumentAnnotations, updateDocumentAnnotation, type AnnotationRecord } from '@/lib/annotations/repository'
import {
  carryViewpointMarkAcross,
  carryViewpointMarkInPlace,
  markViewpointAnchorLost,
  presentGlobalIds,
  versionNumberOf,
} from '@/lib/annotations/viewpoint-carry-repository'
import { findViewpoint, findViewpoints } from '@/lib/annotations/viewpoint-repository'
import { NotFoundError } from '@/lib/api/errors'
import { captureServer } from '@/lib/analytics/posthog-server'
import { findBimModelByDocument } from '@/lib/bim/repository'
import type { AnnotationViewpointRow } from '@/lib/db/schema/annotation-viewpoints'
import type { DocumentAnnotationRow } from '@/lib/db/schema/document-annotations'
import type { Document } from '@/lib/db/schema/documents'
import { getAccessibleDocument } from '@/lib/documents/access'
import type { RevisionLinks } from '@/lib/documents/revision-links'
import { loadRevisionLinks } from '@/lib/documents/revision-links-loader'
import { mayOpenDocument, mayWriteDocument } from '@/lib/documents/may-open'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'

import { GET as list } from './route'
import { PATCH as patch } from './[annotationId]/route'

/**
 * „3 von 3 Bauteilen in Fassung 4 vorhanden · übernehmen": carrying a mark on
 * a model to the model's current Fassung (migration 0195), through the typed
 * client and the real route and service; the repositories are faked, the SQL
 * is `lib/annotations/viewpoint-carry.integration.spec.ts`'s.
 *
 * What is pinned: the list counts, per mark, its elements in the Fassung it
 * lands on and gives the link to its view; in place the mark goes onto a new
 * viewpoint with only the elements still there, or keeps its own and says it
 * lost them; across it goes on as a linked mark of the replacing model, or,
 * none of its elements there, stays and says so; a model not ready and a
 * proposal across are refused; every carry is counted with what it found.
 */

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'GET', handler: list, params: ['id'] },
  { pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/, method: 'PATCH', handler: patch, params: ['id', 'annotationId'] },
]

const run = async (path: string, init?: RequestInit) => {
  const url = new URL(path, 'https://app.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  const params = Object.fromEntries(route.params.map((name, index) => [name, decodeURIComponent(matched[index + 1])]))
  return route.handler(new Request(url, init), { params: Promise.resolve(params) })
}

const doc = (id: string, filename: string): Document =>
  ({
    id,
    organizationId: 'org_1',
    scope: 'project',
    projectId: 'proj_1',
    folderId: null,
    filename,
    displayName: null,
    publishedVersionId: `${id}_ver_2`,
  }) as Partial<Document> as Document

const MODEL = doc('doc_m', 'Haus.ifc')
const NEXT = doc('doc_n', 'Haus_Tragwerk.ifc')
const DOCS = new Map([MODEL, NEXT].map((entry) => [entry.id, entry]))

const WALL = '2O2Fr$t4X7Zf8NOew3FLOH'
const DOOR = '3pGKgn9xH4$PdVA0l_Bk8z'
const GONE = '1hOSvn6df7weDDVAKgmDHz'

const VIEWPOINT: AnnotationViewpointRow = {
  id: 'vp_1',
  organizationId: 'org_1',
  documentId: 'doc_m',
  versionId: 'doc_m_ver_1',
  cameraKind: 'perspective',
  camera: {
    type: 'perspective',
    position: { x: 1, y: 2, z: 3 },
    direction: { x: 0, y: 1, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    aspectRatio: 1.5,
    fieldOfView: 60,
  },
  clippingPlanes: [],
  selectionIds: [WALL, DOOR, GONE],
  defaultVisibility: true,
  visibilityExceptionIds: [],
  coloring: [],
  pinPoint: null,
  pinGlobalId: null,
  snapshotKey: null,
  snapshotContentType: null,
  snapshotBytes: null,
  carriedFromId: null,
  createdBy: 'user_ben',
  createdAt: new Date('2026-10-01T08:00:00Z'),
}

const MARK: AnnotationRecord = {
  id: 'ann_1',
  organizationId: 'org_1',
  documentId: 'doc_m',
  versionId: 'doc_m_ver_1',
  number: 4,
  page: null,
  shape: null,
  x: null,
  y: null,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Auflager fehlt',
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
  anchorElementIds: null,
  anchorLostAt: null,
  anchorKind: 'viewpoint',
  viewpointId: 'vp_1',
  revisionNumber: 3,
  replies: [],
}

const READY = { id: 'model_1', status: 'ready', summary: { truncatedAt: null } }

const replacedBy = (older: Document, newer: Document): Map<string, RevisionLinks> =>
  new Map([[older.id, { supersededBy: { id: newer.id, filename: newer.filename }, supersedes: [], suggestion: null, changeSummary: null }]])

const carry = (annotationId = 'ann_1', expectedStatus: 'open' | 'proposed' = 'open') =>
  updateAnnotation('doc_m', annotationId, { carryToCurrent: true, expectedStatus }, { run })

const events = () =>
  vi.mocked(captureServer).mock.calls.map(([capture]) => [capture.event, capture.properties] as const)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id) => {
    const found = DOCS.get(id)
    if (!found) throw new NotFoundError()
    return found
  })
  vi.mocked(loadRevisionLinks).mockResolvedValue(new Map())
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
  vi.mocked(mayOpenDocument).mockImplementation(async (_tenant, _doc, userIds) => new Set(userIds))
  vi.mocked(mayWriteDocument).mockImplementation(async (_tenant, _doc, userIds) => new Set(userIds))
  vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
  vi.mocked(listDocumentAnnotations).mockResolvedValue([MARK])
  vi.mocked(findBimModelByDocument).mockResolvedValue(READY as Awaited<ReturnType<typeof findBimModelByDocument>>)
  vi.mocked(findViewpoint).mockResolvedValue(VIEWPOINT)
  vi.mocked(findViewpoints).mockResolvedValue([VIEWPOINT])
  vi.mocked(presentGlobalIds).mockResolvedValue(new Set([WALL, DOOR]))
  vi.mocked(versionNumberOf).mockResolvedValue(4)
})

describe('what the list says a carry of a mark on a model would find', () => {
  it('counts its elements in the Fassung it lands on, and links to its view', async () => {
    const { annotations } = await listAnnotations('doc_m', run)
    expect(annotations[0]).toMatchObject({
      carryTarget: { documentId: 'doc_m', documentName: 'Haus.ifc', revisionNumber: 4, elements: { present: 2, total: 3 } },
      viewHref: '/app/projects/proj_1/files?model=Haus.ifc&mark=ann_1',
    })
    expect(versionNumberOf).toHaveBeenCalledWith('org_1', 'doc_m', 'doc_m_ver_2')
  })

  it('offers no carry while the model of the new Fassung is still being read', async () => {
    vi.mocked(findBimModelByDocument).mockResolvedValue({ ...READY, status: 'extracting' } as Awaited<ReturnType<typeof findBimModelByDocument>>)
    const { annotations } = await listAnnotations('doc_m', run)
    expect(annotations[0]?.carryTarget).toBeNull()
  })

  it('offers none for a mark already on the current Fassung', async () => {
    vi.mocked(listDocumentAnnotations).mockResolvedValue([{ ...MARK, versionId: 'doc_m_ver_2' }])
    const { annotations } = await listAnnotations('doc_m', run)
    expect(annotations[0]?.carryTarget).toBeNull()
    expect(presentGlobalIds).not.toHaveBeenCalled()
  })
})

describe('carrying a mark on a model in place', () => {
  it('puts it on a new viewpoint with the elements still there, and counts what it found', async () => {
    vi.mocked(carryViewpointMarkInPlace).mockResolvedValue({ ...MARK, versionId: 'doc_m_ver_2' } as DocumentAnnotationRow)
    await carry()
    const input = vi.mocked(carryViewpointMarkInPlace).mock.calls[0]?.[0]
    expect(input).toMatchObject({
      documentId: 'doc_m',
      mark: { id: 'ann_1', status: 'open', versionId: 'doc_m_ver_1', viewpointId: 'vp_1' },
      toVersionId: 'doc_m_ver_2',
      viewpoint: { selectionIds: [WALL, DOOR], carriedFromId: 'vp_1', snapshotKey: null, camera: VIEWPOINT.camera },
    })
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
    expect(events()).toEqual([
      ['annotation_viewpoint_carried', { document_id: 'doc_m', way: 'in_place', outcome: 'carried', present: 2, total: 3, by: 'person' }],
      ['annotation_carried', { document_id: 'doc_m', way: 'in_place', by: 'person' }],
    ])
  })

  it('keeps its viewpoint and says it lost its elements when none is left', async () => {
    vi.mocked(presentGlobalIds).mockResolvedValue(new Set())
    vi.mocked(carryViewpointMarkInPlace).mockResolvedValue({ ...MARK, anchorLostAt: new Date() } as DocumentAnnotationRow)
    await carry()
    expect(vi.mocked(carryViewpointMarkInPlace).mock.calls[0]?.[0]).toMatchObject({ viewpoint: null, toVersionId: 'doc_m_ver_2' })
    expect(events()[0]).toEqual([
      'annotation_viewpoint_carried',
      { document_id: 'doc_m', way: 'in_place', outcome: 'anchor_lost', present: 0, total: 3, by: 'person' },
    ])
  })

  it('carries Piloti’s proposal in place, as a proposal', async () => {
    const proposal = { ...MARK, status: 'proposed' as const, authorKind: 'piloti' as const }
    vi.mocked(findDocumentAnnotation).mockResolvedValue(proposal)
    vi.mocked(carryViewpointMarkInPlace).mockResolvedValue(proposal as DocumentAnnotationRow)
    await carry('ann_1', 'proposed')
    expect(vi.mocked(carryViewpointMarkInPlace).mock.calls[0]?.[0]).toMatchObject({ mark: { status: 'proposed' } })
  })

  it('is refused while the model is not ready, and a conflict when a colleague moved it first', async () => {
    vi.mocked(findBimModelByDocument).mockResolvedValueOnce(null)
    await expect(carry()).rejects.toMatchObject({ status: 422 })
    vi.mocked(carryViewpointMarkInPlace).mockResolvedValue(null)
    await expect(carry()).rejects.toMatchObject({ status: 409 })
  })
})

describe('carrying a mark on a model another model replaced', () => {
  beforeEach(() => {
    vi.mocked(loadRevisionLinks).mockImplementation(async (_session, subjects) =>
      subjects[0]?.id === 'doc_m' ? replacedBy(MODEL, NEXT) : new Map()
    )
  })

  it('sets it on the replacing model, on a viewpoint there, linked back', async () => {
    const onNext = { ...MARK, id: 'ann_n', documentId: 'doc_n', versionId: 'doc_n_ver_2', carriedFromId: 'ann_1' }
    vi.mocked(carryViewpointMarkAcross).mockResolvedValue(onNext as DocumentAnnotationRow)
    vi.mocked(findDocumentAnnotation).mockImplementation(async (_org, _doc, id) => (id === 'ann_n' ? onNext : MARK))
    const annotation = await carry()
    expect(vi.mocked(carryViewpointMarkAcross).mock.calls[0]?.[0]).toMatchObject({
      target: { documentId: 'doc_n', versionId: 'doc_n_ver_2' },
      viewpoint: { selectionIds: [WALL, DOOR], carriedFromId: 'vp_1' },
      closedBy: 'user_me',
    })
    expect(findBimModelByDocument).toHaveBeenCalledWith('doc_n', 'org_1', expect.anything())
    expect(annotation).toMatchObject({ id: 'ann_n', documentId: 'doc_n' })
  })

  it('stays where it is and says so when the replacing model has none of its elements', async () => {
    vi.mocked(presentGlobalIds).mockResolvedValue(new Set())
    const lost = { ...MARK, anchorLostAt: new Date() }
    vi.mocked(markViewpointAnchorLost).mockResolvedValue(lost as DocumentAnnotationRow)
    vi.mocked(findDocumentAnnotation).mockResolvedValueOnce(MARK).mockResolvedValue(lost)
    const annotation = await carry()
    expect(carryViewpointMarkAcross).not.toHaveBeenCalled()
    expect(annotation).toMatchObject({ id: 'ann_1', documentId: 'doc_m', status: 'open', anchorLost: true })
  })

  it('refuses a proposal: it is taken over before it goes on to another model', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, status: 'proposed', authorKind: 'piloti' })
    await expect(carry('ann_1', 'proposed')).rejects.toBeInstanceOf(AnnotationRequestError)
    expect(carryViewpointMarkAcross).not.toHaveBeenCalled()
  })
})
