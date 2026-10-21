/**
 * @vitest-environment node
 *
 * The bulk filing move: each move goes through `moveDocumentsToFolders` (one
 * `moveDocumentToFolder` per document), the body is bounded, and the answer is
 * the contract's per-document results.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'member',
    permissions: [],
    featureFlags: null,
  }),
}))

vi.mock('@/lib/documents/move-to-folder', () => ({ moveDocumentsToFolders: vi.fn() }))

import { moveDocumentsToFolders } from '@/lib/documents/move-to-folder'
import { folderMovesResponseSchema, MAX_FOLDER_MOVES } from '@/lib/filing/root-sort-types'
import { POST } from './route'

const DOC = '00000000-0000-4000-8000-000000000001'
const FOLDER = '00000000-0000-4000-8000-000000000002'

const post = (body: unknown) =>
  POST(
    new NextRequest('https://grid.test/api/documents/folder-moves', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({}) }
  )

describe('POST /api/documents/folder-moves', () => {
  beforeEach(() => vi.mocked(moveDocumentsToFolders).mockReset())

  it('moves each document and answers per document', async () => {
    vi.mocked(moveDocumentsToFolders).mockResolvedValue([{ documentId: DOC, ok: true, error: null }])
    const response = await post({ moves: [{ documentId: DOC, folderId: FOLDER }] })
    expect(response.status).toBe(200)
    expect(folderMovesResponseSchema.parse(await response.json())).toEqual({
      results: [{ documentId: DOC, ok: true, error: null }],
    })
    expect(moveDocumentsToFolders).toHaveBeenCalledWith([{ documentId: DOC, folderId: FOLDER }], expect.anything())
  })

  it('refuses more moves than one request may carry', async () => {
    const moves = Array.from({ length: MAX_FOLDER_MOVES + 1 }, () => ({ documentId: DOC, folderId: null }))
    const response = await post({ moves })
    expect(response.status).toBe(400)
    expect(moveDocumentsToFolders).not.toHaveBeenCalled()
  })
})
