/**
 * @vitest-environment node
 */
/**
 * `/api/search/saved` — any member lists their own and the office's shared
 * saved searches, and saves one as themselves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'lena@example.test',
  role: 'member',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
}))

vi.mock('@/lib/projects/service', () => ({ listProjects: vi.fn().mockResolvedValue([{ id: 'project-a' }]) }))

vi.mock('@/lib/search/saved-search-service', () => ({
  listSavedSearches: vi.fn().mockResolvedValue({ savedSearches: [], nextCursor: null }),
  createSavedSearch: vi.fn().mockImplementation(async (_owner: unknown, input: { name: string }) => ({
    id: '11111111-1111-4111-8111-111111111111',
    name: input.name,
    scope: {},
    query: {},
    shared: false,
    ownedByMe: true,
    ownerName: null,
    createdAt: '2026-10-27T08:00:00.000Z',
  })),
}))

import { createSavedSearch, listSavedSearches } from '@/lib/search/saved-search-service'
import { GET, POST } from './route'

const post = (body: unknown): Request =>
  new Request('http://localhost/api/search/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('/api/search/saved', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET lists for the caller, with the page asked for', async () => {
    const res = await GET(new Request('http://localhost/api/search/saved?limit=10&cursor=20'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ savedSearches: [], nextCursor: null })
    expect(listSavedSearches).toHaveBeenCalledWith(
      { organizationId: 'org-1', userId: 'user-1' },
      { limit: 10, cursor: '20' },
      expect.any(Function)
    )
  })

  it('GET hands the service the projects the caller may view', async () => {
    await GET(new Request('http://localhost/api/search/saved'))
    const viewableProjects = vi.mocked(listSavedSearches).mock.calls[0]?.[2]
    expect(await viewableProjects?.()).toEqual(new Set(['project-a']))
  })

  it('GET refuses a limit above the cap with a 400', async () => {
    expect((await GET(new Request('http://localhost/api/search/saved?limit=1000'))).status).toBe(400)
    expect(listSavedSearches).not.toHaveBeenCalled()
  })

  it('POST saves as the caller and answers 201 with the view', async () => {
    const res = await POST(post({ name: 'Brandschutz', scope: {}, query: { text: 'Brandschutzkonzept' }, shared: true }))
    expect(res.status).toBe(201)
    expect((await res.json()).savedSearch.ownedByMe).toBe(true)
    expect(createSavedSearch).toHaveBeenCalledWith(
      { organizationId: 'org-1', userId: 'user-1' },
      { name: 'Brandschutz', scope: {}, query: { text: 'Brandschutzkonzept' }, shared: true }
    )
  })

  it('POST refuses a question the search would refuse, before anything is written', async () => {
    expect((await POST(post({ name: 'x', scope: {}, query: { sort: 'nonsense' } }))).status).toBe(400)
    expect((await POST(post({ name: 'x', scope: { projectId: 'not-a-uuid' }, query: {} }))).status).toBe(400)
    expect((await POST(post({ scope: {}, query: {} }))).status).toBe(400)
    expect(createSavedSearch).not.toHaveBeenCalled()
  })
})
