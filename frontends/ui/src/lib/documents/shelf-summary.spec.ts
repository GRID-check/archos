/**
 * @vitest-environment node
 */
/**
 * The shelf summary (ADR-0102): the counts a paged Files workspace folds its
 * folder tiles and folder brief from. It must sit behind the same gate, the
 * same reader and the same hidden folders as the listing it summarizes, or it
 * would count documents the listing hides from this reader. The SQL is
 * `list-page.spec.ts`'s and `list-page.integration.spec.ts`'s subject.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ getHiddenFolderIds: vi.fn(async () => ['hidden-1']) }))
vi.mock('@/lib/upload-screening/quarantine-reviewers', () => ({
  shelfReaderFor: vi.fn(async () => ({ kind: 'member', userId: 'user-1' })),
}))
vi.mock('./repository', () => ({
  summarizeShelfFolders: vi.fn(async () => [
    { folderId: null, total: 2, readable: 1, reading: 0, failed: 1, held: 0, unindexed: 0, latest: '2026-10-01T00:00:00.000Z' },
  ]),
  listShelfFailedDocuments: vi.fn(async () => ({ failed: [{ id: 'doc-1', folderId: null }], failedTruncated: false })),
}))

import { ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { listShelfFailedDocuments, summarizeShelfFolders } from './repository'
import { summarizeOfficeShelfDocuments, summarizeProjectDocuments } from './shelf-summary'

const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession

beforeEach(() => {
  vi.clearAllMocks()
})

describe('summarizeProjectDocuments', () => {
  it('asks the listing gate first, and counts nothing for a reader it refuses', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new ForbiddenError())
    await expect(summarizeProjectDocuments(session, 'proj-1')).rejects.toBeInstanceOf(ForbiddenError)
    expect(summarizeShelfFolders).not.toHaveBeenCalled()
    expect(listShelfFailedDocuments).not.toHaveBeenCalled()
  })

  it("counts the project's shelf for this reader, without its hidden folders, with the listing's filters", async () => {
    const summary = await summarizeProjectDocuments(session, 'proj-1', { authoredBy: 'agent', includeArchived: true })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:view')
    expect(shelfReaderFor).toHaveBeenCalledWith(session, { scope: 'project', projectId: 'proj-1' })
    const filters = {
      hiddenFolderIds: ['hidden-1'],
      reader: { kind: 'member', userId: 'user-1' },
      authoredBy: 'agent',
      includeArchived: true,
    }
    expect(summarizeShelfFolders).toHaveBeenCalledWith({ kind: 'project', projectId: 'proj-1' }, 'org-1', filters)
    expect(listShelfFailedDocuments).toHaveBeenCalledWith({ kind: 'project', projectId: 'proj-1' }, 'org-1', filters)
    expect(summary).toEqual({
      folders: [
        { folderId: null, total: 2, readable: 1, reading: 0, failed: 1, held: 0, unindexed: 0, latest: '2026-10-01T00:00:00.000Z' },
      ],
      failed: [{ id: 'doc-1', folderId: null }],
      failedTruncated: false,
    })
  })
})

describe('summarizeOfficeShelfDocuments', () => {
  it("counts the organization's Archiv for this reader", async () => {
    await summarizeOfficeShelfDocuments(session)

    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(shelfReaderFor).toHaveBeenCalledWith(session, { scope: 'office_shelf', projectId: null })
    expect(summarizeShelfFolders).toHaveBeenCalledWith({ kind: 'office_shelf' }, 'org-1', {
      reader: { kind: 'member', userId: 'user-1' },
      authoredBy: undefined,
      includeArchived: undefined,
    })
  })
})
