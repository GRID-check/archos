/**
 * @vitest-environment node
 */
/**
 * A mark's date and its Zuständige, driven through the TYPED CLIENT and the
 * real route, service and inbox emitters (ADR-0055). The document reader, the
 * repository and the inbox's writes are faked.
 *
 * What is pinned: the row that asks a Zuständige says by when; moving or
 * clearing the date tells the Zuständige who stays, in that same row; a date
 * that comes with a new Zuständige is that one's assignment, told once; and
 * nobody hears their own change.
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
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn().mockResolvedValue(1),
  resolveInboxItemsAnchoredOn: vi.fn().mockResolvedValue(1),
  markInboxItemsInertAnchoredOn: vi.fn().mockResolvedValue(1),
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
}))

import { createAnnotation, updateAnnotation } from '@/lib/annotations/client'
import {
  findDocumentAnnotation,
  insertDocumentAnnotations,
  updateDocumentAnnotation,
  type AnnotationRecord,
} from '@/lib/annotations/repository'
import type { DocumentAnnotationRow } from '@/lib/db/schema/document-annotations'
import type { Document } from '@/lib/db/schema/documents'
import { getAccessibleDocument } from '@/lib/documents/access'
import { mayOpenDocument, mayWriteDocument } from '@/lib/documents/may-open'
import type { InboxEmission } from '@/lib/inbox/service'
import { emitInboxItems } from '@/lib/inbox/service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'

import { POST as create } from './route'
import { PATCH as patch } from './[annotationId]/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'POST', handler: create, params: ['id'] },
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

const DOC = {
  id: 'doc_1',
  organizationId: 'org_1',
  scope: 'project',
  filename: 'Grundriss EG.pdf',
  projectId: 'proj_1',
  publishedVersionId: 'ver_2',
} as Partial<Document> as Document

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
  assigneeUserId: 'user_anna',
  dueOn: '2026-10-20',
  createdBy: 'user_me',
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
  anchorKind: 'page',
  viewpointId: null,
  revisionNumber: 2,
  replies: [],
}

async function rows(): Promise<InboxEmission[]> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return vi.mocked(emitInboxItems).mock.calls.flatMap(([emissions]) => emissions)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAccessibleDocument).mockResolvedValue(DOC)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
  vi.mocked(mayOpenDocument).mockImplementation(async (_tenant, _doc, userIds) => new Set(userIds))
  vi.mocked(mayWriteDocument).mockImplementation(async (_tenant, _doc, userIds) => new Set(userIds))
  vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
  vi.mocked(updateDocumentAnnotation).mockImplementation(
    async (_org, _doc, _id, _status, changes) => ({ ...MARK, ...changes }) as DocumentAnnotationRow
  )
  vi.mocked(insertDocumentAnnotations).mockImplementation(
    async (input) => input.marks.map((mark) => ({ ...MARK, ...mark, id: 'ann_new', number: 5 })) as DocumentAnnotationRow[]
  )
})

describe('a mark’s date and its Zuständige', () => {
  it('asks a new Zuständige with the date the mark carries', async () => {
    await createAnnotation(
      'doc_1',
      { page: 1, shape: 'point', x: 0.5, y: 0.5, kind: 'defect', body: 'Brüstung', assigneeUserId: 'user_anna', dueOn: '2026-10-24' },
      { run }
    )

    const sent = await rows()
    expect(sent.map((row) => [row.type, row.recipientUserId, row.payload?.variant, row.payload?.dueOn])).toEqual([
      ['annotation.assigned_to_you', 'user_anna', 'person', '2026-10-24'],
    ])
  })

  it('tells the Zuständige who stays that the date moved, in the row they have for the mark', async () => {
    await updateAnnotation('doc_1', 'ann_1', { dueOn: '2026-10-31' }, { run })

    const sent = await rows()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'annotation.assigned_to_you',
      recipientUserId: 'user_anna',
      actorUserId: 'user_me',
      groupKey: 'annotation.assigned_to_you:document:doc_1:ann_1',
      payload: { variant: 'due', dueOn: '2026-10-31' },
    })
  })

  it('tells them when the date was taken off', async () => {
    await updateAnnotation('doc_1', 'ann_1', { dueOn: null }, { run })

    expect((await rows())[0]).toMatchObject({ recipientUserId: 'user_anna', payload: { variant: 'due_cleared', dueOn: null } })
  })

  it('tells a new Zuständige once, with the date, when both change in one write', async () => {
    await updateAnnotation('doc_1', 'ann_1', { assigneeUserId: 'user_ben', dueOn: '2026-10-31' }, { run })

    const sent = await rows()
    expect(sent.map((row) => [row.recipientUserId, row.payload?.variant, row.payload?.dueOn])).toEqual([
      ['user_ben', 'person', '2026-10-31'],
    ])
  })

  it('tells nobody about a date on a mark without a Zuständige, or the Zuständige’s own change', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, assigneeUserId: null })
    await updateAnnotation('doc_1', 'ann_1', { dueOn: '2026-10-31' }, { run })
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, assigneeUserId: 'user_me' })
    await updateAnnotation('doc_1', 'ann_1', { dueOn: '2026-10-31' }, { run })

    expect(await rows()).toEqual([])
  })
})
