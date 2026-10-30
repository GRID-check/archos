/**
 * @vitest-environment node
 */
/**
 * A Skizze's links read with the reader's rights: what they may open has a
 * title and a place; what is gone or theirs not to open is `unavailable` with
 * nothing more, whichever of the two it is. One bad link never fails the read,
 * and the cost grows with the documents named, not with the links.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema/documents'
import type { SketchOutlineLink } from './sketch-links'

vi.mock('server-only', () => ({}))

const access = vi.hoisted(() => ({ getAccessibleDocument: vi.fn() }))
const content = vi.hoisted(() => ({ versionBytesReadableBy: vi.fn() }))
const bim = vi.hoisted(() => ({ findElementsOfReadDocument: vi.fn() }))
const rows = vi.hoisted(() => ({ listPinnedVersions: vi.fn(), listAnnotationHeads: vi.fn() }))
vi.mock('@/lib/documents/access', () => access)
vi.mock('@/lib/documents/version-content', () => content)
vi.mock('@/lib/bim/model-service', () => bim)
vi.mock('./sketch-link-repository', () => rows)

const { resolveSketchLinks, MAX_RESOLVED_SKETCH_LINKS, SKETCH_LINK_DOCUMENTS_AT_ONCE } = await import('./sketch-link-resolve')

const session = { organizationId: 'org_1', userId: 'user_1' } as AuthorizedSession
const GLOBAL_ID = '2O2Fr$t4X7Zf8NOew3FLOH'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PLAN = uuid(1)
const IFC = uuid(2)
const SHELF = uuid(3)
const CHAT = uuid(4)
const RESTRICTED = uuid(5)
const NOWHERE = uuid(6)
const VER_1 = uuid(11)
const VER_2 = uuid(12)
const VER_DRAFT = uuid(13)
const VER_HELD = uuid(14)
const ANN_1 = uuid(21)

const doc = (id: string, extra: Partial<Document> = {}) =>
  ({ id, scope: 'project', projectId: 'proj_1', filename: `${id}.pdf`, displayName: null, publishedVersionId: VER_2, ...extra }) as Document

const DOCUMENTS: Record<string, Document> = {
  [PLAN]: doc(PLAN, { displayName: 'Polierplan EG' }),
  [IFC]: doc(IFC, { filename: 'Haus.ifc' }),
  [SHELF]: doc(SHELF, { scope: 'office_shelf', projectId: null }),
  [CHAT]: doc(CHAT, { scope: 'session', projectId: null }),
}
const VERSIONS = [
  { id: VER_1, versionNumber: 1, state: 'superseded', contentHash: 'a', screenedHash: 'a' },
  { id: VER_2, versionNumber: 2, state: 'published', contentHash: 'b', screenedHash: 'b' },
  { id: VER_DRAFT, versionNumber: 3, state: 'in_review', contentHash: 'c', screenedHash: 'c' },
  { id: VER_HELD, versionNumber: 4, state: 'published', contentHash: 'd', screenedHash: null },
]

const link = (elementId: string, kind: SketchOutlineLink['kind'], ref: SketchOutlineLink['ref']): SketchOutlineLink => ({ elementId, kind, ref })

beforeEach(() => {
  vi.clearAllMocks()
  access.getAccessibleDocument.mockImplementation(async (_session: unknown, id: string) => {
    // A document in a folder this reader may not see does not exist for them (ADR-0087).
    if (id === RESTRICTED) throw new NotFoundError()
    const found = DOCUMENTS[id]
    if (!found) throw new NotFoundError()
    return found
  })
  rows.listPinnedVersions.mockImplementation(async (_org: string, _doc: string, ids: string[]) => VERSIONS.filter((v) => ids.includes(v.id)))
  // The reader may receive only bytes a verdict passed: the held upload is not theirs.
  content.versionBytesReadableBy.mockResolvedValue((version: { screenedHash: string | null }) => version.screenedHash !== null)
  bim.findElementsOfReadDocument.mockImplementation(async (_s: unknown, _d: unknown, ids: string[]) => ({
    model: { id: 'model_1', filename: 'Haus.ifc', status: 'ready' },
    elements: ids.includes(GLOBAL_ID) ? [{ globalId: GLOBAL_ID, name: 'Wohnen', ifcType: 'IfcSpace' }] : [],
  }))
  rows.listAnnotationHeads.mockImplementation(async (_org: string, _doc: string, ids: string[]) =>
    ids.includes(ANN_1) ? [{ id: ANN_1, body: 'Anschluss  prüfen', status: 'open', kind: 'defect' }] : []
  )
})

describe('resolveSketchLinks', () => {
  it('reads a document page, a pinned Fassung, a model element and an Anmerkung for a reader who may open them', async () => {
    const resolved = await resolveSketchLinks(session, [
      link('a', 'document', { documentId: PLAN, page: 12 }),
      link('b', 'document', { documentId: PLAN, versionId: VER_1 }),
      link('c', 'ifcElement', { documentId: IFC, ifcGlobalId: GLOBAL_ID }),
      link('d', 'annotation', { documentId: PLAN, annotationId: ANN_1 }),
      link('e', 'document', { documentId: SHELF }),
      link('f', 'document', { documentId: PLAN, versionId: VER_2 }),
    ])
    expect(resolved).toMatchObject([
      { elementId: 'a', state: 'available', title: 'Polierplan EG', page: 12, place: { shelf: 'project', projectId: 'proj_1', documentId: PLAN } },
      { elementId: 'b', state: 'available', title: 'Polierplan EG', versionNumber: 1, current: false },
      { elementId: 'c', state: 'available', title: 'Wohnen (IfcSpace)', modelFile: 'Haus.ifc' },
      { elementId: 'd', state: 'available', title: 'Anschluss prüfen', status: 'open', annotationKind: 'defect' },
      { elementId: 'e', state: 'available', place: { shelf: 'office_shelf', projectId: null } },
      { elementId: 'f', state: 'available', versionNumber: 2, current: true },
    ])
  })

  it('says only `unavailable` for a restricted, missing or shelfless document, and for a target that is gone', async () => {
    const resolved = await resolveSketchLinks(session, [
      link('a', 'document', { documentId: RESTRICTED, page: 3 }),
      link('b', 'document', { documentId: NOWHERE }),
      link('c', 'document', { documentId: CHAT }),
      link('d', 'document', { documentId: PLAN, versionId: uuid(99) }),
      link('e', 'ifcElement', { documentId: IFC, ifcGlobalId: '3O2Fr$t4X7Zf8NOew3FLOH' }),
      link('f', 'annotation', { documentId: PLAN, annotationId: uuid(98) }),
    ])
    for (const entry of resolved) expect(Object.keys(entry).sort()).toEqual(['elementId', 'kind', 'ref', 'state'])
    expect(resolved.every((entry) => entry.state === 'unavailable')).toBe(true)
  })

  it('shows no number of a Fassung still in Freigabe or held from this reader', async () => {
    const resolved = await resolveSketchLinks(session, [
      link('draft', 'document', { documentId: PLAN, versionId: VER_DRAFT }),
      link('held', 'document', { documentId: PLAN, versionId: VER_HELD }),
    ])
    expect(resolved).toEqual([
      { ...link('draft', 'document', { documentId: PLAN, versionId: VER_DRAFT }), state: 'unavailable' },
      { ...link('held', 'document', { documentId: PLAN, versionId: VER_HELD }), state: 'unavailable' },
    ])
  })

  it('reads a model element as unavailable when models are off for the office', async () => {
    bim.findElementsOfReadDocument.mockRejectedValue(new ForbiddenError('IFC models are not enabled'))
    const [resolved] = await resolveSketchLinks(session, [link('c', 'ifcElement', { documentId: IFC, ifcGlobalId: GLOBAL_ID })])
    expect(resolved.state).toBe('unavailable')
  })

  it('reads a link the database refuses as unavailable, logs it, and still resolves the others', async () => {
    // A non-uuid id bound to a uuid column: Postgres throws 22P02, which is no ApiError.
    access.getAccessibleDocument.mockImplementation(async (_session: unknown, id: string) => {
      if (id === 'Polierplan') throw Object.assign(new Error('invalid input syntax for type uuid: "Polierplan"'), { code: '22P02' })
      return DOCUMENTS[id]
    })
    rows.listAnnotationHeads.mockRejectedValue(new Error('connection terminated'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const resolved = await resolveSketchLinks(session, [
      link('bad', 'document', { documentId: 'Polierplan' }),
      link('ann', 'annotation', { documentId: PLAN, annotationId: ANN_1 }),
      link('page', 'document', { documentId: PLAN, page: 2 }),
    ])
    expect(resolved.map((entry) => entry.state)).toEqual(['unavailable', 'unavailable', 'available'])
    expect(logged).toHaveBeenCalledTimes(2)
    logged.mockRestore()
  })

  it('asks each document once and each kind of target in one query, for 60 links', async () => {
    const many = Array.from({ length: MAX_RESOLVED_SKETCH_LINKS }, (_, index) =>
      index % 3 === 0
        ? link(`e${index}`, 'document', { documentId: PLAN, versionId: index % 2 ? VER_1 : VER_2 })
        : index % 3 === 1
          ? link(`e${index}`, 'annotation', { documentId: PLAN, annotationId: ANN_1 })
          : link(`e${index}`, 'ifcElement', { documentId: IFC, ifcGlobalId: GLOBAL_ID })
    )
    const resolved = await resolveSketchLinks(session, many)
    expect(resolved.every((entry) => entry.state === 'available')).toBe(true)
    expect(access.getAccessibleDocument).toHaveBeenCalledTimes(2)
    expect(rows.listPinnedVersions).toHaveBeenCalledTimes(1)
    expect(rows.listPinnedVersions.mock.calls[0][2]).toEqual([VER_2, VER_1])
    expect(rows.listAnnotationHeads).toHaveBeenCalledTimes(1)
    expect(bim.findElementsOfReadDocument).toHaveBeenCalledTimes(1)
  })

  it("asks at most four documents at once", async () => {
    let inFlight = 0
    let peak = 0
    access.getAccessibleDocument.mockImplementation(async (_session: unknown, id: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return doc(id)
    })
    const spread = Array.from({ length: 20 }, (_, index) => link(`e${index}`, 'document', { documentId: uuid(100 + index) }))
    const resolved = await resolveSketchLinks(session, spread)
    expect(resolved.map((entry) => entry.elementId)).toEqual(spread.map((entry) => entry.elementId))
    expect(access.getAccessibleDocument).toHaveBeenCalledTimes(20)
    expect(peak).toBe(SKETCH_LINK_DOCUMENTS_AT_ONCE)
  })

  it('resolves no more than its cap', async () => {
    const many = Array.from({ length: MAX_RESOLVED_SKETCH_LINKS + 2 }, (_, index) => link(`e${index}`, 'document', { documentId: uuid(200 + index) }))
    access.getAccessibleDocument.mockImplementation(async (_session: unknown, id: string) => doc(id))
    const resolved = await resolveSketchLinks(session, many)
    expect(resolved).toHaveLength(many.length)
    expect(access.getAccessibleDocument).toHaveBeenCalledTimes(MAX_RESOLVED_SKETCH_LINKS)
    expect(resolved.at(-1)?.state).toBe('unavailable')
  })
})
