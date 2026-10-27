/**
 * @vitest-environment node
 */
/**
 * `/api/search/saved/[id]` — the owner renames, shares or deletes their own;
 * anyone else's answers 404, as does an id that is no saved search's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'lena@example.test',
  role: 'member',
  permissions: [] as string[],
}

const OWN = '11111111-1111-4111-8111-111111111111'
const COLLEAGUES = '22222222-2222-4222-8222-222222222222'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/search/saved-search-service', async () => {
  const { NotFoundError } = await import('@/lib/api/errors')
  return {
    updateSavedSearch: vi.fn().mockImplementation(async (_owner: unknown, id: string, patch: { name?: string }) => {
      if (id !== '11111111-1111-4111-8111-111111111111') throw new NotFoundError('Saved search not found')
      return { id, name: patch.name ?? 'Brandschutz', scope: {}, query: {}, shared: false, ownedByMe: true, ownerName: null, createdAt: 'x' }
    }),
    deleteSavedSearch: vi.fn().mockImplementation(async (_owner: unknown, id: string) => {
      if (id !== '11111111-1111-4111-8111-111111111111') throw new NotFoundError('Saved search not found')
    }),
  }
})

import { deleteSavedSearch, updateSavedSearch } from '@/lib/search/saved-search-service'
import { DELETE, PATCH } from './route'

const context = (id: string) => ({ params: Promise.resolve({ id }) })
const patch = (id: string, body: unknown): Promise<Response> =>
  PATCH(
    new Request(`http://localhost/api/search/saved/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    context(id)
  )
const remove = (id: string): Promise<Response> =>
  DELETE(new Request(`http://localhost/api/search/saved/${id}`, { method: 'DELETE' }), context(id))

describe('/api/search/saved/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('PATCH renames the caller’s own, as the caller', async () => {
    const res = await patch(OWN, { name: 'Neu' })
    expect(res.status).toBe(200)
    expect((await res.json()).savedSearch.name).toBe('Neu')
    expect(updateSavedSearch).toHaveBeenCalledWith({ organizationId: 'org-1', userId: 'user-1' }, OWN, { name: 'Neu' })
  })

  it('PATCH answers 404 for a colleague’s, and 400 for an empty patch', async () => {
    expect((await patch(COLLEAGUES, { shared: true })).status).toBe(404)
    expect((await patch(OWN, {})).status).toBe(400)
  })

  it('DELETE removes the caller’s own with a 204, and answers 404 for a colleague’s', async () => {
    expect((await remove(OWN)).status).toBe(204)
    expect(deleteSavedSearch).toHaveBeenCalledWith({ organizationId: 'org-1', userId: 'user-1' }, OWN)
    expect((await remove(COLLEAGUES)).status).toBe(404)
  })

  it('answers 404 for an id that is no uuid, without asking the service', async () => {
    expect((await remove('not-an-id')).status).toBe(404)
    expect((await patch('not-an-id', { shared: true })).status).toBe(404)
    expect(deleteSavedSearch).not.toHaveBeenCalled()
    expect(updateSavedSearch).not.toHaveBeenCalled()
  })
})
