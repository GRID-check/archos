/**
 * @vitest-environment node
 */
/**
 * One document as a listing row, by id (ADR-0102): the deep link's fallback
 * when the paged level has not loaded the document. It must be exactly as
 * guarded as the item routes (`getAccessibleDocument`) and read through the
 * listing's own predicates and reader, or a link would open a row the listing
 * hides.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ getHiddenFolderIds: vi.fn(async () => ['hidden-1']) }))
vi.mock('@/lib/upload-screening/quarantine-reviewers', () => ({
  shelfReaderFor: vi.fn(async () => ({ kind: 'member', userId: 'user-1' })),
}))
vi.mock('./repository', () => ({ findShelfDocumentListRow: vi.fn() }))
vi.mock('./shelf-listing', () => ({ toListedDocuments: vi.fn(async (_session: unknown, rows: unknown[]) => rows) }))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { makeDocument } from '@/test-utils/db-fixtures'
import { getAccessibleDocument } from './access'
import { findShelfDocumentListRow, type DocumentListRow } from './repository'
import { toListedDocuments } from './shelf-listing'
import { getListedDocument } from './listed-document'

const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession
const ROW = { id: 'doc-1', filename: 'plan.pdf' } as DocumentListRow

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getListedDocument', () => {
  it('reads a project document through the listing predicates, hidden folders and archived rows included', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(makeDocument({ id: 'doc-1', projectId: 'proj-1', scope: 'project' }))
    vi.mocked(findShelfDocumentListRow).mockResolvedValue(ROW)

    expect(await getListedDocument(session, 'doc-1')).toBe(ROW)
    expect(getAccessibleDocument).toHaveBeenCalledWith(session, 'doc-1')
    expect(findShelfDocumentListRow).toHaveBeenCalledWith({ kind: 'project', projectId: 'proj-1' }, 'org-1', 'doc-1', {
      hiddenFolderIds: ['hidden-1'],
      reader: { kind: 'member', userId: 'user-1' },
      includeArchived: true,
    })
  })

  it('reads an Archiv document on the Archiv shelf, which hides no folders', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(makeDocument({ id: 'doc-1', projectId: null, scope: 'office_shelf' }))
    vi.mocked(findShelfDocumentListRow).mockResolvedValue(ROW)

    await getListedDocument(session, 'doc-1')

    expect(getHiddenFolderIds).not.toHaveBeenCalled()
    expect(findShelfDocumentListRow).toHaveBeenCalledWith({ kind: 'office_shelf' }, 'org-1', 'doc-1', expect.anything())
  })

  it('refuses what the item gate refuses, before reading anything', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new ForbiddenError())
    await expect(getListedDocument(session, 'doc-1')).rejects.toBeInstanceOf(ForbiddenError)
    expect(findShelfDocumentListRow).not.toHaveBeenCalled()
  })

  it('does not find a chat attachment, which is on no shelf', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(
      makeDocument({ id: 'doc-1', projectId: null, scope: 'session', conversationId: 'conv-1' }),
    )
    await expect(getListedDocument(session, 'doc-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('does not find a row the listing predicates leave out', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(makeDocument({ id: 'doc-1', projectId: 'proj-1', scope: 'project' }))
    vi.mocked(findShelfDocumentListRow).mockResolvedValue(null)
    await expect(getListedDocument(session, 'doc-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('does not find a row the reconcile turned into one this reader may not see', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(makeDocument({ id: 'doc-1', projectId: 'proj-1', scope: 'project' }))
    vi.mocked(findShelfDocumentListRow).mockResolvedValue(ROW)
    vi.mocked(toListedDocuments).mockResolvedValueOnce([])
    await expect(getListedDocument(session, 'doc-1')).rejects.toBeInstanceOf(NotFoundError)
  })
})
