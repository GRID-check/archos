/**
 * @vitest-environment node
 */
/**
 * The BCF import (`./bcf-import-service.ts`) end to end with the writes
 * mocked: our own BCF 3.0 export read back into a fresh model gives the same
 * marks; a hand-written BCF 2.1 file from another tool imports with its
 * vocabulary mapped and noted; a second import skips what is there; the cap
 * and the refusals hold. The archive's and the XML's own refusals are
 * `bcf-archive.spec.ts` and `bcf-xml.spec.ts`; the SQL is
 * `annotations/import-repository.integration.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('./model-service', () => ({ getModelForDocument: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/documents/may-open', () => ({ mayOpenDocument: vi.fn(), mayWriteDocument: vi.fn() }))
vi.mock('@/lib/annotations/import-repository', () => ({
  importedTopicGuids: vi.fn(),
  insertImportedMark: vi.fn(),
  TopicImportedTwiceError: class TopicImportedTwiceError extends Error {},
}))
vi.mock('@/lib/annotations/viewpoint-repository', () => ({ findMissingElements: vi.fn() }))
vi.mock('@/lib/annotations/viewpoint-snapshot', () => ({
  putSnapshot: vi.fn().mockResolvedValue(undefined),
  discardSnapshot: vi.fn().mockResolvedValue(undefined),
  snapshotUploadOf: vi.fn((_doc: unknown, id: string, contentType: string, body: Buffer) => ({ bucket: 'b', key: `k/${id}`, contentType, body })),
}))
vi.mock('@/lib/annotations/attention', () => ({ onMarksSet: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/annotations/import-attention', () => ({ onMarksAssignedByImport: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/i18n/server', async () => {
  const { translatorFor } = await import('@/i18n/namespace')
  return {
    getLocale: vi.fn().mockResolvedValue('de'),
    getTranslations: vi.fn(async (namespace: Namespace, scope?: string) => translatorFor(namespace, 'de', scope)),
  }
})

import { strToU8, zipSync } from 'fflate'
import type { Namespace } from '@/i18n/namespace'
import { captureServer } from '@/lib/analytics/posthog-server'
import { onMarksAssignedByImport } from '@/lib/annotations/import-attention'
import { discardSnapshot } from '@/lib/annotations/viewpoint-snapshot'
import { importedTopicGuids, insertImportedMark, type ImportedMarkInput } from '@/lib/annotations/import-repository'
import { AnnotationLimitReachedError } from '@/lib/annotations/numbering'
import { findMissingElements } from '@/lib/annotations/viewpoint-repository'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentAnnotationRow } from '@/lib/db/schema/document-annotations'
import { getAccessibleDocument } from '@/lib/documents/access'
import { mayOpenDocument, mayWriteDocument } from '@/lib/documents/may-open'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { makeDocument } from '@/test-utils/db-fixtures'
import { importAnnotationsBcf } from './bcf-import-service'
import { buildAnnotationsBcf3, type Bcf3Topic } from './bcf3-build'
import { getModelForDocument } from './model-service'

const SESSION = { userId: 'user_anna', organizationId: 'org_1', email: 'anna@buero.test', name: 'Anna Berger' } as AuthorizedSession
const uuid = (n: number) => `5b1a2c3d-0000-4000-8000-${String(n).padStart(12, '0')}`
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9])
const WALL = '2O2Fr$t4X7Zf8NOew3FLOH'
const BEAM = '3pGKgn9xH4$PdVA0l_Bk8z'
const SLAB = '1hOSvn6df7weDDVAKgmDHz'

const MODEL = { id: 'model_1', status: 'ready', summary: {} } as unknown as NonNullable<Awaited<ReturnType<typeof getModelForDocument>>>

const people = [
  { userId: 'user_anna', email: 'anna@buero.test', name: 'Anna Berger', profilePictureUrl: null },
  { userId: 'user_max', email: 'max@buero.test', name: 'Max Huber', profilePictureUrl: null },
  // In the office, but may only read the model: an author, never a Zuständige.
  { userId: 'user_lea', email: 'lea@buero.test', name: 'Lea Gruber', profilePictureUrl: null },
]

let written: ImportedMarkInput[] = []

const upload = (bytes: Uint8Array, name = 'Runde 3.bcf') => importAnnotationsBcf(SESSION, 'doc_fresh', { name, bytes })

beforeEach(() => {
  vi.clearAllMocks()
  written = []
  vi.mocked(getAccessibleDocument).mockResolvedValue(makeDocument({ id: 'doc_fresh', filename: 'Haus A.ifc', scope: 'project' }))
  vi.mocked(getModelForDocument).mockResolvedValue(MODEL)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map(people.map((person) => [person.userId, person])))
  vi.mocked(mayWriteDocument).mockImplementation(async (_tenant, _doc, ids) => new Set(ids.filter((id) => id !== 'user_lea')))
  vi.mocked(mayOpenDocument).mockImplementation(async (_tenant, _doc, ids) => new Set(ids))
  vi.mocked(importedTopicGuids).mockResolvedValue(new Set())
  vi.mocked(findMissingElements).mockResolvedValue([])
  vi.mocked(insertImportedMark).mockImplementation(async (input) => {
    written.push(input)
    return { id: `mark_${written.length}`, number: written.length, body: input.mark.body } as DocumentAnnotationRow
  })
})

const topic = (n: number, overrides: Partial<Bcf3Topic> = {}): Bcf3Topic => ({
  id: uuid(n),
  number: n,
  kind: 'defect',
  status: 'open',
  body: `Auflager fehlt ${n}`,
  notes: [],
  assignedTo: 'max@buero.test',
  dueOn: '2026-11-06',
  createdBy: 'anna@buero.test',
  createdAt: new Date('2026-10-29T08:00:00Z'),
  modified: null,
  replies: [],
  viewpoint: {
    id: uuid(100 + n),
    camera: {
      type: 'perspective',
      position: { x: 2683010.5, y: 1245020.25, z: 12 },
      direction: { x: 0, y: 1, z: -0.5 },
      up: { x: 0, y: 0, z: 1 },
      aspectRatio: 1.5,
      fieldOfView: 60,
    },
    clippingPlanes: [{ location: { x: 0, y: 0, z: 1 }, direction: { x: 0, y: 0, z: 1 } }],
    components: {
      selection: { globalIds: [WALL, BEAM] },
      visibility: { defaultVisibility: false, exceptions: [WALL, BEAM, SLAB] },
      coloring: [{ color: 'FF0000', globalIds: [BEAM] }],
    },
    snapshot: { contentType: 'image/png', bytes: PNG },
  },
  relatedTopicId: null,
  ...overrides,
})

const ownExport = (topics: Bcf3Topic[]) =>
  buildAnnotationsBcf3({ model: { filename: 'Haus A.ifc', ifcProjectGlobalId: null, updatedAt: new Date('2026-10-28T10:00:00Z') }, topics }).bytes

describe('our own BCF 3.0 export, imported into a fresh model', () => {
  const source = [
    topic(1, {
      body: 'Auflager fehlt\nDas Unterzug-Auflager auf der Stütze B3 ist nicht modelliert.',
      replies: [
        { id: uuid(901), author: 'max@buero.test', date: new Date('2026-10-29T09:00:00Z'), body: 'Ergänzt in Rev. 4.', editedAt: null },
        { id: uuid(902), author: 'statik@extern.test', date: new Date('2026-10-29T10:00:00Z'), body: 'Bitte prüfen.', editedAt: null },
      ],
    }),
    topic(2, {
      kind: 'question',
      status: 'resolved',
      assignedTo: null,
      dueOn: null,
      viewpoint: {
        ...topic(2).viewpoint!,
        camera: { type: 'orthographic', position: { x: 1, y: 2, z: 30 }, direction: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, aspectRatio: 1.25, viewToWorldScale: 18.5 },
        clippingPlanes: [],
        snapshot: { contentType: 'image/jpeg', bytes: JPEG },
      },
    }),
    topic(3, { kind: 'hint', status: 'dismissed', assignedTo: 'lea@buero.test' }),
  ]

  it('gives the same marks: kind, status, text, Zuständige, Frist, thread and the whole view', async () => {
    const result = await upload(ownExport(source))
    expect(result).toMatchObject({ version: '3.0', topics: 3, skipped: [], failed: [] })
    expect(result.imported.map((entry) => entry.topic)).toEqual(source.map((entry) => entry.id))
    expect(written).toHaveLength(3)
    for (const [index, input] of written.entries()) {
      const original = source[index]
      const view = original.viewpoint!
      expect(input.sourceTopicGuid).toBe(original.id)
      expect(input.mark).toMatchObject({ kind: original.kind, status: original.status, body: original.body, dueOn: original.dueOn })
      expect(input.viewpoint).toMatchObject({
        camera: view.camera,
        cameraKind: view.camera.type,
        clippingPlanes: view.clippingPlanes,
        selectionIds: view.components.selection.globalIds,
        defaultVisibility: view.components.visibility.defaultVisibility,
        visibilityExceptionIds: view.components.visibility.exceptions,
        coloring: view.components.coloring,
        snapshotContentType: view.snapshot?.contentType,
        snapshotBytes: view.snapshot?.bytes.length,
      })
      expect(input.createdBy).toBe('user_anna')
      expect(input.importBatchId).toBe(result.batchId)
    }
    expect(written.map((input) => input.mark.assigneeUserId)).toEqual(['user_max', null, null])
  })

  it('keeps each comment by its author where the email is someone here, else names them in the text', async () => {
    await upload(ownExport(source))
    const [first, second, note] = written[0].replies
    expect(first).toMatchObject({ body: 'Ergänzt in Rev. 4.', createdBy: 'user_max', sourceDate: new Date('2026-10-29T09:00:00Z') })
    expect(second.createdBy).toBe('user_anna')
    expect(second.body).toBe('statik@extern.test:\nBitte prüfen.')
    expect(second.sourceDate).toEqual(new Date('2026-10-29T10:00:00Z'))
    expect(note.sourceDate).toBeNull()
    expect(note.body).toContain('Aus der BCF-Datei „Runde 3.bcf“ übernommen.')
    expect(note.body).toContain('Ursprünglich von anna@buero.test')
  })

  it('names a Zuständige in the thread who could not answer the mark', async () => {
    await upload(ownExport(source))
    const note = written[2].replies.at(-1)?.body ?? ''
    expect(note).toContain('Zuständig laut Datei: lea@buero.test.')
  })

  it('tells the new Zuständige and records the import with counts only', async () => {
    const result = await upload(ownExport(source))
    expect(onMarksAssignedByImport).toHaveBeenCalledTimes(1)
    expect(vi.mocked(onMarksAssignedByImport).mock.calls[0][0]).toMatchObject({
      batchId: result.batchId,
      actorUserId: 'user_anna',
      marks: [{ annotationId: 'mark_1', number: 1, assigneeUserId: 'user_max' }],
    })
    expect(vi.mocked(recordAuditEvent).mock.calls[0][0]).toMatchObject({
      action: 'document.annotations.imported',
      metadata: { format: 'bcf', version: '3.0', batchId: result.batchId, topicCount: 3, importedCount: 3, assignedCount: 1 },
    })
    expect(vi.mocked(captureServer).mock.calls[0][0]).toMatchObject({ event: 'annotations_imported', properties: { imported: 3, topics: 3 } })
  })

  it('dates every reply by its arrival, in the file’s order, and keeps the comment’s own date beside it', async () => {
    const before = Date.now()
    await upload(ownExport(source))
    const arrivals = written[0].replies.map((reply) => reply.createdAt.getTime())
    expect(arrivals[0]).toBeGreaterThanOrEqual(before)
    expect([...arrivals].sort((a, b) => a - b)).toEqual(arrivals)
    expect(new Set(arrivals).size).toBe(arrivals.length)
  })

  it('counts a topic a parallel import wrote first as already there, and takes its picture back', async () => {
    const { TopicImportedTwiceError } = await import('@/lib/annotations/import-repository')
    vi.mocked(insertImportedMark).mockRejectedValueOnce(new TopicImportedTwiceError())
    const result = await upload(ownExport([source[0]]))
    expect(result.skipped).toEqual([{ topic: source[0].id, title: 'Auflager fehlt', reason: 'already_imported' }])
    expect(discardSnapshot).toHaveBeenCalledTimes(1)
  })

  it('fails a topic whose write fails, takes its picture back, and goes on with the rest', async () => {
    vi.mocked(insertImportedMark).mockRejectedValueOnce(new Error('connection reset'))
    const result = await upload(ownExport(source))
    expect(result.failed).toEqual([{ topic: source[0].id, title: 'Auflager fehlt', reason: 'error' }])
    expect(result.imported).toHaveLength(2)
    expect(discardSnapshot).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordAuditEvent).mock.calls[0][0]).toMatchObject({ metadata: { importedCount: 2, failedCount: 1 } })
  })

  it('still records and tells what it wrote when the loop is cut short', async () => {
    let asked = 0
    const breaking = new Set<string>()
    breaking.has = () => {
      asked += 1
      if (asked > 1) throw new TypeError('a bug past the topic’s own catch')
      return false
    }
    vi.mocked(importedTopicGuids).mockResolvedValueOnce(breaking)
    await expect(upload(ownExport(source))).rejects.toThrow(TypeError)
    expect(vi.mocked(recordAuditEvent).mock.calls[0][0]).toMatchObject({ metadata: { importedCount: 1 } })
    expect(onMarksAssignedByImport).toHaveBeenCalledTimes(1)
  })

  it('skips every topic on a second import of the same file, and says so', async () => {
    vi.mocked(importedTopicGuids).mockResolvedValue(new Set(source.map((entry) => entry.id)))
    const result = await upload(ownExport(source))
    expect(written).toHaveLength(0)
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['already_imported', 'already_imported', 'already_imported'])
  })

  it('drops from the selection what this model lacks, and says how many', async () => {
    vi.mocked(findMissingElements).mockResolvedValue([BEAM])
    await upload(ownExport([source[0]]))
    expect(written[0].viewpoint.selectionIds).toEqual([WALL])
    expect(written[0].replies.at(-1)?.body).toContain('Ein ausgewähltes Bauteil ist nicht in diesem Modell.')
  })

  it('stops at the document’s cap and reports the rest as failed for it', async () => {
    vi.mocked(insertImportedMark).mockImplementationOnce(async (input) => {
      written.push(input)
      return { id: 'mark_1', number: 1, body: input.mark.body } as DocumentAnnotationRow
    })
    vi.mocked(insertImportedMark).mockRejectedValueOnce(new AnnotationLimitReachedError())
    const result = await upload(ownExport(source))
    expect(result.imported).toHaveLength(1)
    expect(result.failed.map((entry) => entry.reason)).toEqual(['limit', 'limit'])
    expect(insertImportedMark).toHaveBeenCalledTimes(2)
  })
})

/** A coordination tool's BCF 2.1, written by hand from the 2.1 schema: comments and views beside the topic. */
const MARKUP_21 = `<?xml version="1.0" encoding="utf-8"?>
<Markup xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Header><File IfcProject="0Yl3Uz1Kv9wxKQ8bqZ3aB1" isExternal="true"><Filename>TWP_Rev3.ifc</Filename></File></Header>
  <Topic Guid="A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F" TopicType="Clash" TopicStatus="Active">
    <Title>Kollision Unterzug / Lüftungskanal</Title>
    <Priority>Critical</Priority>
    <Index>12</Index>
    <CreationDate>2026-10-27T14:03:00+01:00</CreationDate>
    <CreationAuthor>statik@twp.test</CreationAuthor>
    <DueDate>2026-11-13T00:00:00</DueDate>
    <AssignedTo>haustechnik@hlk.test</AssignedTo>
    <Description>Kanal DN400 schneidet den Unterzug in Achse 4.</Description>
  </Topic>
  <Comment Guid="11111111-2222-4333-8444-555555555555">
    <Date>2026-10-28T09:15:00+01:00</Date>
    <Author>max@buero.test</Author>
    <Comment>Durchbruch wird mit der Statik abgestimmt.</Comment>
    <Viewpoint Guid="aaaaaaaa-1111-4222-8333-444444444444"/>
  </Comment>
  <Comment Guid="66666666-7777-4888-8999-000000000000">
    <Date>2026-10-28T11:00:00+01:00</Date>
    <Author>haustechnik@hlk.test</Author>
    <Comment>Kanal kann 20 cm tiefer.</Comment>
  </Comment>
  <Viewpoints Guid="aaaaaaaa-1111-4222-8333-444444444444">
    <Viewpoint>viewpoint.bcfv</Viewpoint>
    <Snapshot>snapshot.png</Snapshot>
  </Viewpoints>
  <Viewpoints Guid="bbbbbbbb-1111-4222-8333-444444444444">
    <Viewpoint>second.bcfv</Viewpoint>
  </Viewpoints>
</Markup>`

const VIEW_21 = `<?xml version="1.0" encoding="utf-8"?>
<VisualizationInfo Guid="aaaaaaaa-1111-4222-8333-444444444444">
  <Components>
    <ViewSetupHints SpacesVisible="false" SpaceBoundariesVisible="false" OpeningsVisible="false"/>
    <Selection>
      <Component IfcGuid="${BEAM}"/>
      <Component AuthoringToolId="4711"/>
    </Selection>
    <Visibility DefaultVisibility="true">
      <Exceptions><Component IfcGuid="${SLAB}"/></Exceptions>
    </Visibility>
    <Coloring>
      <Color Color="FFFF0000"><Component IfcGuid="${BEAM}"/></Color>
    </Coloring>
  </Components>
  <PerspectiveCamera>
    <CameraViewPoint><X>12.5</X><Y>-3</Y><Z>8</Z></CameraViewPoint>
    <CameraDirection><X>-0.5</X><Y>0.5</Y><Z>-0.7</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector>
    <FieldOfView>60</FieldOfView>
  </PerspectiveCamera>
  <ClippingPlanes>
    <ClippingPlane><Location><X>0</X><Y>0</Y><Z>3.2</Z></Location><Direction><X>0</X><Y>0</Y><Z>1</Z></Direction></ClippingPlane>
  </ClippingPlanes>
</VisualizationInfo>`

const NO_VIEW_21 = `<?xml version="1.0" encoding="utf-8"?>
<Markup><Topic Guid="c3c3c3c3-0000-4000-8000-000000000003" TopicType="Request" TopicStatus="Open"><Title>Brandschutzklappe?</Title></Topic></Markup>`

const coordinationRound = () =>
  zipSync({
    'bcf.version': strToU8('<?xml version="1.0"?><Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>'),
    'A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F/markup.bcf': strToU8(MARKUP_21),
    'A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F/viewpoint.bcfv': strToU8(VIEW_21),
    'A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F/second.bcfv': strToU8(VIEW_21.replace('12.5', '99')),
    'A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F/snapshot.png': PNG,
    'c3c3c3c3-0000-4000-8000-000000000003/markup.bcf': strToU8(NO_VIEW_21),
  })

describe('a hand-written BCF 2.1 file from another tool', () => {
  it('imports the topic with a view, mapping its vocabulary and saying what it mapped', async () => {
    const result = await upload(coordinationRound(), 'TWP Runde 3.bcfzip')
    expect(result.version).toBe('2.1')
    expect(result.imported).toHaveLength(1)
    expect(result.skipped).toEqual([{ topic: 'c3c3c3c3-0000-4000-8000-000000000003', title: 'Brandschutzklappe?', reason: 'no_viewpoint' }])
    const [input] = written
    expect(input.sourceTopicGuid).toBe('a2f1c3d4-5b6a-4c7d-8e9f-0a1b2c3d4e5f')
    expect(input.mark).toMatchObject({
      kind: 'defect',
      status: 'open',
      body: 'Kollision Unterzug / Lüftungskanal\n\nKanal DN400 schneidet den Unterzug in Achse 4.',
      assigneeUserId: null,
      dueOn: '2026-11-13',
    })
    expect(input.viewpoint).toMatchObject({
      camera: { type: 'perspective', position: { x: 12.5, y: -3, z: 8 }, fieldOfView: 60, aspectRatio: 16 / 9 },
      clippingPlanes: [{ location: { x: 0, y: 0, z: 3.2 }, direction: { x: 0, y: 0, z: 1 } }],
      selectionIds: [BEAM],
      defaultVisibility: true,
      visibilityExceptionIds: [SLAB],
      coloring: [{ color: 'FFFF0000', globalIds: [BEAM] }],
      snapshotContentType: 'image/png',
    })
    const [byMax, byOutsider, note] = input.replies
    expect(byMax).toMatchObject({ createdBy: 'user_max', body: 'Durchbruch wird mit der Statik abgestimmt.' })
    expect(byOutsider).toMatchObject({ createdBy: 'user_anna' })
    expect(byOutsider.body).toContain('haustechnik@hlk.test')
    for (const line of [
      'Ursprünglich von statik@twp.test',
      'Art in der Datei: Clash.',
      'Status in der Datei: Active.',
      'Zuständig laut Datei: haustechnik@hlk.test.',
      'Ein ausgewähltes Bauteil ist nicht übernommen',
    ]) {
      expect(note.body).toContain(line)
    }
  })

  it('takes a topic once when the file names it twice, and remembers a Guid that is no UUID by a UUIDv5 of it', async () => {
    const twice = zipSync({
      'x/markup.bcf': strToU8(MARKUP_21.replace('A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F', 'TWP-12')),
      'x/viewpoint.bcfv': strToU8(VIEW_21),
      'y/markup.bcf': strToU8(MARKUP_21.replace('A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F', 'TWP-12')),
      'y/viewpoint.bcfv': strToU8(VIEW_21),
    })
    const result = await upload(twice)
    expect(result.imported).toHaveLength(1)
    expect(result.skipped).toEqual([expect.objectContaining({ topic: 'TWP-12', reason: 'duplicate_in_file' })])
    expect(written[0].sourceTopicGuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('refusals', () => {
  it('refuses a document that is no model, a model not ready, and writes nothing', async () => {
    vi.mocked(getModelForDocument).mockResolvedValueOnce(null)
    await expect(upload(coordinationRound())).rejects.toMatchObject({ status: 422, details: { reason: 'not_a_model' } })
    vi.mocked(getModelForDocument).mockResolvedValueOnce({ ...MODEL, status: 'pending' } as unknown as typeof MODEL)
    await expect(upload(coordinationRound())).rejects.toMatchObject({ status: 422, details: { reason: 'model_not_ready' } })
    expect(insertImportedMark).not.toHaveBeenCalled()
  })

  it('refuses a malicious archive as a whole, with its reason', async () => {
    const traversal = zipSync({ '../../markup.bcf': strToU8(MARKUP_21) })
    await expect(upload(traversal)).rejects.toMatchObject({ status: 422, details: { reason: 'unsafe_path' } })
    expect(insertImportedMark).not.toHaveBeenCalled()
  })

  it('fails a topic whose markup declares an entity, and imports the others', async () => {
    const entity = zipSync({
      'bad/markup.bcf': strToU8('<?xml version="1.0"?><!DOCTYPE m [<!ENTITY x SYSTEM "file:///etc/passwd">]><Markup><Topic Guid="g"><Title>&x;</Title></Topic></Markup>'),
      'A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F/markup.bcf': strToU8(MARKUP_21),
      'A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F/viewpoint.bcfv': strToU8(VIEW_21),
    })
    const result = await upload(entity)
    expect(result.failed).toEqual([{ topic: 'bad', title: null, reason: 'bad_xml' }])
    expect(result.imported).toHaveLength(1)
  })

  it('refuses a BCF version it was not written against, and a ZIP that is no BCF file', async () => {
    const future = zipSync({ 'bcf.version': strToU8('<Version VersionId="4.0"/>') })
    await expect(upload(future)).rejects.toMatchObject({ details: { reason: 'unsupported_version' } })
    await expect(upload(zipSync({ 'readme.txt': strToU8('hi') }))).rejects.toMatchObject({ details: { reason: 'not_bcf' } })
  })
})
