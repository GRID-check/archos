/**
 * @vitest-environment node
 *
 * The roster read: every page is fetched, in order, and a refused page throws
 * with its status. The overview tile and the folder picker both rely on the
 * roster being complete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { listProjectMembers } from './project-members-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const member = (userId: string, role: string | null) => ({
  userId,
  name: `Person ${userId}`,
  email: null,
  profilePictureUrl: null,
  role,
})

describe('listProjectMembers', () => {
  it('reads every page of the roster, following the cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ members: [member('u-1', 'owner')], nextCursor: 'c-2' }))
      .mockResolvedValueOnce(Response.json({ members: [member('u-2', null)], nextCursor: null }))

    const roster = await listProjectMembers('p-1')

    expect(roster.map((entry) => entry.userId)).toEqual(['u-1', 'u-2'])
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/projects/p-1/members?limit=200',
      '/api/projects/p-1/members?limit=200&cursor=c-2',
    ])
  })

  it('throws the typed error with the status when a page is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }))

    const failure = await listProjectMembers('p-1').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 403 })
  })
})
