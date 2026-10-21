/**
 * @vitest-environment node
 *
 * Re-filing one document into another folder.
 *
 * Two things are pinned here, and neither is the update itself.
 *
 * The first is the TENANT boundary on the destination: a folder id is a bare
 * pointer, and without checking that the folder belongs to the same project the
 * move would file a document under another project's tree — where it would
 * disappear from every listing that filters by folder.
 *
 * The second is the BACKEND MIRROR (ADR-0049). The Python side files documents
 * under the materialised path, so a move that only wrote `documents.folder_id`
 * leaves the agent's inventory and `knowledge_search folder=` naming the folder
 * the file just left. The subtree mirror cannot cover this — it rewrites a path
 * PREFIX, and a document leaving `Brandschutz` for `Statik` shares no prefix
 * with where it was.
 *
 * The backend twin — same URL, same `folder_path` body — is
 * `frontends/aiq_api/tests/test_document_folder_path_patch.py`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/projects/collection-placement', () => ({
  PURGE_TIMEOUT_MS: 15_000,
  placeProjectDocuments: vi.fn(async () => ({ moved: 0, failed: [], pending: 0 })),
}))
vi.mock('@/lib/documents/collection-file-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/collection-file-ref')>()),
  purgeIngestedChunks: vi.fn(async () => true),
}))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(async () => ({ id: 'proj-1', collectionName: 'proj_1' })),
}))
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/authz/organizations', () => ({ canManageOfficeShelf: vi.fn().mockReturnValue(true) }))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

const db = vi.hoisted(() => ({
  /** Rows the next `select(...).limit()` resolves to, in call order. */
  selects: [] as Array<Array<Record<string, unknown>>>,
  updates: [] as Array<Record<string, unknown>>,
  /** The next update throws this, once. */
  updateFails: null as Error | null,
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => db.selects.shift() ?? [] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        db.updates.push(values)
        const failure = db.updateFails
        db.updateFails = null
        return {
          where: () => ({
            returning: async () => {
              if (failure) throw failure
              return [{ id: 'doc-1', folderId: values.folderId }]
            },
          }),
        }
      },
    }),
  }),
}))

// The document is loaded through the hold (`findDocumentForSession`, ADR-0086):
// here it answers the first queued row, as the query would for a visible one.
// `visibility.integration.spec.ts` holds the rule itself against Postgres.
vi.mock('./service', () => ({ reingestDocument: vi.fn() }))

vi.mock('./access', () => ({
  findDocumentForSession: vi.fn(async () => db.selects.shift()?.[0] ?? null),
}))

vi.mock('@/lib/db/schema', () => ({
  documents: {
    id: 'documents.id',
    organizationId: 'documents.organization_id',
    projectId: 'documents.project_id',
    folderId: 'documents.folder_id',
    filename: 'documents.filename',
    collectionName: 'documents.collection_name',
    authoredBy: 'documents.authored_by',
    updatedAt: 'documents.updated_at',
  },
  projectFolders: { id: 'folders.id', projectId: 'folders.project_id', path: 'folders.path' },
}))

import { getProjectFolderAccess, requireFolderWrite, type ProjectFolderAccess } from '@/lib/authz/folder-access'
import { folderReadOnlyError } from '@/lib/authz/folder-access-rule'
import { placeProjectDocuments } from '@/lib/projects/collection-placement'
import { purgeIngestedChunks } from '@/lib/documents/collection-file-ref'
import { canManageOfficeShelf } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import { ForbiddenError } from '@/lib/api/errors'
import { reingestDocument } from './service'
import { MOVED_SINCE_MESSAGE, moveDocumentToFolder, moveDocumentsToFolders } from './move-to-folder'

const SESSION = { organizationId: 'org-1', userId: 'user-1' } as never

const DOCUMENT = {
  id: 'doc-1',
  projectId: 'proj-1',
  folderId: null,
  filename: 'Fluchtwegplan.pdf',
  collectionName: 'proj_1',
  authoredBy: 'user' as const,
  status: 'completed',
}

let fetchSpy: ReturnType<typeof vi.fn>

const mirrorBody = (): Record<string, unknown> =>
  JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>

beforeEach(() => {
  db.selects = []
  db.updates = []
  fetchSpy = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('moveDocumentToFolder', () => {
  it('files the document and tells the backend the new PATH, not the id', async () => {
    db.selects = [[DOCUMENT], [{ id: 'folder-1', path: 'Brandschutz/Fluchtwege' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok).toBe(true)
    expect(db.updates[0].folderId).toBe('folder-1')
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://backend:8000/v1/collections/proj_1/documents/Fluchtwegplan.pdf/folder-path',
    )
    expect(mirrorBody()).toEqual({ folder_path: 'Brandschutz/Fluchtwege' })
  })

  it('leaves a document where it is when it is no longer in the folder the caller expected', async () => {
    db.selects = [[{ ...DOCUMENT, folderId: 'folder-colleague' }]]

    const result = await moveDocumentToFolder(
      { documentId: 'doc-1', folderId: null, expectedFolderId: 'folder-1' },
      SESSION,
    )

    expect(result).toEqual({ ok: false, error: MOVED_SINCE_MESSAGE })
    expect(db.updates).toHaveLength(0)
  })

  it('says nothing changed for a document already in its destination', async () => {
    db.selects = [[{ ...DOCUMENT, folderId: 'folder-1' }], [{ id: 'folder-1', path: 'A' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    expect(result).toMatchObject({ ok: true, changed: false })
    expect(db.updates).toHaveLength(0)
  })

  it('starts no move of a batch after its deadline', async () => {
    const outcomes = await moveDocumentsToFolders(
      [
        { documentId: 'doc-1', folderId: 'folder-1' },
        { documentId: 'doc-2', folderId: 'folder-1' },
      ],
      SESSION,
      { deadline: Date.now() - 1 },
    )

    expect(outcomes).toEqual([])
    expect(db.updates).toHaveLength(0)
  })

  it('answers a batch run several at a time in the order it was asked, and counts its progress up', async () => {
    // No document is found, so every move is refused: what is checked is the batch's shape.
    const ids = ['doc-a', 'doc-b', 'doc-c', 'doc-d', 'doc-e']
    const counts: number[] = []
    const outcomes = await moveDocumentsToFolders(
      ids.map((documentId) => ({ documentId, folderId: 'folder-1' })),
      SESSION,
      { concurrency: 3, onProgress: (done) => void counts.push(done) },
    )

    expect(outcomes.map((outcome) => outcome.documentId)).toEqual(ids)
    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true)
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    expect(Math.max(...counts)).toBeLessThan(ids.length)
  })

  it('clears the backend path when the document goes back to the project root', async () => {
    db.selects = [[{ ...DOCUMENT, folderId: 'folder-1' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: null }, SESSION)

    expect(result.ok).toBe(true)
    expect(db.updates[0].folderId).toBeNull()
    expect(mirrorBody()).toEqual({ folder_path: null })
  })

  it('refuses a folder that belongs to another project', async () => {
    // The document is found; the folder lookup, scoped to the document's own
    // project, is not.
    db.selects = [[DOCUMENT], []]

    const result = await moveDocumentToFolder(
      { documentId: 'doc-1', folderId: 'folder-from-elsewhere' },
      SESSION,
    )

    expect(result).toEqual({ ok: false, error: 'Folder not found in this project.' })
    expect(db.updates).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a document that is on no shelf with folders (a session attachment)', async () => {
    db.selects = [[{ ...DOCUMENT, projectId: null }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: null }, SESSION)

    expect(result).toEqual({ ok: false, error: 'Only project and Archiv documents live in folders.' })
    expect(db.updates).toHaveLength(0)
  })

  it('does nothing at all when the document is already there', async () => {
    db.selects = [[{ ...DOCUMENT, folderId: 'folder-1' }], [{ id: 'folder-1', path: 'Brandschutz' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok).toBe(true)
    expect(db.updates).toHaveLength(0)
    // No write, so nothing for the backend to catch up on either.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('moves a machine-authored row without addressing the backend by filename', async () => {
    db.selects = [
      [{ ...DOCUMENT, authoredBy: 'agent', filename: 'brandschutz-gutachten-2026-08-20.pdf' }],
      [{ id: 'folder-1', path: 'Berichte' }],
    ]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok).toBe(true)
    expect(db.updates[0].folderId).toBe('folder-1')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still moves the document when the backend mirror is unreachable', async () => {
    db.selects = [[DOCUMENT], [{ id: 'folder-1', path: 'Statik' }]]
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    // The row is the durable record; a backend outage must not fail a move the
    // user is entitled to make.
    expect(result.ok).toBe(true)
    expect(db.updates[0].folderId).toBe('folder-1')
  })
})

describe('moveDocumentToFolder across a restriction (ADR-0087)', () => {
  const access = (overrides: Partial<ProjectFolderAccess>): ProjectFolderAccess => ({
    hiddenFolderIds: new Set(),
    isVisible: () => true,
    collectionFor: () => 'proj_1',
    clearedRestrictedCollections: [],
    levelOf: () => 'write',
    sourceFolderOf: () => null,
    anyRestricted: true,
    ...overrides,
  })

  it('does not move a document out of a folder the mover may not see', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(access({ isVisible: (id) => id !== 'f-hidden' }))
    db.selects = [[{ ...DOCUMENT, folderId: 'f-hidden' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: null }, SESSION)

    expect(result).toEqual({ ok: false, error: 'Document not found.' })
    expect(db.updates).toHaveLength(0)
  })

  it('does not move a document into a folder the mover may not see', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(access({ isVisible: (id) => id !== 'f-hidden' }))
    // The folder exists in the project; only its restriction refuses the move.
    db.selects = [[DOCUMENT], [{ id: 'f-hidden', path: 'Verwaltung/Honorare' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'f-hidden' }, SESSION)

    expect(result).toEqual({ ok: false, error: 'Folder not found in this project.' })
    expect(db.updates).toHaveLength(0)
  })

  it('places the document into the restricted collection instead of mirroring the path', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(
      access({ collectionFor: (id) => (id === 'f-locked' ? 'proj_1_r0123456789ab' : 'proj_1') })
    )
    db.selects = [[DOCUMENT], [{ id: 'f-locked', path: 'Verträge' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'f-locked' }, SESSION)

    expect(result.ok).toBe(true)
    expect(placeProjectDocuments).toHaveBeenCalledWith('org-1', 'proj-1')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // Restricted folders do not hold IFC models (ADR-0087): the model's building
  // data is keyed by project, so the move would hide the file and leave the
  // building open.
  it('refuses to move an IFC model into a restricted folder, with a 409', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(
      access({ collectionFor: (id) => (id === 'f-locked' ? 'proj_1_r0123456789ab' : 'proj_1') })
    )
    db.selects = [[{ ...DOCUMENT, filename: 'Haus-A_V3.ifc' }], [{ id: 'f-locked', path: 'Verträge' }]]

    const error = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'f-locked' }, SESSION).catch(
      (caught: unknown) => caught,
    )

    expect(error).toMatchObject({
      status: 409,
      message: expect.stringContaining('IFC models cannot be filed in a restricted folder yet'),
      details: { code: 'IFC_IN_RESTRICTED_FOLDER' },
    })
    expect(db.updates).toHaveLength(0)
    expect(placeProjectDocuments).not.toHaveBeenCalled()
  })

  it('moves an IFC model between open folders as before', async () => {
    db.selects = [[{ ...DOCUMENT, filename: 'Haus-A_V3.ifc' }], [{ id: 'folder-1', path: 'Modelle' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok).toBe(true)
    expect(db.updates[0].folderId).toBe('folder-1')
  })
  it('asks for a write on BOTH folders, and moves nothing out of or into one the session may only read (ADR-0088)', async () => {
    db.selects = [[{ ...DOCUMENT, folderId: 'folder-vertraege' }], [{ id: 'folder-1', path: 'Brandschutz' }]]
    vi.mocked(requireFolderWrite).mockRejectedValueOnce(folderReadOnlyError())

    await expect(moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)).rejects.toMatchObject({
      status: 403,
      details: { reason: 'folder-read-only' },
    })
    expect(requireFolderWrite).toHaveBeenCalledWith(SESSION, 'proj-1', ['folder-vertraege', 'folder-1'])
    expect(db.updates).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

/**
 * A move across a restriction purges the document's chunks from the collection
 * they are in BEFORE the row is written (a failed purge writes nothing), and a
 * batch runs placement once per project, not once per crossing move.
 */
describe('moveDocumentToFolder across a restriction: purge first, placement checked', () => {
  const LOCKED = 'proj_1_r0123456789ab'
  const lockedAccess = (): ProjectFolderAccess => ({
    hiddenFolderIds: new Set(),
    isVisible: () => true,
    collectionFor: (id) => (id === 'f-locked' ? LOCKED : 'proj_1'),
    clearedRestrictedCollections: [],
    levelOf: () => 'write',
    sourceFolderOf: () => null,
    anyRestricted: true,
  })
  const LOCKED_FOLDER = { id: 'f-locked', path: 'Verträge' }

  beforeEach(() => {
    vi.mocked(purgeIngestedChunks).mockReset()
    vi.mocked(purgeIngestedChunks).mockResolvedValue(true)
    vi.mocked(placeProjectDocuments).mockReset()
    vi.mocked(placeProjectDocuments).mockResolvedValue({ moved: 0, failed: [], pending: 0 })
  })

  it('purges the old collection before it writes the row, and places after the write', async () => {
    const order: string[] = []
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(lockedAccess())
    vi.mocked(purgeIngestedChunks).mockImplementationOnce(async (_backend, ref) => {
      order.push(`purge ${ref.collectionName} after ${db.updates.length} writes`)
      return true
    })
    vi.mocked(placeProjectDocuments).mockImplementationOnce(async () => {
      order.push(`place after ${db.updates.length} writes`)
      return { moved: 1, failed: [], pending: 0 }
    })
    db.selects = [[DOCUMENT], [LOCKED_FOLDER], [{ ...DOCUMENT, collectionName: LOCKED }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'f-locked' }, SESSION)

    expect(order).toEqual(['purge proj_1 after 0 writes', 'place after 1 writes'])
    expect(vi.mocked(purgeIngestedChunks).mock.calls[0][1]).toEqual({
      collectionName: 'proj_1',
      filename: 'Fluchtwegplan.pdf',
    })
    expect(vi.mocked(purgeIngestedChunks).mock.calls[0][3]).toEqual({ permanent: true })
    expect(result).toEqual({
      ok: true,
      document: { id: 'doc-1', folderId: 'f-locked' },
      pending: false,
      placementDue: null,
      changed: true,
    })
  })

  it('refuses the move, and writes nothing, when the purge from the open collection fails', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(lockedAccess())
    vi.mocked(purgeIngestedChunks).mockResolvedValueOnce(false)
    db.selects = [[DOCUMENT], [LOCKED_FOLDER]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'f-locked' }, SESSION)

    expect(result).toEqual({ ok: false, error: expect.stringContaining('was not moved') })
    expect(db.updates).toHaveLength(0)
    expect(placeProjectDocuments).not.toHaveBeenCalled()
  })

  it('reads the document again when the row did not move after its chunks were purged', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(lockedAccess())
    db.selects = [[DOCUMENT], [LOCKED_FOLDER]]
    db.updateFails = new Error('connection reset')

    await expect(moveDocumentToFolder({ documentId: 'doc-1', folderId: 'f-locked' }, SESSION)).rejects.toThrow(
      'connection reset'
    )
    expect(purgeIngestedChunks).toHaveBeenCalled()
    expect(reingestDocument).toHaveBeenCalledWith(SESSION, 'doc-1')
    expect(placeProjectDocuments).not.toHaveBeenCalled()
  })

  it('reports the move as pending, not as placed, when placement does not place the document', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(lockedAccess())
    vi.mocked(placeProjectDocuments).mockResolvedValueOnce({ moved: 0, failed: ['doc-1'], pending: 0 })
    // The row is in the folder it was moved to, and still in the open collection.
    db.selects = [[DOCUMENT], [LOCKED_FOLDER], [DOCUMENT]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'f-locked' }, SESSION)

    expect(result).toMatchObject({ ok: true, pending: true })
    expect(db.updates[0].folderId).toBe('f-locked')
  })

  it('runs placement once for a batch of crossing moves, after every move has purged and written', async () => {
    const writesAtPlacement: number[] = []
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(lockedAccess()).mockResolvedValueOnce(lockedAccess())
    vi.mocked(placeProjectDocuments).mockImplementationOnce(async () => {
      writesAtPlacement.push(db.updates.length)
      return { moved: 2, failed: [], pending: 0 }
    })
    db.selects = [
      [DOCUMENT], [LOCKED_FOLDER],
      [{ ...DOCUMENT, id: 'doc-2', filename: 'Zweites.pdf' }], [LOCKED_FOLDER],
      [{ ...DOCUMENT, collectionName: LOCKED }],
      [{ ...DOCUMENT, id: 'doc-2', collectionName: LOCKED }],
    ]

    const outcomes = await moveDocumentsToFolders(
      [
        { documentId: 'doc-1', folderId: 'f-locked' },
        { documentId: 'doc-2', folderId: 'f-locked' },
      ],
      SESSION,
    )

    expect(outcomes).toEqual([
      { documentId: 'doc-1', ok: true, error: null, pending: false, changed: true },
      { documentId: 'doc-2', ok: true, error: null, pending: false, changed: true },
    ])
    expect(placeProjectDocuments).toHaveBeenCalledTimes(1)
    expect(placeProjectDocuments).toHaveBeenCalledWith('org-1', 'proj-1')
    expect(writesAtPlacement).toEqual([2])
    expect(purgeIngestedChunks).toHaveBeenCalledTimes(2)
  })

  it('reports a crossing document that the batch placement did not place as pending, and the others as placed', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(lockedAccess()).mockResolvedValueOnce(lockedAccess())
    db.selects = [
      [DOCUMENT], [LOCKED_FOLDER],
      [{ ...DOCUMENT, id: 'doc-2', filename: 'Zweites.pdf' }], [LOCKED_FOLDER],
      // After placement: doc-1 is in the locked collection, doc-2 is not.
      [{ ...DOCUMENT, collectionName: LOCKED }],
      [{ ...DOCUMENT, id: 'doc-2', filename: 'Zweites.pdf' }],
    ]

    const outcomes = await moveDocumentsToFolders(
      [
        { documentId: 'doc-1', folderId: 'f-locked' },
        { documentId: 'doc-2', folderId: 'f-locked' },
      ],
      SESSION,
    )

    expect(outcomes).toEqual([
      { documentId: 'doc-1', ok: true, error: null, pending: false, changed: true },
      { documentId: 'doc-2', ok: true, error: null, pending: true, changed: true },
    ])
  })

  it('a batch refuses only the crossing move whose purge failed, and still places the others', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(lockedAccess()).mockResolvedValueOnce(lockedAccess())
    vi.mocked(purgeIngestedChunks).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    db.selects = [
      [DOCUMENT], [LOCKED_FOLDER],
      [{ ...DOCUMENT, id: 'doc-2', filename: 'Zweites.pdf' }], [LOCKED_FOLDER],
      [{ ...DOCUMENT, id: 'doc-2', collectionName: LOCKED }],
    ]

    const outcomes = await moveDocumentsToFolders(
      [
        { documentId: 'doc-1', folderId: 'f-locked' },
        { documentId: 'doc-2', folderId: 'f-locked' },
      ],
      SESSION,
    )

    expect(outcomes[0]).toMatchObject({ documentId: 'doc-1', ok: false, pending: false })
    expect(outcomes[0].error).toContain('was not moved')
    expect(outcomes[1]).toEqual({ documentId: 'doc-2', ok: true, error: null, pending: false, changed: true })
    expect(db.updates.map((values) => values.folderId)).toEqual(['f-locked'])
    expect(placeProjectDocuments).toHaveBeenCalledTimes(1)
  })
})

/**
 * The Archiv's documents are filed like a project's (ADR-0078): the same path,
 * with the document's own row saying which shelf it is on. What differs is who
 * may move it and which folders are valid destinations.
 */
describe('moveDocumentToFolder on the Archiv shelf', () => {
  const OFFICE_SHELF_DOCUMENT = {
    ...DOCUMENT,
    projectId: null,
    scope: 'office_shelf',
    collectionName: 'archiv_org-1',
  }

  it('files an Archiv document and mirrors the path onto the Archiv collection', async () => {
    db.selects = [[OFFICE_SHELF_DOCUMENT], [{ id: 'folder-1', path: 'Normen/Brandschutz' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok).toBe(true)
    expect(db.updates[0].folderId).toBe('folder-1')
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://backend:8000/v1/collections/archiv_org-1/documents/Fluchtwegplan.pdf/folder-path',
    )
    expect(mirrorBody()).toEqual({ folder_path: 'Normen/Brandschutz' })
  })

  it('takes org:archiv:manage, not a project permission', async () => {
    vi.mocked(canManageOfficeShelf).mockReturnValueOnce(false)
    db.selects = [[OFFICE_SHELF_DOCUMENT]]

    await expect(moveDocumentToFolder({ documentId: 'doc-1', folderId: null }, SESSION)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    expect(db.updates).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a folder that is not on the Archiv shelf', async () => {
    // A project's folder, another tenant's, or none: the lookup is scoped to the
    // Archiv shelf and the tenant, so none of them is found.
    db.selects = [[OFFICE_SHELF_DOCUMENT], []]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'a-project-folder' }, SESSION)

    expect(result).toEqual({ ok: false, error: 'Folder not found in the office shelf.' })
    expect(db.updates).toHaveLength(0)
  })

  it('still refuses a session attachment, which is filed nowhere', async () => {
    db.selects = [[{ ...DOCUMENT, projectId: null, scope: 'session' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: null }, SESSION)

    expect(result).toEqual({ ok: false, error: 'Only project and Archiv documents live in folders.' })
    expect(canManageOfficeShelf).not.toHaveBeenCalled()
  })
})
