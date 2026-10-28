/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/organizations/service', () => ({ getOrganizationDisplayName: vi.fn() }))

import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { resolvePerson } from './person'

const person = (name: string, email: string | null) => ({ userId: 'user_1', name, email, profilePictureUrl: null })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getOrganizationDisplayName).mockResolvedValue('Atelier Nord')
})

describe('resolvePerson', () => {
  it('names the person and the office from the cached directory and display name', async () => {
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map([['user_1', person('Anna Weber', 'anna@example.test')]]))

    expect(await resolvePerson('org_1', 'user_1')).toEqual({
      name: 'Anna Weber', email: 'anna@example.test', organizationName: 'Atelier Nord',
    })
    expect(loadOrganizationDirectory).toHaveBeenCalledWith('org_1')
  })

  it("reads the directory's placeholders as no name, never as one", async () => {
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map([['user_1', person('anna@example.test', 'anna@example.test')]]))
    expect((await resolvePerson('org_1', 'user_1')).name).toBeNull()

    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map([['user_1', person('Unknown', null)]]))
    expect((await resolvePerson('org_1', 'user_1')).name).toBeNull()
  })

  it('knows the office even when the person is not in the directory', async () => {
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())

    expect(await resolvePerson('org_1', 'user_1')).toEqual({ name: null, email: null, organizationName: 'Atelier Nord' })
  })
})
