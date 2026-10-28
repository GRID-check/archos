/**
 * @vitest-environment node
 */
/**
 * The generic settings save must not be a second way to switch zero data
 * retention. It used to accept `{"settings":{"zdrOnly":false}}` under
 * `org:settings:manage` alone — no `org:models:manage`, no feature flag, no
 * confirmation, and any JSON value. The refusal lives in `updateOrgSettings`;
 * this pins it at the route, where the bypass was, with the real service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org_1',
  email: 'admin@grid.com',
  role: 'admin',
  permissions: adminPermissions(),
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
}))

const stored: { settings: Record<string, unknown>; displayName: string | null } = { settings: {}, displayName: null }
const upsertOrganization = vi.fn(async (row: { settings: Record<string, unknown>; displayName: string | null }) => {
  stored.settings = row.settings
  stored.displayName = row.displayName
})
vi.mock('@/lib/organizations/repository', () => ({
  findOrganization: vi.fn(async () => ({
    workosOrganizationId: 'org_1',
    displayName: stored.displayName,
    defaultLocale: 'de',
    settings: stored.settings,
  })),
  upsertOrganization: (row: { settings: Record<string, unknown>; displayName: string | null }) =>
    upsertOrganization(row),
}))

vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: vi.fn(),
}))
const invalidateBackendModelConfig = vi.fn()
vi.mock('@/lib/model-config/backend-key', () => ({
  invalidateBackendModelConfig: (organizationId: string) => invalidateBackendModelConfig(organizationId),
}))
const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (event: unknown) => recordAuditEvent(event) }))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn(), WEB_SEARCH_FLAG: 'web-search' }))

import { PUT } from './route'
import { isZdrOnlyForOrg } from '@/lib/organizations/service'
import { adminPermissions } from '@/test-utils/admin-permissions'

const put = (body: unknown): Promise<Response> =>
  PUT(
    new Request('http://localhost/api/organization/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

describe('PUT /api/organization/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stored.settings = {}
    stored.displayName = null
  })

  it.each([false, true, 'off', null])('refuses zdrOnly=%s with a 400 naming the ZDR route', async (value) => {
    const res = await put({ settings: { zdrOnly: value } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('/api/organization/model-config/zdr')
    expect(upsertOrganization).not.toHaveBeenCalled()
    // And the org is still ZDR: nothing was written.
    expect(await isZdrOnlyForOrg('org_1')).toBe(true)
  })

  it('refuses zdrOnly even beside legitimate keys, writing none of them', async () => {
    const res = await put({ settings: { chatEffort: 'low', zdrOnly: false } })
    expect(res.status).toBe(400)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  // Web search is a privacy switch (ADR-0022) with its own route, which the agent
  // catalog marks a control; the generic save would be a second, unmarked door.
  it.each([false, true])('refuses webSearchEnabled=%s with a 400 naming the web-search route', async (value) => {
    const res = await put({ settings: { webSearchEnabled: value } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('/api/organization/web-search')
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('still saves ordinary settings, auditing the nested keys that changed', async () => {
    stored.settings = { chatEffort: 'medium', webSearchEnabled: true }
    const res = await put({
      displayName: 'Büro Nord',
      settings: { chatEffort: 'low' },
    })
    expect(res.status).toBe(200)
    expect(stored.settings).toEqual({ chatEffort: 'low', webSearchEnabled: true })
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.settings.updated',
        metadata: { fields: 'displayName,settings.chatEffort' },
      })
    )
    expect(invalidateBackendModelConfig).not.toHaveBeenCalled()
  })
})

describe('isZdrOnlyForOrg — on unless explicitly opted out', () => {
  beforeEach(() => {
    stored.settings = {}
  })

  it('treats an org with no setting as ZDR', async () => {
    expect(await isZdrOnlyForOrg('org_1')).toBe(true)
  })

  it('treats only a stored boolean false as off', async () => {
    stored.settings = { zdrOnly: false }
    expect(await isZdrOnlyForOrg('org_1')).toBe(false)
  })

  it.each([true, 'false', 0, null])('treats a stored %s as ZDR', async (value) => {
    stored.settings = { zdrOnly: value }
    expect(await isZdrOnlyForOrg('org_1')).toBe(true)
  })

  it('treats no organization as ZDR', async () => {
    expect(await isZdrOnlyForOrg(null)).toBe(true)
  })
})
