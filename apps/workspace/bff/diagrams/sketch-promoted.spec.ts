/**
 * @vitest-environment node
 *
 * The step after a Freigabe made a Skizze's Fassung current
 * (`./sketch-promoted.ts`): a failure to read its bytes or draw its PDF is
 * scored and handed to a `sketch_rendition` job, which runs it again as the
 * releaser until it lands (the coherence review's finding 2: it used to be a
 * `console.error`, and the PDF kept the replaced drawing for good). The marking
 * is in the office's language, not German by default (finding 8).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const send = vi.fn()
vi.mock('@/lib/s3', () => ({ s3Client: { send: (...a: unknown[]) => send(...a) } }))
vi.mock('@/lib/storage/bucket', () => ({ resolveDocumentBucket: () => 'bucket' }))
vi.mock('@/lib/db', () => ({ getDb: () => ({ transaction: (run: (tx: unknown) => unknown) => run({}) }) }))
const moveSketchMarks = vi.fn(async () => ({ moved: ['ann_1'], lost: [] }))
vi.mock('@/lib/annotations/sketch-carry', () => ({ moveSketchMarks: (...a: unknown[]) => moveSketchMarks(...(a as [])) }))
const redrawCompanionPdf = vi.fn()
vi.mock('./sketch-companion', () => ({ redrawCompanionPdf: (...a: unknown[]) => redrawCompanionPdf(...a) }))
vi.mock('./svg', () => ({ parseDiagramSvg: () => ({ root: {}, viewport: {} }) }))
vi.mock('./stored-source', () => ({ storedDiagramSource: () => ({ kind: 'excalidraw', source: '{}' }) }))
vi.mock('./sketch-scene', () => ({ parseStoredSketchScene: () => ({ elements: [{ id: 'el_1' }] }), sceneHashOf: () => 42 }))
vi.mock('@/lib/annotations/sketch-anchor', () => ({ viewBoxOf: () => ({ width: 100, height: 100 }) }))
const enqueueJob = vi.fn(async () => ({ jobId: 'job_1' }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: (...a: unknown[]) => enqueueJob(...(a as [])) }))
const recordSketchReleasedScore = vi.fn(async () => {})
vi.mock('@/lib/langfuse/sketch-score', () => ({ recordSketchReleasedScore: (...a: unknown[]) => recordSketchReleasedScore(...(a as [])) }))
const findOrganization = vi.fn()
vi.mock('@/lib/organizations/repository', () => ({ findOrganization: (...a: unknown[]) => findOrganization(...a) }))
const getAccessibleDocument = vi.fn()
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: (...a: unknown[]) => getAccessibleDocument(...a) }))
const findDocumentVersion = vi.fn()
vi.mock('@/lib/documents/version-repository', () => ({ findDocumentVersion: (...a: unknown[]) => findDocumentVersion(...a) }))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn(async () => {}) }))

import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { releasedSketch, runSketchRenditionSlice } from './sketch-promoted'

const session = {
  userId: 'user_chief',
  organizationId: 'org_1',
  email: 'c@example.test',
  name: 'Eva Chef',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
} as never
const DOC_ID = '00000000-0000-4000-8000-000000000001'
const VER_ID = '00000000-0000-4000-8000-000000000003'
const document = {
  id: DOC_ID,
  organizationId: 'org_1',
  authoredByRef: 'msg_1-1a2b3c4d',
  filename: 'Grundriss.svg',
  displayName: null,
  publishedVersionId: '00000000-0000-4000-8000-000000000003',
} as never
const version = { id: VER_ID, storageBucket: null, storageKey: 'k' } as never
const bytes = () => ({ Body: { transformToString: async () => '<svg/>' } })

beforeEach(() => {
  vi.clearAllMocks()
  send.mockImplementation(async () => bytes())
  findOrganization.mockResolvedValue({ defaultLocale: null })
})

describe('the step after a Freigabe', () => {
  it('a PDF that is not drawn: scored failed and a retry queued as the releaser', async () => {
    redrawCompanionPdf.mockResolvedValue({ pdf: null, outcome: 'failed' })
    const done = await releasedSketch(session, document, version)
    expect(done).toMatchObject({ pdf: 'failed', placed: ['ann_1'] })
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'sketch_rendition',
        organizationId: 'org_1',
        payload: expect.objectContaining({ documentId: DOC_ID, versionId: VER_ID, requester: expect.objectContaining({ userId: 'user_chief' }) }),
      })
    )
    expect(recordSketchReleasedScore).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', attempt: 1, queued: true }))
  })

  it('bytes that cannot be read: scored unreadable, a retry queued, never thrown', async () => {
    send.mockRejectedValue(new Error('object store down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(releasedSketch(session, document, version)).resolves.toBeNull()
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(recordSketchReleasedScore).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unreadable', queued: true }))
  })

  it('a PDF drawn: scored, nothing queued, the marking in the office language', async () => {
    findOrganization.mockResolvedValue({ defaultLocale: 'en' })
    redrawCompanionPdf.mockResolvedValue({ pdf: { documentId: 'pdf', versionId: 'v' }, outcome: 'redrawn' })
    await releasedSketch(session, document, version)
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(recordSketchReleasedScore).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'redrawn', queued: false }))
    expect(redrawCompanionPdf).toHaveBeenCalledWith(expect.objectContaining({ marking: diagramsCopy.messages.en.markingEdited }))
  })
})

describe('the sketch_rendition job', () => {
  const payload = { documentId: DOC_ID, versionId: VER_ID, requester: {} } as never

  it('runs the step again and throws while the PDF still fails, so the queue retries', async () => {
    getAccessibleDocument.mockResolvedValue(document)
    findDocumentVersion.mockResolvedValue(version)
    redrawCompanionPdf.mockResolvedValue({ pdf: null, outcome: 'failed' })
    await expect(runSketchRenditionSlice(session, payload, 2)).rejects.toThrow(/not drawn again/)
    expect(recordSketchReleasedScore).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', attempt: 2 }))
  })

  it('ends, drawing nothing, once a newer Fassung is current', async () => {
    getAccessibleDocument.mockResolvedValue({ ...(document as object), publishedVersionId: 'newer' })
    await expect(runSketchRenditionSlice(session, payload, 2)).resolves.toMatchObject({ done: true })
    expect(redrawCompanionPdf).not.toHaveBeenCalled()
  })

  it('lands: done, the marks placed and the PDF drawn', async () => {
    getAccessibleDocument.mockResolvedValue(document)
    findDocumentVersion.mockResolvedValue(version)
    redrawCompanionPdf.mockResolvedValue({ pdf: { documentId: 'pdf', versionId: 'v' }, outcome: 'redrawn' })
    await expect(runSketchRenditionSlice(session, payload, 3)).resolves.toMatchObject({ done: true })
    expect(moveSketchMarks).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: 'place' }))
  })
})
