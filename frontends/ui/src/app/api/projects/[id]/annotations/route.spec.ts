/**
 * @vitest-environment node
 */
/**
 * A project's Offene Punkte (`GET /api/projects/[id]/annotations`) and its
 * Protokoll (`…/export`), driven through the TYPED CLIENT and the real
 * handlers (ADR-0055).
 *
 * The project gate, the reader's folders and screening reader, the repository
 * and the document reader are mocked; under test are the rules between them:
 * the project gate comes first, the repository is asked with the reader's own
 * folders and screening reader (the SQL that uses them is proved against
 * Postgres in `project-repository.integration.spec.ts`), the filters reach it
 * as statuses, a Zuständige and a range of days on the office's calendar, a
 * page is bounded and its cursor is opaque and checked, and each row is a
 * document list's own view, with what this reader may do on THAT document.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ getHiddenFolderIds: vi.fn(), getRestrictedFolderIds: vi.fn() }))
vi.mock('@/lib/upload-screening/quarantine-reviewers', () => ({ shelfReaderFor: vi.fn() }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/annotations/project-repository', () => ({
  listProjectAnnotationPage: vi.fn(),
  selectionReachesRestrictedDocuments: vi.fn(),
}))

import { ForbiddenError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getHiddenFolderIds, getRestrictedFolderIds } from '@/lib/authz/folder-access'
import type { Document } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { memberReader } from '@/lib/documents/document-reader'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { AnnotationRequestError, listProjectAnnotations } from '@/lib/annotations/client'
import { encodeProjectMarkCursor } from '@/lib/annotations/project-marks'
import {
  listProjectAnnotationPage,
  selectionReachesRestrictedDocuments,
  type ProjectAnnotationPage,
  type ProjectAnnotationRecord,
} from '@/lib/annotations/project-repository'
import { PROJECT_PROTOCOL_MAX_MARKS, projectProtocolHref } from '@/lib/annotations/project-types'
import { expectRegistered } from '@/test-utils/audit'
import { GET as list } from './route'
import { GET as exportProtocol } from './export/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; handler: Handler }> = [
  { pattern: /^\/api\/projects\/([^/]+)\/annotations$/, handler: list },
  { pattern: /^\/api\/projects\/([^/]+)\/annotations\/export$/, handler: exportProtocol },
]

const run = async (path: string, init?: RequestInit) => {
  const url = new URL(path, 'https://grid.test')
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname))
  if (!route) throw new Error(`no route for ${url.pathname}`)
  const id = decodeURIComponent((route.pattern.exec(url.pathname) as RegExpExecArray)[1])
  return route.handler(new Request(url, init), { params: Promise.resolve({ id }) })
}

const DOC_A = '00000000-0000-4000-8000-00000000000a'
const DOC_B = '00000000-0000-4000-8000-00000000000b'

const doc = (id: string, filename: string): Document =>
  ({
    id,
    organizationId: 'org_1',
    scope: 'project',
    projectId: 'proj_1',
    filename,
    displayName: null,
    publishedVersionId: `ver_${id}`,
  }) as Partial<Document> as Document

const DOCS: Record<string, Document> = { [DOC_A]: doc(DOC_A, 'Grundriss EG.pdf'), [DOC_B]: doc(DOC_B, 'Schnitt A-A.pdf') }

const record = (documentId: string, number: number, extra: Partial<ProjectAnnotationRecord> = {}): ProjectAnnotationRecord => ({
  id: `ann_${documentId.slice(-1)}_${number}`,
  organizationId: 'org_1',
  documentId,
  versionId: `ver_${documentId}`,
  number,
  page: 1,
  shape: 'point',
  x: 0.5,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: `Punkt ${number}`,
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
  delegatedBy: null,
  delegatedAt: null,
  carriedFromId: null,
  mentions: [],
  revisionNumber: 1,
  replies: [],
  document: DOCS[documentId],
  ...extra,
})

const page = (records: ProjectAnnotationRecord[], next: ProjectAnnotationPage['next'] = null): ProjectAnnotationPage => ({
  records,
  next,
})

const READER = memberReader('user_1')
let writable = new Set<string>([DOC_A])

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  // 23:30 UTC on the 17th is already the 18th in Vienna: the office's day decides „überfällig".
  vi.setSystemTime(new Date('2026-10-17T23:30:00Z'))
  writable = new Set([DOC_A])
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-viewer' } as Awaited<ReturnType<typeof requireProjectAccess>>)
  vi.mocked(getHiddenFolderIds).mockResolvedValue(['folder_closed'])
  vi.mocked(getRestrictedFolderIds).mockResolvedValue(['folder_restricted'])
  vi.mocked(selectionReachesRestrictedDocuments).mockResolvedValue(false)
  vi.mocked(shelfReaderFor).mockResolvedValue(READER)
  vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id, intent) => {
    if (intent === 'write' && !writable.has(id)) throw new ForbiddenError()
    return DOCS[id]
  })
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([['user_2', { userId: 'user_2', email: null, name: 'Jakob Huber', profilePictureUrl: null }]])
  )
  vi.mocked(findProjectInOrg).mockResolvedValue({ id: 'proj_1', name: 'Wohnhaus Lend' } as Awaited<
    ReturnType<typeof findProjectInOrg>
  >)
  vi.mocked(listProjectAnnotationPage).mockResolvedValue(page([]))
})

afterEach(() => vi.useRealTimers())

const query = () => vi.mocked(listProjectAnnotationPage).mock.calls[0]?.[2]

describe('GET /api/projects/[id]/annotations', () => {
  it('asks the project gate first, and lists nothing for a project the reader may not view', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new ForbiddenError())

    await expect(listProjectAnnotations('proj_1', {}, { run })).rejects.toMatchObject({ status: 403 })
    expect(requireProjectAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }), 'proj_1', 'project:view')
    expect(listProjectAnnotationPage).not.toHaveBeenCalled()
  })

  it('reads with the reader’s own folders and screening reader, the office’s open marks by document', async () => {
    await listProjectAnnotations('proj_1', {}, { run })

    expect(shelfReaderFor).toHaveBeenCalledWith(expect.anything(), { scope: 'project', projectId: 'proj_1' })
    expect(listProjectAnnotationPage).toHaveBeenCalledWith('org_1', 'proj_1', {
      reader: READER,
      hiddenFolderIds: ['folder_closed'],
      statuses: ['open'],
      assigneeUserId: null,
      due: null,
      order: 'document',
      cursor: null,
      limit: 50,
    })
  })

  it('turns the filters into statuses, the reader as Zuständige, and days on the office’s calendar', async () => {
    await listProjectAnnotations('proj_1', { status: 'all-live', assignee: 'me', due: 'overdue', order: 'due' }, { run })
    expect(query()).toMatchObject({
      statuses: ['open', 'proposed'],
      assigneeUserId: 'user_1',
      due: { before: '2026-10-18' },
      order: 'due',
    })

    vi.mocked(listProjectAnnotationPage).mockClear()
    await listProjectAnnotations('proj_1', { status: 'proposed', assignee: 'user_2', due: 'soon' }, { run })
    expect(query()).toMatchObject({
      statuses: ['proposed'],
      assigneeUserId: 'user_2',
      due: { from: '2026-10-18', through: '2026-10-25' },
    })
  })

  it('bounds a page: a size past the cap and an unknown filter are refused before anything is read', async () => {
    await expect(listProjectAnnotations('proj_1', {}, { run, limit: 101 })).rejects.toMatchObject({ status: 400 })
    await expect(run('/api/projects/proj_1/annotations?status=resolved')).resolves.toMatchObject({ status: 400 })
    await expect(run('/api/projects/proj_1/annotations?due=later')).resolves.toMatchObject({ status: 400 })
    expect(listProjectAnnotationPage).not.toHaveBeenCalled()

    await listProjectAnnotations('proj_1', {}, { run, limit: 100 })
    expect(query()).toMatchObject({ limit: 100 })
  })

  it('hands out an opaque cursor and takes back only its own', async () => {
    const next = { due: '9999-12-31', name: 'grundriss eg.pdf', documentId: DOC_A, number: 7 }
    vi.mocked(listProjectAnnotationPage).mockResolvedValueOnce(page([record(DOC_A, 7)], next))

    const first = await listProjectAnnotations('proj_1', {}, { run })
    expect(first.nextCursor).toBe(encodeProjectMarkCursor(next))

    await listProjectAnnotations('proj_1', {}, { run, cursor: first.nextCursor })
    expect(vi.mocked(listProjectAnnotationPage).mock.calls[1]?.[2]).toMatchObject({ cursor: next })

    const forged = Buffer.from(JSON.stringify({ u: 'x', n: 1 })).toString('base64url')
    const refused = listProjectAnnotations('proj_1', {}, { run, cursor: forged })
    await expect(refused).rejects.toBeInstanceOf(AnnotationRequestError)
    await expect(refused).rejects.toMatchObject({ status: 400 })
  })

  it('says on the first page whether the whole selection quotes a document not every member may open', async () => {
    const next = { due: '9999-12-31', name: 'grundriss eg.pdf', documentId: DOC_A, number: 7 }
    vi.mocked(listProjectAnnotationPage).mockResolvedValue(page([record(DOC_A, 7)], next))
    vi.mocked(selectionReachesRestrictedDocuments).mockResolvedValue(true)

    const first = await listProjectAnnotations('proj_1', { assignee: 'me' }, { run })
    expect(first.restricted).toBe(true)
    // The selection the page reads, asked over every page, against the folders not every member may read.
    expect(selectionReachesRestrictedDocuments).toHaveBeenCalledWith(
      'org_1',
      'proj_1',
      expect.objectContaining({
        reader: READER,
        hiddenFolderIds: ['folder_closed'],
        assigneeUserId: 'user_1',
        restrictedFolderIds: ['folder_restricted'],
      })
    )
    // A later page does not ask again.
    const later = await listProjectAnnotations('proj_1', { assignee: 'me' }, { run, cursor: first.nextCursor })
    expect(later.restricted).toBeUndefined()
    expect(selectionReachesRestrictedDocuments).toHaveBeenCalledTimes(1)
  })

  it('answers each row as its document’s list does, in the page’s order, with the document’s name', async () => {
    vi.mocked(listProjectAnnotationPage).mockResolvedValue(
      page([
        record(DOC_A, 2, { assigneeUserId: 'user_2', dueOn: '2026-10-20' }),
        record(DOC_A, 5, { versionId: 'ver_old', revisionNumber: 1 }),
        record(DOC_B, 1),
      ])
    )

    const { marks, nextCursor } = await listProjectAnnotations('proj_1', {}, { run })

    expect(nextCursor).toBeNull()
    expect(marks.map((mark) => [mark.documentName, mark.number])).toEqual([
      ['Grundriss EG.pdf', 2],
      ['Grundriss EG.pdf', 5],
      ['Schnitt A-A.pdf', 1],
    ])
    expect(marks[0]).toMatchObject({ assigneeName: 'Jakob Huber', dueOn: '2026-10-20', onCurrentRevision: true })
    expect(marks[1]).toMatchObject({ onCurrentRevision: false })
    // What THIS reader may do is asked per document: Grundriss they may write, Schnitt only read.
    expect(marks.map((mark) => mark.canEdit)).toEqual([true, true, false])
    // The directory is read once for the page, however many documents it holds.
    expect(loadOrganizationDirectory).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/projects/[id]/annotations/export', () => {
  it('writes the marks the list shows, under a heading per document, and records the export', async () => {
    vi.mocked(listProjectAnnotationPage).mockResolvedValue(
      page([record(DOC_A, 2, { body: 'Brandschutztür fehlt' }), record(DOC_B, 1, { body: 'Höhenkote prüfen' })])
    )

    const response = await run(projectProtocolHref('proj_1', { assignee: 'me' }, 'md'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain(encodeURIComponent('Open points – Wohnhaus Lend.md'))
    const text = await response.text()
    expect(text).toContain('## Grundriss EG.pdf')
    expect(text).toContain('Brandschutztür fehlt')
    expect(text.indexOf('Grundriss')).toBeLessThan(text.indexOf('Schnitt'))
    expect(text).toContain('Assignee: Anna Berger')
    expect(query()).toMatchObject({ assigneeUserId: 'user_1', order: 'document', limit: 100 })
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.annotations.exported',
        targetType: 'project',
        targetId: 'proj_1',
        metadata: expect.objectContaining({ format: 'md', assignee: 'me', documentCount: 2, markCount: 2 }),
      })
    )
    expectRegistered(vi.mocked(recordAuditEvent).mock.calls[0][0])
  })

  it('refuses a Protokoll past its bound rather than cutting it', async () => {
    const full = Array.from({ length: 100 }, (_, index) => record(DOC_A, index + 1))
    const cursor = { due: '9999-12-31', name: 'grundriss eg.pdf', documentId: DOC_A, number: 100 }
    vi.mocked(listProjectAnnotationPage).mockResolvedValue(page(full, cursor))

    const response = await run(projectProtocolHref('proj_1', {}, 'pdf'))

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ details: { reason: 'too-many-marks' } })
    expect(vi.mocked(listProjectAnnotationPage).mock.calls).toHaveLength(PROJECT_PROTOCOL_MAX_MARKS / 100 + 1)
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('is refused for a project the reader may not view, and records nothing', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new ForbiddenError())

    const response = await run(projectProtocolHref('proj_1', {}, 'pdf'))

    expect(response.status).toBe(403)
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})
