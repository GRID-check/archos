/**
 * @vitest-environment node
 */
/**
 * The BCF 3.0 export's reads (`./bcf3-service.ts`): the gate it asks, which
 * marks it carries, who is named how, and what a missing or oversized picture
 * does. The reads are mocked; the mapping itself is `bcf3-build.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_NAME } from '@/lib/brand'

vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('./model-service', () => ({ getModelForDocument: vi.fn() }))
vi.mock('@/lib/annotations/service', () => ({ listAnnotations: vi.fn() }))
vi.mock('@/lib/annotations/viewpoint-repository', () => ({ findViewpoints: vi.fn() }))
vi.mock('@/lib/annotations/viewpoint-snapshot', () => ({ readSnapshot: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/agent-api/acting-session', () => ({ actingReaderIsAgent: vi.fn(() => false) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/i18n/server', async () => {
  const { translatorFor } = await import('@/i18n/namespace')
  return {
    getLocale: vi.fn().mockResolvedValue('de'),
    getTranslations: vi.fn(async (namespace: Namespace, scope?: string) => translatorFor(namespace, 'de', scope)),
  }
})

import type { Namespace } from '@/i18n/namespace'
import { NotFoundError } from '@/lib/api/errors'
import { actingReaderIsAgent } from '@/lib/agent-api/acting-session'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from '@/lib/documents/access'
import { listAnnotations } from '@/lib/annotations/service'
import { AGENT_AUTHOR, annotationReplyViewSchema, type AnnotationReplyView, type AnnotationView } from '@/lib/annotations/types'
import { findViewpoints } from '@/lib/annotations/viewpoint-repository'
import { readSnapshot } from '@/lib/annotations/viewpoint-snapshot'
import type { AnnotationViewpointRow } from '@/lib/db/schema/annotation-viewpoints'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { makeDocument } from '@/test-utils/db-fixtures'
import { readZipEntries } from '@/test-utils/read-zip'
import { exportAnnotationsBcf3, MAX_BCF3_AGENT_SNAPSHOT_BYTES, MAX_BCF3_SNAPSHOT_BYTES } from './bcf3-service'
import { getModelForDocument } from './model-service'

const SESSION = { userId: 'user_anna', organizationId: 'org_1', email: 'anna@buero.test', name: 'Anna Berger' } as AuthorizedSession
const uuid = (n: number) => `5b1a2c3d-0000-4000-8000-${String(n).padStart(12, '0')}`
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

const reply = (overrides: Partial<AnnotationReplyView> = {}): AnnotationReplyView =>
  annotationReplyViewSchema.parse({
  id: uuid(900),
  annotationId: uuid(1),
  authorKind: 'person',
  body: 'Ergänzt.',
  createdBy: 'user_max',
  createdByName: 'Max Huber',
  createdAt: '2026-10-29T09:00:00.000Z',
  editedAt: null,
  ...overrides,
  })

const mark = (n: number, overrides: Partial<AnnotationView> = {}): AnnotationView => ({
  id: uuid(n),
  documentId: 'doc_1',
  number: n,
  anchor: 'viewpoint',
  page: null,
  shape: null,
  x: null,
  y: null,
  w: null,
  h: null,
  viewpoint: { id: uuid(100 + n), cameraKind: 'perspective', selectionCount: 1, hasSection: false, hasSnapshot: true },
  kind: 'defect',
  body: `Mangel ${n}`,
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: 'user_max',
  assigneeName: 'Max Huber',
  dueOn: '2026-11-06',
  revisionNumber: 1,
  onCurrentRevision: true,
  createdBy: 'user_anna',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-29T08:00:00.000Z',
  updatedAt: '2026-10-29T08:00:00.000Z',
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
  canDelete: true,
  ...overrides,
})

const row = (n: number, overrides: Partial<AnnotationViewpointRow> = {}): AnnotationViewpointRow => ({
  id: uuid(100 + n),
  organizationId: 'org_1',
  documentId: 'doc_1',
  versionId: null,
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
  selectionIds: ['2O2Fr$t4X7Zf8NOew3FLKU'],
  defaultVisibility: true,
  visibilityExceptionIds: [],
  coloring: [],
  pinPoint: null,
  pinGlobalId: null,
  snapshotKey: `x/_bim/viewpoints/${uuid(100 + n)}.png`,
  snapshotContentType: 'image/png',
  snapshotBytes: PNG.length,
  carriedFromId: null,
  createdBy: 'user_anna',
  createdAt: new Date('2026-10-29T08:00:00.000Z'),
  ...overrides,
})

const MODEL = {
  id: 'model_1',
  documentId: 'doc_1',
  filename: 'Haus A.ifc',
  updatedAt: new Date('2026-10-28T10:00:00.000Z'),
  summary: { spatial: { ifcType: 'IfcProject', globalId: '0Yl3Uz1Kv9wxKQ8bqZ3aB1' } },
} as unknown as NonNullable<Awaited<ReturnType<typeof getModelForDocument>>>

function given(marks: AnnotationView[], rows: AnnotationViewpointRow[] = marks.map((m) => row(m.number))) {
  vi.mocked(listAnnotations).mockResolvedValue({ annotations: marks, canAnnotate: true } as Awaited<ReturnType<typeof listAnnotations>>)
  vi.mocked(findViewpoints).mockResolvedValue(rows)
}

const files = async (scope: 'all' | 'open' = 'all') => {
  const file = await exportAnnotationsBcf3(SESSION, 'doc_1', { scope })
  return { file, entries: readZipEntries(file.bytes) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(actingReaderIsAgent).mockReturnValue(false)
  vi.mocked(getAccessibleDocument).mockResolvedValue(makeDocument({ id: 'doc_1', filename: 'Haus A.ifc' }))
  vi.mocked(getModelForDocument).mockResolvedValue(MODEL)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      ['user_anna', { userId: 'user_anna', email: 'anna@buero.test', name: 'Anna Berger', profilePictureUrl: null }],
      ['user_max', { userId: 'user_max', email: 'max@buero.test', name: 'Max Huber', profilePictureUrl: null }],
    ])
  )
  vi.mocked(readSnapshot).mockResolvedValue(PNG)
  given([mark(2), mark(1)])
})

describe('exportAnnotationsBcf3', () => {
  it('reads through the listing gate and the model gate, in that document', async () => {
    await files()
    expect(getAccessibleDocument).toHaveBeenCalledWith(SESSION, 'doc_1', 'read')
    expect(getModelForDocument).toHaveBeenCalledWith(SESSION, 'doc_1')
    expect(listAnnotations).toHaveBeenCalledWith(SESSION, 'doc_1')
  })

  it('is a 404 for a reader without access, and reads nothing', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    await expect(files()).rejects.toMatchObject({ status: 404 })
    expect(listAnnotations).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('is a 422 for a document that is no model', async () => {
    vi.mocked(getModelForDocument).mockResolvedValue(null)
    await expect(files()).rejects.toMatchObject({ status: 422 })
  })

  it('names the file as the Protokoll does and orders topics by number, people by email', async () => {
    const { file, entries } = await files()
    expect(file.filename).toBe('Anmerkungen – Haus A.bcf')
    expect(file.topics).toBe(2)
    const folders = [...entries.keys()].filter((path) => path.endsWith('/'))
    expect(folders).toEqual([`${uuid(1)}/`, `${uuid(2)}/`])
    const markup = entries.get(`${uuid(1)}/markup.bcf`) ?? ''
    expect(markup).toContain('<CreationAuthor>anna@buero.test</CreationAuthor>')
    expect(markup).toContain('<AssignedTo>max@buero.test</AssignedTo>')
    expect(markup).toContain('IfcProject="0Yl3Uz1Kv9wxKQ8bqZ3aB1"')
    expect(entries.has(`${uuid(1)}/${uuid(101)}.png`)).toBe(true)
  })

  it('never carries the agent’s untaken proposals, a mark without a viewpoint, or (scope open) a closed one', async () => {
    given([
      mark(1),
      mark(2, { authorKind: AGENT_AUTHOR, status: 'proposed' }),
      mark(3, { authorKind: AGENT_AUTHOR, status: 'dismissed' }),
      mark(4, { authorKind: AGENT_AUTHOR, status: 'open', acceptedBy: 'user_anna', acceptedByName: 'Anna Berger', basis: 'OIB-RL 2, 3.1' }),
      mark(5, { viewpoint: null, anchor: 'page' }),
      mark(6, { status: 'resolved', closedBy: 'user_max', closedByName: 'Max Huber', closedAt: '2026-10-30T07:00:00.000Z' }),
    ])
    const all = await files('all')
    expect([...all.entries.keys()].filter((p) => p.endsWith('/'))).toEqual([`${uuid(1)}/`, `${uuid(4)}/`, `${uuid(6)}/`])
    expect(all.entries.get(`${uuid(4)}/markup.bcf`)).toMatch(new RegExp(`Grundlage: OIB-RL 2, 3\\.1\n\nvon ${PRODUCT_NAME} gesetzt · für Anna Berger · \\d`))
    const closed = all.entries.get(`${uuid(6)}/markup.bcf`) ?? ''
    expect(closed).toContain('TopicStatus="Resolved"')
    expect(closed).toContain('<ModifiedAuthor>max@buero.test</ModifiedAuthor>')
    const open = await files('open')
    expect([...open.entries.keys()].filter((p) => p.endsWith('/'))).toEqual([`${uuid(1)}/`, `${uuid(4)}/`])
  })

  it('writes the agent’s replies under the product name, and falls back to the name when the directory has no email', async () => {
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
    given([mark(1, { replies: [reply({ id: uuid(901), authorKind: AGENT_AUTHOR, createdBy: 'user_anna' }), reply()] })])
    const markup = (await files()).entries.get(`${uuid(1)}/markup.bcf`) ?? ''
    expect(markup).toContain(`<Author>${PRODUCT_NAME}</Author>`)
    expect(markup).toContain('<Author>Max Huber</Author>')
    expect(markup).toContain('<CreationAuthor>Anna Berger</CreationAuthor>')
  })

  it('relates a topic only to one in the same file', async () => {
    const from = (n: number) => ({ annotationId: uuid(n).toUpperCase(), documentId: 'doc_1', number: n, documentName: 'Haus A.ifc' })
    given([
      mark(1),
      mark(2, { carriedFrom: from(1) }),
      // Carried from the replaced Fassung: that topic is not in this file.
      mark(3, { carriedFrom: { ...from(77), documentId: 'doc_0' } }),
      mark(4, { status: 'resolved', closedBy: 'user_max', closedAt: '2026-10-30T07:00:00.000Z' }),
      mark(5, { carriedFrom: from(4) }),
    ])
    const all = (await files('all')).entries
    expect(all.get(`${uuid(2)}/markup.bcf`)).toContain(`<RelatedTopic Guid="${uuid(1)}" />`)
    expect(all.get(`${uuid(3)}/markup.bcf`)).not.toContain('RelatedTopic')
    expect(all.get(`${uuid(5)}/markup.bcf`)).toContain(`<RelatedTopic Guid="${uuid(4)}" />`)
    // With scope open the resolved mark stays out, and so does the reference to it.
    expect((await files('open')).entries.get(`${uuid(5)}/markup.bcf`)).not.toContain('RelatedTopic')
  })

  it('keeps a topic whose picture is gone, and says so', async () => {
    vi.mocked(readSnapshot).mockRejectedValue(new NotFoundError())
    const { file, entries } = await files()
    expect(file.snapshotsOmitted).toBe(2)
    expect(entries.has(`${uuid(1)}/${uuid(101)}.png`)).toBe(false)
    expect(entries.get(`${uuid(1)}/markup.bcf`)).not.toContain('<Snapshot>')
    expect(entries.get(`${uuid(1)}/markup.bcf`)).toContain(`<Viewpoint>${uuid(101)}.bcfv</Viewpoint>`)
  })

  it('does not hide a failing store behind a missing picture', async () => {
    vi.mocked(readSnapshot).mockRejectedValue(new Error('store down'))
    await expect(files()).rejects.toThrow('store down')
  })

  it('bounds the pictures in mark order by stored size, reads nothing past the bound, and is the same file twice', async () => {
    const half = Math.floor(MAX_BCF3_SNAPSHOT_BYTES / 2)
    // The repository's order is not the marks' order: the bound follows the marks.
    given([mark(3), mark(1), mark(2)], [3, 2, 1].map((n) => row(n, { snapshotBytes: half })))
    const first = await files()
    expect(first.file.snapshotsOmitted).toBe(1)
    expect(vi.mocked(readSnapshot).mock.calls.map(([, key]) => key)).toEqual([row(1).snapshotKey, row(2).snapshotKey])
    expect(first.entries.has(`${uuid(3)}/${uuid(103)}.png`)).toBe(false)
    expect(first.entries.has(`${uuid(1)}/${uuid(101)}.png`)).toBe(true)
    given([mark(2), mark(3), mark(1)], [1, 3, 2].map((n) => row(n, { snapshotBytes: half })))
    const second = await files()
    expect(Buffer.from(second.file.bytes).equals(Buffer.from(first.file.bytes))).toBe(true)
  })

  it('keeps an agent’s file under what the door sends inline', async () => {
    vi.mocked(actingReaderIsAgent).mockReturnValue(true)
    given([mark(1), mark(2)], [1, 2].map((n) => row(n, { snapshotBytes: MAX_BCF3_AGENT_SNAPSHOT_BYTES - 10 })))
    const { file } = await files()
    expect(file.snapshotsOmitted).toBe(1)
    expect(readSnapshot).toHaveBeenCalledTimes(1)
  })

  it('audits what it carried, never a name', async () => {
    await files('open')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'document.annotations.exported',
        targetId: 'doc_1',
        metadata: { format: 'bcf3', scope: 'open', revision: 'all', includeProposals: false, markCount: 2, proposalCount: 0 },
      })
    )
  })
})
