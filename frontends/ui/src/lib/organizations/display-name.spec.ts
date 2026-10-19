/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getOrganization = vi.fn()
const store = new Map<string, unknown>()
vi.mock('server-only', () => ({}))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: () => ({ organizations: { getOrganization } }) }))
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

import { getOrganizationDisplayName } from './service'

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
