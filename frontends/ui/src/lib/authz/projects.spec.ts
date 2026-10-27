/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const effective = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ authorization: { listEffectivePermissionsByExternalId: effective } }),
}))

const ALL_PROJECT = [
  'project:view',
  'project:chat',
  'project:edit',
  'project:documents:write',
  'project:documents:generate',
  'project:memory:write',
  'project:manage',
  'project:members:manage',
  'project:skills:manage',
]
/** What WorkOS says the member effectively holds on the project. */
const holds = (...slugs: string[]): void => {
  effective.mockResolvedValue({ autoPagination: async () => slugs.map((slug) => ({ slug })) })
}

const findProjectTenancy = vi.fn()
vi.mock('@/lib/projects/repository', () => ({
  findProjectTenancy: (...args: unknown[]) => findProjectTenancy(...args),
}))

import { requireProjectAccess } from './projects'
import { setCacheStore, type CacheStore } from '@/lib/cache'
import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'

/**
 * Controllable in-process store. Ignores TTL expiry (tests assert hits within
 * the window) and can be forced to fail every read to exercise fail-open.
 */
class TestStore implements CacheStore {
  map = new Map<string, string>()
  failGet = false
  getKeys: string[] = []

  async get(key: string): Promise<string | null> {
    this.getKeys.push(key)
    if (this.failGet) throw new Error('cache down')
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key)
  }
}

const session = (overrides: Partial<AuthorizedSession> = {}): AuthorizedSession => ({
  userId: 'user_1',
  email: 'someone@grid.com',
  name: 'Someone',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
  ...overrides,
})

const PROJECT_ID = 'proj_1'

describe('requireProjectAccess', () => {
  let store: TestStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new TestStore()
    setCacheStore(store)
    delete process.env.GRID_AUTHZ_CACHE_TTL_MS
    // Everything but manage → derived role project-editor.
    holds(...ALL_PROJECT.filter((slug) => slug !== 'project:manage'))
    findProjectTenancy.mockResolvedValue({ organizationId: 'org_1', deletedAt: null })
  })

  const authzKeys = () => store.getKeys.filter((k) => k.startsWith('authz:effective:'))

  describe('the org-wide project bypass is a PERMISSION, not a role name', () => {
    it('a role named admin without the permission in its token gets no bypass', async () => {
      // The token is the answer; the role's name is not. Such a session is asked
      // of WorkOS like anyone else.
      holds()
      await expect(requireProjectAccess(session({ role: 'admin' }), PROJECT_ID, 'project:edit')).rejects.toBeInstanceOf(
        NotFoundError
      )
      expect(effective).toHaveBeenCalled()
    })

    it('a session holding the permission bypasses, whatever its role is called', async () => {
      const result = await requireProjectAccess(
        session({ role: 'custom-owner', permissions: ['org:projects:administer'] }),
        PROJECT_ID,
        'project:manage'
      )
      expect(result).toEqual({ role: 'project-admin', closed: false, readsBecauseClosed: false })
      expect(effective).not.toHaveBeenCalled()
    })

    it('a role that is not admin and holds nothing gets no bypass', async () => {
      holds()
      await expect(
        requireProjectAccess(
          session({ role: 'org-auditor', permissions: ['org:audit:view'] }),
          PROJECT_ID,
          'project:manage'
        )
      ).rejects.toThrow('Not found')
    })

    it('a custom role with every OTHER org permission gets no bypass', async () => {
      // The mirror-image fault: the extensibility contract broke the moment a
      // persona needed to reach projects. It now works — by holding the
      // permission, which is the point — and does NOT come for free.
      holds()
      await expect(
        requireProjectAccess(
          session({
            role: 'org-owner-custom',
            permissions: [
              'org:settings:manage',
              'org:models:manage',
              'org:budgets:manage',
              'org:compliance:manage',
              'org:audit:view',
              'org:archiv:manage',
              'org:skills:manage',
              'org:projects:create',
              'org:members:manage',
            ],
          }),
          PROJECT_ID,
          'project:view'
        )
      ).rejects.toThrow('Not found')
    })
  })

  describe('the derived role reads what the caller HOLDS', () => {
    it('an admin asked via an any-of list is not demoted to editor', async () => {
      // `['project:members:manage', 'project:manage']` is how the members service
      // asks. The skipped `project:manage` check used to fall back to comparing
      // against `accepted[0]` — a different slug — so a real project admin came
      // back as an editor.
      holds('project:manage')
      await expect(
        requireProjectAccess(session(), PROJECT_ID, ['project:members:manage', 'project:manage'])
      ).resolves.toEqual({ role: 'project-admin', closed: false, readsBecauseClosed: false })
    })
  })

  it('asks WorkOS once per project, whatever it asks for', async () => {
    await requireProjectAccess(session(), PROJECT_ID, ['project:documents:write', 'project:edit'])
    expect(effective).toHaveBeenCalledTimes(1)
    expect(effective).toHaveBeenCalledWith({
      organizationMembershipId: 'om_1',
      resourceTypeSlug: 'project',
      externalId: PROJECT_ID,
    })
  })

  describe('cache disabled (GRID_AUTHZ_CACHE_TTL_MS=0)', () => {
    beforeEach(() => {
      process.env.GRID_AUTHZ_CACHE_TTL_MS = '0'
    })

    it('never consults the cache and asks on every request', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(effective).toHaveBeenCalledTimes(2)
      expect(authzKeys()).toHaveLength(0)
    })
  })

  describe('cache enabled (the default)', () => {
    it('is on when the variable is unset', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(authzKeys().length).toBeGreaterThan(0)
    })

    it('miss then populate: the first request asks WorkOS and stores the answer', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(effective).toHaveBeenCalledTimes(1)
      // The key carries the ORG, the membership and the resource TYPE as well as
      // the id, so two tenants asking about the same project id cannot collide.
      expect([...store.map.keys()]).toEqual(['authz:effective:org_1:om_1:project:proj_1'])
    })

    it('hit: an identical second request is served from cache', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      await requireProjectAccess(session(), PROJECT_ID, 'project:manage').catch(() => undefined)
      expect(effective).toHaveBeenCalledTimes(1)
    })

    it("is keyed per membership: a different user does not read another user's grant", async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      await requireProjectAccess(
        session({ organizationMembershipId: 'om_2' }),
        PROJECT_ID,
        'project:edit'
      )
      expect(effective).toHaveBeenCalledTimes(2)
    })

    it('fail-open: a cache-read outage degrades to a live call and still authorizes', async () => {
      store.failGet = true
      const result = await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(result).toEqual({ role: 'project-editor', closed: false, readsBecauseClosed: false })
      expect(effective).toHaveBeenCalledTimes(1)
    })

    it('a denied check still throws NotFound (cached denials do not leak access)', async () => {
      holds()
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:edit')).rejects.toThrow()
    })
  })

  it('fails CLOSED when the WorkOS call itself errors, and does not remember it', async () => {
    // A call that cannot complete is a denial, never a default-allow.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    effective.mockRejectedValueOnce(new Error('workos unreachable'))
    await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).rejects.toThrow(
      'Not found'
    )
    expect(store.map.size).toBe(0)
  })

  it('reads a project WorkOS has never registered as holding nothing', async () => {
    effective.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).rejects.toThrow('Not found')
  })

  it('is an editor by any write permission it holds, whatever was asked', async () => {
    // Asked only for project:view, a holder of project:documents:write is still
    // an editor: the role reads what the caller holds, not what was asked.
    holds('project:view', 'project:documents:write')
    await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).resolves.toEqual({
      role: 'project-editor',
      closed: false,
      readsBecauseClosed: false,
    })
  })

  describe('any-of permissions (the ADR-0038 project:edit split)', () => {
    const DOC_WRITE = ['project:documents:write', 'project:edit'] as const

    it('accepts the narrow permission on its own', async () => {
      holds('project:documents:write')
      // The derived role reflects the INTENT that was satisfied, so a holder of
      // only the narrow write permission reads as an editor — the same answer
      // the pre-split code gave a `project:edit` holder.
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).resolves.toEqual({
        role: 'project-editor',
        closed: false,
        readsBecauseClosed: false,
      })
    })

    it('still accepts a legacy role holding only the project:edit umbrella', async () => {
      // A custom role provisioned before the split must not lose document
      // writes the day the narrow permission is introduced.
      holds('project:edit')
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).resolves.toEqual({
        role: 'project-editor',
        closed: false,
        readsBecauseClosed: false,
      })
    })

    it('denies when the caller holds neither', async () => {
      holds('project:view')
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).rejects.toThrow(
        'Not found'
      )
    })

    it('does not let a memory grant unlock document writes', async () => {
      holds('project:memory:write')
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).rejects.toThrow(
        'Not found'
      )
    })
  })

  it('authorizes the new fine-grained project permissions', async () => {
    holds('project:memory:write')
    // Editor, not viewer. This expectation used to read `project-viewer`, which
    // contradicted the any-of case above ("a holder of only the narrow write
    // permission reads as an editor") — the ladder was keyed on the umbrella
    // `project:edit` alone, so a narrow-write role fell to the reader rung and
    // became a mere viewer on every shared thread in a project whose memory it
    // can rewrite. The rung is "holds a write permission"; which one is not the
    // ladder's business.
    await expect(
      requireProjectAccess(session(), PROJECT_ID, 'project:memory:write')
    ).resolves.toEqual({ role: 'project-editor', closed: false, readsBecauseClosed: false })
    // The same session must NOT get document writes from a memory grant.
    await expect(
      requireProjectAccess(session(), PROJECT_ID, 'project:documents:write')
    ).rejects.toThrow('Not found')
  })

  describe('a closed project (ADR-0090)', () => {
    beforeEach(() => {
      findProjectTenancy.mockResolvedValue({ organizationId: 'org_1', deletedAt: null, status: 'closed' })
    })

    const refusal = { status: 403, details: { reason: 'project-closed' } }

    it('refuses every write to an editor, with the reason the UI names', async () => {
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:documents:write')).rejects.toMatchObject(refusal)
      await expect(
        requireProjectAccess(session(), PROJECT_ID, ['project:memory:write', 'project:edit'])
      ).rejects.toMatchObject(refusal)
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:documents:generate')).rejects.toMatchObject(refusal)
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:skills:manage')).rejects.toMatchObject(refusal)
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:manage')).rejects.toMatchObject(refusal)
      // Decided before WorkOS is asked anything.
      expect(effective).not.toHaveBeenCalled()
    })

    it('refuses a write to an organization admin too: the closed check runs before the bypass', async () => {
      const admin = session({ role: 'admin', permissions: ['org:projects:administer'] })
      await expect(requireProjectAccess(admin, PROJECT_ID, 'project:documents:write')).rejects.toMatchObject(refusal)
      await expect(requireProjectAccess(admin, PROJECT_ID, 'project:view')).resolves.toMatchObject({ closed: true })
    })

    it('lets a member read and chat, and keeps their role', async () => {
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).resolves.toEqual({
        role: 'project-editor',
        closed: true,
        readsBecauseClosed: false,
      })
      await expect(requireProjectAccess(session(), PROJECT_ID, ['project:chat', 'project:edit'])).resolves.toMatchObject({
        closed: true,
        readsBecauseClosed: false,
      })
    })

    it('lets every organization member read and chat, as a viewer who reads only because it is closed', async () => {
      holds()
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).resolves.toEqual({
        role: 'project-viewer',
        closed: true,
        readsBecauseClosed: true,
      })
      await expect(requireProjectAccess(session(), PROJECT_ID, ['project:chat', 'project:edit'])).resolves.toMatchObject({
        readsBecauseClosed: true,
      })
      // Managing members stays a grant someone must hold.
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:members:manage')).rejects.toMatchObject({
        status: 404,
      })
    })

    it('still hides it from another organization and once it is deleted', async () => {
      findProjectTenancy.mockResolvedValue({ organizationId: 'org_2', deletedAt: null, status: 'closed' })
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).rejects.toMatchObject({ status: 404 })
      findProjectTenancy.mockResolvedValue({ organizationId: 'org_1', deletedAt: new Date(), status: 'closed' })
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).rejects.toMatchObject({ status: 404 })
    })

    it('asks project:manage as if active only when reopening says so', async () => {
      holds(...ALL_PROJECT)
      await expect(
        requireProjectAccess(session(), PROJECT_ID, 'project:manage', { evenWhenClosed: true })
      ).resolves.toMatchObject({ role: 'project-admin', closed: true })
      // A fresh cache: the answer above is cached for the TTL.
      setCacheStore(new TestStore())
      holds()
      await expect(
        requireProjectAccess(session(), PROJECT_ID, 'project:manage', { evenWhenClosed: true })
      ).rejects.toMatchObject({ status: 404 })
    })
  })
})
