/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({ aggregateStorageUsageByOrganization: vi.fn() }))
vi.mock('@/lib/organizations/repository', () => ({ findOrganizations: vi.fn(), ORGANIZATION_PAGE_MAX: 500 }))
vi.mock('@/lib/organizations/display-names', () => ({ getOrganizationDisplayNames: vi.fn() }))

import { aggregateStorageUsageByOrganization } from './repository'
import { findOrganizations } from '@/lib/organizations/repository'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import { getPlatformStorageOverview } from './platform-service'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(aggregateStorageUsageByOrganization).mockResolvedValue(new Map([
    ['org_local', { bytes: 200, documents: 2 }],
    ['org_prod', { bytes: 100, documents: 1 }],
  ]) as never)
  vi.mocked(findOrganizations).mockResolvedValue({
    organizations: [{ workosOrganizationId: 'org_local', displayName: 'Büro Nord', settings: {} }],
    truncated: false,
  } as never)
})

describe('getPlatformStorageOverview', () => {
  it('names an organization without a local row through the resolver, never as its id', async () => {
    vi.mocked(getOrganizationDisplayNames).mockResolvedValue(new Map([['org_prod', 'feld72 Architekten']]))

    const { organizations } = await getPlatformStorageOverview()

    expect(organizations.map((row) => [row.organizationId, row.displayName])).toEqual([
      ['org_local', 'Büro Nord'],
      ['org_prod', 'feld72 Architekten'],
    ])
    // The local name stands; only the organizations without one are resolved.
    expect(getOrganizationDisplayNames).toHaveBeenCalledWith(['org_prod'])
  })

  it('leaves the name empty when the resolver has none, so the table falls back to the id', async () => {
    vi.mocked(getOrganizationDisplayNames).mockResolvedValue(new Map())

    const { organizations } = await getPlatformStorageOverview()

    expect(organizations.find((row) => row.organizationId === 'org_prod')?.displayName).toBeNull()
  })
})
