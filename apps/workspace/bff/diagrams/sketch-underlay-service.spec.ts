/**
 * @vitest-environment node
 */
/**
 * What a move asks before a document moves (S6 review, findings 2 to 4): a
 * Skizze is checked against every base any Fassung of it was traced over, the
 * PDF beside it against its Skizze's bases (it carries the same page), and a
 * PDF that is a base against the Skizzen traced over it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema/documents'

vi.mock('server-only', () => ({}))

const access = vi.hoisted(() => ({
  underlayMoveRefusal: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  baseMoveRefusal: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}))
const register = vi.hoisted(() => ({
  recordUnderlayBase: vi.fn(),
  underlayBasesOf: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
  sketchesTracing: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
}))
const repository = vi.hoisted(() => ({ findDocumentAuthoredByRef: vi.fn(async (..._args: unknown[]): Promise<unknown> => null) }))
const sketchDocument = vi.hoisted(() => ({ publishedSketchOf: vi.fn(async () => null), saveSketchDocument: vi.fn(), sketchSaveBaseOf: vi.fn() }))
vi.mock('./sketch-underlay-access', () => access)
vi.mock('./sketch-underlay-register', () => register)
vi.mock('@/lib/documents/repository', () => repository)
vi.mock('./sketch-document', () => sketchDocument)
vi.mock('./filing', () => ({ fileDiagramDocuments: vi.fn() }))
vi.mock('./sketch-picture', () => ({ drawSketchScene: vi.fn() }))
vi.mock('@/lib/documents/move-to-folder', () => ({ moveDocumentToFolder: vi.fn() }))
vi.mock('@/lib/documents/page-raster', () => ({ readPageLabels: vi.fn(), readPageRaster: vi.fn() }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/documents/version-repository', () => ({ findDocumentVersion: vi.fn() }))
vi.mock('@/lib/conversations/restricted-egress', () => ({ folderRestrictsReading: vi.fn() }))

const { tracedMoveRefusal } = await import('./sketch-underlay-service')

const session = { organizationId: 'org_1', userId: 'user_1' } as AuthorizedSession
const doc = (fields: Partial<Document>) => ({ id: 'd', projectId: 'proj_1', folderId: null, contentType: 'application/pdf', authoredByProducer: null, authoredByRef: null, ...fields }) as Document
const bases = [{ id: 'base', projectId: 'proj_1', folderId: 'payroll', name: 'Lohn.pdf' }]

beforeEach(() => vi.clearAllMocks())

describe('tracedMoveRefusal', () => {
  it('asks a Skizze about every base its Fassungen were traced over', async () => {
    register.underlayBasesOf.mockResolvedValueOnce(bases)
    await tracedMoveRefusal(session, doc({ id: 'sk', contentType: 'image/svg+xml', authoredByProducer: 'diagram_svg', authoredByRef: 'r' }), 'open')
    expect(register.underlayBasesOf).toHaveBeenCalledWith('org_1', 'sk')
    expect(access.underlayMoveRefusal).toHaveBeenCalledWith(session, null, expect.objectContaining({ id: 'sk' }), 'open', bases)
  })

  it('asks the PDF beside a Skizze about its Skizze’s bases, so it cannot move wide on its own', async () => {
    repository.findDocumentAuthoredByRef.mockResolvedValueOnce({ id: 'sk', filename: 'S.svg', folderId: 'payroll' })
    register.underlayBasesOf.mockResolvedValueOnce(bases)
    access.underlayMoveRefusal.mockResolvedValueOnce({ error: 'wider', reason: 'underlay_wider' })
    const refusal = await tracedMoveRefusal(session, doc({ id: 'pdf', authoredByProducer: 'diagram_pdf', authoredByRef: 'r' }), 'open')
    expect(repository.findDocumentAuthoredByRef).toHaveBeenCalledWith('r', 'org_1', 'proj_1', 'diagram_svg')
    expect(register.underlayBasesOf).toHaveBeenCalledWith('org_1', 'sk')
    expect(refusal).toEqual({ error: 'wider', reason: 'underlay_wider' })
  })

  it('asks a PDF upload about the Skizzen traced over it, and nothing of another file', async () => {
    const sketches = [{ id: 'sk', projectId: 'proj_1', folderId: 'sketches', name: 'S' }]
    register.sketchesTracing.mockResolvedValueOnce(sketches)
    await tracedMoveRefusal(session, doc({ id: 'base' }), 'payroll')
    expect(access.baseMoveRefusal).toHaveBeenCalledWith(session, expect.objectContaining({ id: 'base' }), 'payroll', sketches)
    await tracedMoveRefusal(session, doc({ id: 'photo', contentType: 'image/jpeg' }), 'payroll')
    expect(register.sketchesTracing).toHaveBeenCalledTimes(1)
  })
})
