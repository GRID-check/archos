/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listProjectPeople } from './folder-access-client'

function page(userIds: string[], nextCursor: string | null): Response {
  const members = userIds.map((userId) => ({ userId, name: userId, email: null, role: 'project-viewer' }))
  return new Response(JSON.stringify({ members, nextCursor, viewerUserId: 'u_0' }), { status: 200 })
}

describe('listProjectPeople', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads every page of the roster, so nobody past the first page is dropped', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page(['u_1', 'u_2'], '2')).mockResolvedValueOnce(page(['u_3'], null))
    vi.stubGlobal('fetch', fetchMock)

    const people = await listProjectPeople('proj 1')

    expect(people.map((person) => person.userId)).toEqual(['u_1', 'u_2', 'u_3'])
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/projects/proj%201/members?limit=200',
      '/api/projects/proj%201/members?limit=200&cursor=2',
    ])
  })
})
