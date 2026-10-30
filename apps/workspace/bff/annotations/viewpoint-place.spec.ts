/**
 * @vitest-environment node
 */
/**
 * Where a mark on a model goes (`./viewpoint-place.ts`): each refusal a caller
 * can act on, in the words and with the `reason` it reads, and the rows a
 * valid request makes. The model, its elements and the object store are
 * mocked at their seams.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/s3', () => ({ s3Client: { send: vi.fn() }, bucketName: 'shared-bucket' }))
vi.mock('@/lib/bim/repository', () => ({ findBimModelByDocument: vi.fn() }))
vi.mock('./viewpoint-repository', () => ({ findMissingElements: vi.fn() }))

import { BadRequestError, UnprocessableError } from '@/lib/api/errors'
import { findBimModelByDocument } from '@/lib/bim/repository'
import type { Document } from '@/lib/db/schema/documents'
import { memberReader } from '@/lib/documents/visibility'
import { findMissingElements } from './viewpoint-repository'
import { decodeSnapshot } from './viewpoint-snapshot'
import { MAX_REPORTED_MISSING, placeViewpoint, refuseBoxOnModel, type ViewpointMarkInput } from './viewpoint-place'
import { MAX_SNAPSHOT_BYTES, viewpointInputSchema } from './viewpoint-types'

const READER = memberReader('user_1')
const DOC = {
  id: 'doc_1',
  organizationId: 'org_1',
  filename: 'Haus.ifc',
  storageKey: 'org_1/doc_1/Haus.ifc',
  storageBucket: null,
} as Partial<Document> as Document

const ID = '2O2Fr$t4X7Zf8NOew3FLOH'
const OTHER = '3pGKgn9xH4$PdVA0l_Bk8z'

const viewpoint = (patch: Record<string, unknown> = {}) =>
  viewpointInputSchema.parse({
    camera: {
      type: 'perspective',
      position: { x: 1, y: 2, z: 3 },
      direction: { x: 0, y: 1, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fieldOfView: 60,
      aspectRatio: 1.5,
    },
    components: { selection: { globalIds: [ID] }, visibility: { defaultVisibility: true, exceptions: [OTHER] }, coloring: [] },
    ...patch,
  })

const input = (patch: Partial<ViewpointMarkInput> = {}): ViewpointMarkInput => ({
  kind: 'defect',
  body: 'Lintel missing.',
  viewpoint: viewpoint(),
  ...patch,
})

const model = (patch: Record<string, unknown> = {}) =>
  ({ id: 'model_1', status: 'ready', summary: { truncatedAt: null }, ...patch }) as Awaited<ReturnType<typeof findBimModelByDocument>>

const refusal = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error)

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findBimModelByDocument).mockResolvedValue(model())
  vi.mocked(findMissingElements).mockResolvedValue([])
})

describe('a viewpoint on a document that is not a model', () => {
  it('is a 400 not_a_model when the name says it is no IFC, without looking for a model', async () => {
    const error = await refusal(placeViewpoint({ ...DOC, filename: 'Grundriss.pdf' } as Document, input(), READER))
    expect(error).toBeInstanceOf(BadRequestError)
    expect((error as BadRequestError).details).toEqual({ reason: 'not_a_model' })
    expect(findBimModelByDocument).not.toHaveBeenCalled()
  })

  it('is a 400 not_a_model when an IFC has no model row the reader may see', async () => {
    vi.mocked(findBimModelByDocument).mockResolvedValue(null)
    const error = await refusal(placeViewpoint(DOC, input(), READER))
    expect(error).toBeInstanceOf(BadRequestError)
    expect((error as BadRequestError).details).toEqual({ reason: 'not_a_model' })
    expect(findBimModelByDocument).toHaveBeenCalledWith('doc_1', 'org_1', READER)
  })
})

describe('a box or elements on a model', () => {
  it('is a 422 that says a mark on a model sets a viewpoint', async () => {
    const error = await refusal(refuseBoxOnModel(DOC, READER))
    expect(error).toBeInstanceOf(UnprocessableError)
    expect((error as Error).message).toBe('A mark on a model sets a viewpoint: send viewpoint, not a box or elementIds.')
  })

  it('goes through on a document that is no model, and on an IFC with no model row', async () => {
    await expect(refuseBoxOnModel({ ...DOC, filename: 'Grundriss.pdf' } as Document, READER)).resolves.toBeUndefined()
    vi.mocked(findBimModelByDocument).mockResolvedValue(null)
    await expect(refuseBoxOnModel(DOC, READER)).resolves.toBeUndefined()
  })

  it('is refused beside a viewpoint: exactly one place', async () => {
    const error = await refusal(placeViewpoint(DOC, input({ page: 1, shape: 'point', x: 0.1, y: 0.1 }), READER))
    expect(error).toBeInstanceOf(BadRequestError)
  })
})

describe('a model that is not ready', () => {
  it.each(['pending', 'extracting', 'failed'])('is a 422 model_not_ready while it is %s', async (status) => {
    vi.mocked(findBimModelByDocument).mockResolvedValue(model({ status }))
    const error = await refusal(placeViewpoint(DOC, input(), READER))
    expect(error).toBeInstanceOf(UnprocessableError)
    expect((error as UnprocessableError).details).toEqual({ reason: 'model_not_ready' })
  })
})

describe('elements that are not in the model', () => {
  it('names the first twenty missing ones in a 422 unknown_elements', async () => {
    const missing = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(22, 'M')}`)
    vi.mocked(findMissingElements).mockResolvedValue(missing)
    const error = await refusal(placeViewpoint(DOC, input(), READER))
    expect(error).toBeInstanceOf(UnprocessableError)
    expect((error as UnprocessableError).details).toEqual({ reason: 'unknown_elements', missing: missing.slice(0, MAX_REPORTED_MISSING) })
  })

  it('checks the selection and the pin’s element, once each, and not the exceptions', async () => {
    const pinned = viewpoint({ pin: { point: { x: 0, y: 0, z: 0 }, globalId: OTHER } })
    await placeViewpoint(DOC, input({ viewpoint: pinned }), READER)
    expect(findMissingElements).toHaveBeenCalledWith('org_1', 'model_1', [ID, OTHER], READER)
    vi.mocked(findMissingElements).mockClear()
    await placeViewpoint(DOC, input(), READER)
    expect(findMissingElements).toHaveBeenCalledWith('org_1', 'model_1', [ID], READER)
  })

  it('is not checked when the model’s element list is truncated: a missing id may be in the part not stored', async () => {
    vi.mocked(findBimModelByDocument).mockResolvedValue(model({ summary: { truncatedAt: 200_000 } }))
    vi.mocked(findMissingElements).mockResolvedValue([ID])
    await expect(placeViewpoint(DOC, input(), READER)).resolves.toBeDefined()
    expect(findMissingElements).not.toHaveBeenCalled()
  })
})

describe('a snapshot', () => {
  const asBase64 = (bytes: Buffer) => bytes.toString('base64')

  it('is a 422 bad_snapshot when the bytes are not the image the type says', async () => {
    const snapshot = { contentType: 'image/png' as const, dataBase64: asBase64(JPEG) }
    const error = await refusal(placeViewpoint(DOC, input({ viewpoint: viewpoint({ snapshot }) }), READER))
    expect(error).toBeInstanceOf(UnprocessableError)
    expect((error as UnprocessableError).details).toEqual({ reason: 'bad_snapshot' })
  })

  it('is a 422 bad_snapshot when it decodes to more than 1.5 MB', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_SNAPSHOT_BYTES)])
    expect(() => decodeSnapshot({ contentType: 'image/png', dataBase64: asBase64(big) })).toThrow(/larger than 1.5 MB/)
  })

  it('is a 422 bad_snapshot when the text decodes to nothing', () => {
    expect(() => decodeSnapshot({ contentType: 'image/jpeg', dataBase64: '!!!' })).toThrow(UnprocessableError)
  })

  it('stores a PNG and a JPEG under the document’s _bim/viewpoints prefix, by the viewpoint id', async () => {
    const png = await placeViewpoint(DOC, input({ viewpoint: viewpoint({ snapshot: { contentType: 'image/png', dataBase64: asBase64(PNG) } }) }), READER)
    expect(png.snapshot?.key).toBe(`org_1/doc_1/_bim/viewpoints/${png.viewpoint.id}.png`)
    expect(png.viewpoint.snapshotBytes).toBe(PNG.length)
    expect(png.viewpoint.snapshotContentType).toBe('image/png')
    const jpeg = await placeViewpoint(DOC, input({ viewpoint: viewpoint({ snapshot: { contentType: 'image/jpeg', dataBase64: asBase64(JPEG) } }) }), READER)
    expect(jpeg.snapshot?.key).toMatch(/\/_bim\/viewpoints\/[0-9a-f-]{36}\.jpg$/)
  })
})

describe('a valid viewpoint', () => {
  it('makes the viewpoint row and the mark’s own fields, with no box', async () => {
    const placed = await placeViewpoint(DOC, input({ basis: null, mentions: [] }), READER)
    expect(placed.snapshot).toBeNull()
    expect(placed.viewpoint).toMatchObject({
      cameraKind: 'perspective',
      selectionIds: [ID],
      defaultVisibility: true,
      visibilityExceptionIds: [OTHER],
      clippingPlanes: [],
      coloring: [],
      pinPoint: null,
      pinGlobalId: null,
      snapshotKey: null,
      snapshotBytes: null,
    })
    expect(placed.mark).toEqual({ kind: 'defect', body: 'Lintel missing.', mentions: [], basis: null, assigneeUserId: null, dueOn: null })
    expect(placed.mark).not.toHaveProperty('page')
  })
})
