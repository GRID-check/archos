/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getOrganization = vi.fn()
const listOrganizationMemberships = vi.fn()
const store = new Map<string, unknown>()
vi.mock('server-only', () => ({}))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: () => ({ organizations: { getOrganization }, userManagement: { listOrganizationMemberships } }) }))
vi.mock('./repository', () => ({ findOrganization: vi.fn(async () => null), upsertOrganization: vi.fn() }))
vi.mock('@/lib/cache', () => ({
  // Stores what the loader returns, like the real cache, including null.
  getCached: vi.fn(async (key: string, _ttl: number, load: () => Promise<unknown>) => {
    if (store.has(key)) return store.get(key)
    const value = await load()
    store.set(key, value)
    return value
  }),
  invalidateCached: vi.fn(),
}))

import { belongsToSeveralOrganizations, getOrganizationDisplayName } from './service'

beforeEach(() => {
  vi.clearAllMocks()
  store.clear()
})

describe('getOrganizationDisplayName', () => {
  it('falls back to the WorkOS name when the organization has no local row', async () => {
    getOrganization.mockResolvedValueOnce({ name: 'feld72 Architekten' })
    expect(await getOrganizationDisplayName('org_prod')).toBe('feld72 Architekten')
  })

  it('never caches a failed lookup as "no name": the next call asks WorkOS again', async () => {
    getOrganization.mockRejectedValueOnce(new Error('timeout'))
    expect(await getOrganizationDisplayName('org_prod')).toBeNull()

    getOrganization.mockResolvedValueOnce({ name: 'feld72 Architekten' })
    expect(await getOrganizationDisplayName('org_prod')).toBe('feld72 Architekten')
  })
})

describe('belongsToSeveralOrganizations', () => {
  it('asks WorkOS for at most two active memberships, which is enough to answer', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({ data: [{ id: 'om_1' }, { id: 'om_2' }] })

    expect(await belongsToSeveralOrganizations('org_a', 'user_1')).toBe(true)
    expect(listOrganizationMemberships).toHaveBeenCalledWith({ userId: 'user_1', statuses: ['active'], limit: 2 })
  })

  it('is false for someone in one organization', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({ data: [{ id: 'om_1' }] })
    expect(await belongsToSeveralOrganizations('org_a', 'user_1')).toBe(false)
  })

  it('never caches an outage as "one organization"', async () => {
    listOrganizationMemberships.mockRejectedValueOnce(new Error('timeout'))
    expect(await belongsToSeveralOrganizations('org_a', 'user_1')).toBe(false)

    listOrganizationMemberships.mockResolvedValueOnce({ data: [{ id: 'om_1' }, { id: 'om_2' }] })
    expect(await belongsToSeveralOrganizations('org_a', 'user_1')).toBe(true)
  })
})
