/**
 * @vitest-environment node
 */
/**
 * `GET /api/documents/summary` (ADR-0102): the counts behind a paged Files
 * workspace's folder tiles and brief, with the listing's two server filters.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    email: 'a@b.test',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
    accessToken: '',
    name: null,
    featureFlags: null,
  }),
}))
vi.mock('@/lib/documents/shelf-summary', () => ({
  summarizeProjectDocuments: vi.fn().mockResolvedValue({ folders: [], failed: [], failedTruncated: false }),
}))

import { ForbiddenError } from '@/lib/api/errors'
import { summarizeProjectDocuments } from '@/lib/documents/shelf-summary'
import { GET } from './route'

const call = (query: string) =>
  GET(new Request(`https://grid.test/api/documents/summary${query}`), { params: Promise.resolve({}) })

describe('GET /api/documents/summary', () => {
  it('summarizes the working set of the project by default', async () => {
    const response = await call('?projectId=proj_1')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ folders: [], failed: [], failedTruncated: false })
    expect(summarizeProjectDocuments).toHaveBeenLastCalledWith(expect.anything(), 'proj_1', {
      authoredBy: undefined,
      includeArchived: false,
    })
  })

  it("takes the listing's server filters", async () => {
    await call('?projectId=proj_1&authoredBy=agent&includeArchived=true')
    expect(summarizeProjectDocuments).toHaveBeenLastCalledWith(expect.anything(), 'proj_1', {
      authoredBy: 'agent',
      includeArchived: true,
    })
  })

  it.each([
    ['no project', ''],
    ['an author the column cannot hold', '?projectId=proj_1&authoredBy=robot'],
    ['includeArchived with any value but true', '?projectId=proj_1&includeArchived=1'],
  ])('refuses %s with a 400', async (_label, query) => {
    expect((await call(query)).status).toBe(400)
  })

  it("answers the service's refusal as a 403", async () => {
    vi.mocked(summarizeProjectDocuments).mockRejectedValueOnce(new ForbiddenError())
    expect((await call('?projectId=proj_other')).status).toBe(403)
  })
})
