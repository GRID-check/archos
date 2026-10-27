/**
 * @vitest-environment node
 */
/**
 * The role resolver's own spec: what the roles a person holds grant, as WorkOS
 * says, for the paths with roles and no token. These are the properties the
 * module's header claims.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const listOrganizationRoles = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ authorization: { listOrganizationRoles } }),
}))

import { rolePermissions, rolesHoldPermission, ROLE_CACHE_TTL_MS } from './org-role-permissions'
import { setCacheStore, type CacheStore } from '@/lib/cache'

class TestStore implements CacheStore {
  map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  /** The life each stored entry was given, in the order stored. */
  ttls: number[] = []
  async set(key: string, value: string, ttlMs = Number.POSITIVE_INFINITY): Promise<void> {
    this.ttls.push(ttlMs)
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key)
  }
}

const ORG = 'org_1'
let store: TestStore

beforeEach(() => {
  vi.clearAllMocks()
  store = new TestStore()
  setCacheStore(store)
  listOrganizationRoles.mockResolvedValue({
    data: [
      { slug: 'admin', permissions: ['org:settings:manage', 'org:projects:administer'] },
      { slug: 'member', permissions: ['org:projects:create'] },
      // An office's own role: WorkOS lists it beside the environment's.
      { slug: 'org-geschaeftsfuehrung', permissions: ['org:projects:administer', 'org:archiv:manage'] },
    ],
  })
})

describe('rolePermissions', () => {
  it('is what WorkOS says the roles hold, every role together', async () => {
    expect(await rolePermissions(ORG, ['member', 'org-geschaeftsfuehrung'])).toEqual(
      new Set(['org:projects:create', 'org:projects:administer', 'org:archiv:manage'])
    )
    expect(listOrganizationRoles).toHaveBeenCalledWith(ORG)
  })

  it('grants a role WorkOS does not list nothing, whatever it is called', async () => {
    expect(await rolePermissions(ORG, ['owner'])).toEqual(new Set())
  })

  it('asks nothing for no roles', async () => {
    expect(await rolePermissions(ORG, [])).toEqual(new Set())
    expect(listOrganizationRoles).not.toHaveBeenCalled()
  })

  it('fails closed, and does not remember the failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    listOrganizationRoles.mockRejectedValueOnce(new Error('WorkOS down'))
    expect(await rolePermissions(ORG, ['admin'])).toEqual(new Set())

    expect(await rolePermissions(ORG, ['admin'])).toEqual(new Set(['org:settings:manage', 'org:projects:administer']))
  })

  it('asks WorkOS once per organization for a minute, and keys each organization apart', async () => {
    await rolePermissions(ORG, ['admin'])
    await rolePermissions(ORG, ['member'])
    expect(listOrganizationRoles).toHaveBeenCalledTimes(1)
    expect(store.ttls).toEqual([ROLE_CACHE_TTL_MS])
    expect(ROLE_CACHE_TTL_MS).toBeLessThanOrEqual(60_000)

    await rolePermissions('org_2', ['admin'])
    expect(listOrganizationRoles).toHaveBeenCalledWith('org_2')
  })
})

describe('rolesHoldPermission', () => {
  it("answers for an office's own custom role", async () => {
    expect(await rolesHoldPermission(ORG, ['org-geschaeftsfuehrung'], 'org:projects:administer')).toBe(true)
    expect(await rolesHoldPermission(ORG, ['member'], 'org:projects:administer')).toBe(false)
  })

  it('counts a grant of the old org:archiv:manage as org:office_shelf:manage', async () => {
    expect(await rolesHoldPermission(ORG, ['org-geschaeftsfuehrung'], 'org:office_shelf:manage')).toBe(true)
  })
})
