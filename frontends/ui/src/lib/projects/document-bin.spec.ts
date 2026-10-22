/**
 * @vitest-environment node
 */
/**
 * One document to the bin and back (ADR-0131 rule 7), through the folder bin:
 * a holder made in its folder, the document moved in, the holder binned with
 * exactly it; undone when a step fails, and restored back to its folder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/access', () => ({ findDocumentForSession: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ requireFolderWrite: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: (_scope: unknown, fn: () => unknown) => fn() }))
vi.mock('@/lib/documents/move-to-folder', () => ({ moveDocumentToFolder: vi.fn() }))
vi.mock('@/lib/documents/shelf-live', () => ({ publishShelfChanged: vi.fn() }))
vi.mock('./cleanup-repository', () => ({ deleteEmptyCreatedFolder: vi.fn().mockResolvedValue(true) }))
vi.mock('./folder-bin', () => ({ moveFolderToBin: vi.fn(), restoreFolderFromBin: vi.fn() }))
vi.mock('./folder-bin-repository', () => ({ findFolderInOrg: vi.fn(), findActiveBinEntry: vi.fn() }))
vi.mock('./folder-service', () => ({ createProjectFolder: vi.fn() }))

import { ConflictError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findDocumentForSession } from '@/lib/documents/access'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'
import { deleteEmptyCreatedFolder } from './cleanup-repository'
import { moveDocumentToBin, restoreDocumentFromBin } from './document-bin'
import { moveFolderToBin, restoreFolderFromBin } from './folder-bin'
import { findActiveBinEntry, findFolderInOrg } from './folder-bin-repository'
import { createProjectFolder } from './folder-service'

const session = { userId: 'u1', organizationId: 'org-1' } as AuthorizedSession
const doc = { id: 'd1', scope: 'project', projectId: 'p1', folderId: 'f-plans', filename: 'Plan.pdf', displayName: null }
const holder = { id: 'h1', parentId: 'f-plans', deletedAt: new Date(), purgedAt: null, binRootId: 'h1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findDocumentForSession).mockResolvedValue(doc as never)
  vi.mocked(createProjectFolder).mockResolvedValue({ ok: true, folder: { id: 'h1' } } as never)
  vi.mocked(moveDocumentToFolder).mockResolvedValue({ ok: true, document: { id: 'd1', folderId: 'h1' } })
  vi.mocked(deleteEmptyCreatedFolder).mockResolvedValue(true)
})

describe('moveDocumentToBin', () => {
  it('bins a holder named after the document, holding exactly it', async () => {
    vi.mocked(findFolderInOrg).mockResolvedValue({ id: 'f-plans', deletedAt: null } as never)
    vi.mocked(moveFolderToBin).mockResolvedValue({ documentsBinned: 1, foldersBinned: 1, purgeAfter: new Date('2026-11-05T00:00:00Z') })

    const result = await moveDocumentToBin(session, 'd1')

    expect(createProjectFolder).toHaveBeenCalledWith({ projectId: 'p1', parentId: 'f-plans', name: 'Plan.pdf' }, session)
    expect(moveFolderToBin).toHaveBeenCalledWith(session, { projectId: 'p1', folderId: 'h1' }, undefined, {
      onlyDocuments: ['d1'],
      documentId: 'd1',
    })
    expect(result).toEqual({ documentId: 'd1', binEntryId: 'h1', purgeAfter: '2026-11-05T00:00:00.000Z' })
  })

  it('puts the document back and removes the holder when binning fails', async () => {
    vi.mocked(findFolderInOrg).mockResolvedValue({ id: 'f-plans', deletedAt: null } as never)
    vi.mocked(moveFolderToBin).mockRejectedValue(new Error('index did not confirm'))

    await expect(moveDocumentToBin(session, 'd1')).rejects.toThrow('index did not confirm')

    expect(moveDocumentToFolder).toHaveBeenLastCalledWith({ documentId: 'd1', folderId: 'f-plans', expectedFolderId: 'h1' }, session)
    expect(deleteEmptyCreatedFolder).toHaveBeenCalledWith('org-1', 'p1', 'h1')
  })

  it('refuses an office shelf document, which has no bin', async () => {
    vi.mocked(findDocumentForSession).mockResolvedValue({ ...doc, scope: 'office_shelf', projectId: null } as never)
    await expect(moveDocumentToBin(session, 'd1')).rejects.toBeInstanceOf(ConflictError)
    expect(createProjectFolder).not.toHaveBeenCalled()
  })
})

describe('restoreDocumentFromBin', () => {
  beforeEach(() => {
    vi.mocked(findDocumentForSession).mockResolvedValue({ ...doc, folderId: 'h1' } as never)
    vi.mocked(findFolderInOrg).mockResolvedValue(holder as never)
  })

  it('restores the holder, files the document back and removes the holder', async () => {
    vi.mocked(findActiveBinEntry).mockResolvedValue({ payload: { documentId: 'd1' } } as never)
    vi.mocked(restoreFolderFromBin).mockResolvedValue({ restoredTo: 'original', folders: 1, documents: 1 })

    const result = await restoreDocumentFromBin(session, 'd1')

    expect(moveDocumentToFolder).toHaveBeenCalledWith({ documentId: 'd1', folderId: 'f-plans', expectedFolderId: 'h1' }, session)
    expect(deleteEmptyCreatedFolder).toHaveBeenCalledWith('org-1', 'p1', 'h1')
    expect(result).toEqual({ documentId: 'd1', folderId: 'f-plans', restoredTo: 'original' })
  })

  it('sends a document that went with its folder to the folder restore', async () => {
    vi.mocked(findActiveBinEntry).mockResolvedValue({ payload: {} } as never)
    await expect(restoreDocumentFromBin(session, 'd1')).rejects.toMatchObject({
      status: 409,
      details: { reason: 'binned-with-folder', folderId: 'h1' },
    })
    expect(restoreFolderFromBin).not.toHaveBeenCalled()
  })
})
