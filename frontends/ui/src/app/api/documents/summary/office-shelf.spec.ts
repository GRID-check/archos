/**
 * @vitest-environment node
 *
 * `GET /api/office-shelf/documents/summary` (ADR-0102): the Archiv's half of the
 * shelf summary, with the same filters and body as a project's.
 */
import { describe, expect, it, vi } from 'vitest'
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
vi.mock('@/lib/documents/shelf-summary', () => ({
  summarizeOfficeShelfDocuments: vi.fn().mockResolvedValue({
    folders: [{ folderId: null, total: 2400, readable: 2390, reading: 0, failed: 10, held: 0, unindexed: 0, latest: null }],
    failed: [],
    failedTruncated: false,
  }),
}))

import { summarizeOfficeShelfDocuments } from '@/lib/documents/shelf-summary'
import { GET } from './route'

const get = (query = '') =>
  GET(new NextRequest(`https://grid.test/api/documents/summary?scope=office_shelf${query.replace(/^\?/, '&')}`), { params: Promise.resolve({}) })

describe('GET /api/documents/summary?scope=office_shelf', () => {
  it("serves the Archiv's summary for the working set by default", async () => {
    const body = await (await get()).json()

    expect(body.folders[0]).toMatchObject({ folderId: null, total: 2400 })
    expect(summarizeOfficeShelfDocuments).toHaveBeenLastCalledWith(expect.anything(), {
      authoredBy: undefined,
      includeArchived: false,
    })
  })

  it('takes the server filters of the listing', async () => {
    await get('?includeArchived=true&authoredBy=user')
    expect(summarizeOfficeShelfDocuments).toHaveBeenLastCalledWith(expect.anything(), {
      authoredBy: 'user',
      includeArchived: true,
    })
  })

  it('refuses an author the column cannot hold', async () => {
    expect((await get('?authoredBy=robot')).status).toBe(400)
  })
})
