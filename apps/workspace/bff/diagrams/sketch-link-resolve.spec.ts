/**
 * @vitest-environment node
 */
/**
 * A Skizze's links read with the reader's rights: what they may open has a
 * title and a place; what is gone or theirs not to open is `unavailable` with
 * nothing more, whichever of the two it is.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema/documents'
import type { SketchOutlineLink } from './sketch-links'

vi.mock('server-only', () => ({}))

const access = vi.hoisted(() => ({ getAccessibleDocument: vi.fn() }))
const versions = vi.hoisted(() => ({ findDocumentVersion: vi.fn() }))
const bim = vi.hoisted(() => ({ getModelForDocument: vi.fn(), queryAccessibleModel: vi.fn() }))
const annotations = vi.hoisted(() => ({ findDocumentAnnotation: vi.fn() }))
vi.mock('@/lib/documents/access', () => access)
vi.mock('@/lib/documents/version-repository', () => versions)
vi.mock('@/lib/bim/model-service', () => bim)
vi.mock('@/lib/annotations/repository', () => annotations)

const { resolveSketchLinks, MAX_RESOLVED_SKETCH_LINKS } = await import('./sketch-link-resolve')

const session = { organizationId: 'org_1', userId: 'user_1' } as AuthorizedSession
const GLOBAL_ID = '2O2Fr$t4X7Zf8NOew3FLOH'

const doc = (id: string, extra: Partial<Document> = {}) =>
  ({ id, scope: 'project', projectId: 'proj_1', filename: `${id}.pdf`, displayName: null, publishedVersionId: 'ver_2', ...extra }) as Document

const DOCUMENTS: Record<string, Document> = {
  doc_plan: doc('doc_plan', { displayName: 'Polierplan EG' }),
  doc_ifc: doc('doc_ifc', { filename: 'Haus.ifc' }),
  doc_shelf: doc('doc_shelf', { scope: 'office_shelf', projectId: null }),
  doc_chat: doc('doc_chat', { scope: 'session', projectId: null }),
}

const link = (elementId: string, kind: SketchOutlineLink['kind'], ref: SketchOutlineLink['ref']): SketchOutlineLink => ({ elementId, kind, ref })

beforeEach(() => {
  vi.clearAllMocks()
  access.getAccessibleDocument.mockImplementation(async (_session: unknown, id: string) => {
    // A document in a folder this reader may not see does not exist for them (ADR-0087).
    if (id === 'doc_restricted') throw new NotFoundError()
    const found = DOCUMENTS[id]
    if (!found) throw new NotFoundError()
    return found
  })
  versions.findDocumentVersion.mockImplementation(async (id: string) => (id === 'ver_1' ? { id: 'ver_1', versionNumber: 1 } : null))
  bim.getModelForDocument.mockResolvedValue({ id: 'model_1', filename: 'Haus.ifc', status: 'ready' })
  bim.queryAccessibleModel.mockImplementation(async (_s: unknown, _m: string, query: { globalId: string }) => ({
    element: query.globalId === GLOBAL_ID ? { name: 'Wohnen', ifcType: 'IfcSpace' } : null,
  }))
  annotations.findDocumentAnnotation.mockImplementation(async (_org: string, _doc: string, id: string) =>
    id === 'ann_1' ? { id, body: 'Anschluss  prüfen', status: 'open', kind: 'defect' } : null
  )
})

describe('resolveSketchLinks', () => {
  it('reads a document page, a pinned Fassung, a model element and an Anmerkung for a reader who may open them', async () => {
    const resolved = await resolveSketchLinks(session, [
      link('a', 'document', { documentId: 'doc_plan', page: 12 }),
      link('b', 'document', { documentId: 'doc_plan', versionId: 'ver_1' }),
      link('c', 'ifcElement', { documentId: 'doc_ifc', ifcGlobalId: GLOBAL_ID }),
      link('d', 'annotation', { documentId: 'doc_plan', annotationId: 'ann_1' }),
      link('e', 'document', { documentId: 'doc_shelf' }),
    ])
    expect(resolved).toMatchObject([
      { elementId: 'a', state: 'available', title: 'Polierplan EG', page: 12, place: { shelf: 'project', projectId: 'proj_1', documentId: 'doc_plan' } },
      { elementId: 'b', state: 'available', versionNumber: 1, current: false },
      { elementId: 'c', state: 'available', title: 'Wohnen (IfcSpace)', modelFile: 'Haus.ifc' },
      { elementId: 'd', state: 'available', title: 'Anschluss prüfen', status: 'open', annotationKind: 'defect' },
      { elementId: 'e', state: 'available', place: { shelf: 'office_shelf', projectId: null } },
    ])
  })

  it('says only `unavailable` for a restricted, missing or shelfless document, and for a target that is gone', async () => {
    const resolved = await resolveSketchLinks(session, [
      link('a', 'document', { documentId: 'doc_restricted', page: 3 }),
      link('b', 'document', { documentId: 'doc_nowhere' }),
      link('c', 'document', { documentId: 'doc_chat' }),
      link('d', 'document', { documentId: 'doc_plan', versionId: 'ver_gone' }),
      link('e', 'ifcElement', { documentId: 'doc_ifc', ifcGlobalId: '3O2Fr$t4X7Zf8NOew3FLOH' }),
      link('f', 'annotation', { documentId: 'doc_plan', annotationId: 'ann_gone' }),
    ])
    for (const entry of resolved) expect(Object.keys(entry).sort()).toEqual(['elementId', 'kind', 'ref', 'state'])
    expect(resolved.every((entry) => entry.state === 'unavailable')).toBe(true)
  })

  it('reads a model element as unavailable when models are off for the office', async () => {
    bim.getModelForDocument.mockRejectedValue(new ForbiddenError('IFC models are not enabled'))
    const [resolved] = await resolveSketchLinks(session, [link('c', 'ifcElement', { documentId: 'doc_ifc', ifcGlobalId: GLOBAL_ID })])
    expect(resolved.state).toBe('unavailable')
  })

  it('resolves no more than its cap', async () => {
    const many = Array.from({ length: MAX_RESOLVED_SKETCH_LINKS + 2 }, (_, index) => link(`e${index}`, 'document', { documentId: 'doc_plan' }))
    const resolved = await resolveSketchLinks(session, many)
    expect(resolved).toHaveLength(many.length)
    expect(access.getAccessibleDocument).toHaveBeenCalledTimes(MAX_RESOLVED_SKETCH_LINKS)
    expect(resolved.at(-1)?.state).toBe('unavailable')
  })
})
