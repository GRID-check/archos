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

import { getOrganizationDisplayName, switchableOrganizations } from './service'

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

describe('switchableOrganizations', () => {
  const membership = (organizationId: string, organizationName: string) => ({ organizationId, organizationName })

  it('lists the active memberships by name, the current one marked', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({
      data: [membership('org_b', 'GRID Test'), membership('org_a', 'feld72 Architekten')],
    })

    expect(await switchableOrganizations('org_b', 'user_1')).toEqual([
      { id: 'org_a', name: 'feld72 Architekten', current: false },
      { id: 'org_b', name: 'GRID Test', current: true },
    ])
    expect(listOrganizationMemberships).toHaveBeenCalledWith({ userId: 'user_1', statuses: ['active'], limit: 50 })
  })

  it('offers nothing to someone in one organization', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({ data: [membership('org_a', 'feld72 Architekten')] })
    expect(await switchableOrganizations('org_a', 'user_1')).toEqual([])
  })

  it('never caches an outage as "one organization"', async () => {
    listOrganizationMemberships.mockRejectedValueOnce(new Error('timeout'))
    expect(await switchableOrganizations('org_a', 'user_1')).toEqual([])

    listOrganizationMemberships.mockResolvedValueOnce({ data: [membership('org_a', 'A'), membership('org_b', 'B')] })
    expect(await switchableOrganizations('org_a', 'user_1')).toHaveLength(2)
  })
})
