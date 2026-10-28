/**
 * @vitest-environment node
 */
/**
 * The web-search switch (ADR-0022) has one route: the generic settings save
 * refuses the key, so this is where an agent's call lands too, marked a privacy
 * control in the catalog. Pinned with the real service: it stores a boolean,
 * drops the cached answer and the backend's shared record, and audits the switch
 * as the settings save does.
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

const stored: { settings: Record<string, unknown> } = { settings: {} }
const upsertOrganization = vi.fn(async (row: { settings: Record<string, unknown> }) => {
  stored.settings = row.settings
})
vi.mock('@/lib/organizations/repository', () => ({
  findOrganization: vi.fn(async () => ({
    workosOrganizationId: 'org_1',
    displayName: null,
    defaultLocale: 'de',
    settings: stored.settings,
  })),
  upsertOrganization: (row: { settings: Record<string, unknown> }) => upsertOrganization(row),
}))
const invalidateCached = vi.fn()
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: (key: string) => invalidateCached(key),
}))
const invalidateBackendModelConfig = vi.fn()
vi.mock('@/lib/model-config/backend-key', () => ({
  invalidateBackendModelConfig: (organizationId: string) => invalidateBackendModelConfig(organizationId),
}))
const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (event: unknown) => recordAuditEvent(event) }))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn(), WEB_SEARCH_FLAG: 'web-search' }))

import { findOperation } from '@/lib/agent-api/catalog'
import { PUT } from './route'
import { adminPermissions } from '@/test-utils/admin-permissions'

const put = (body: unknown): Promise<Response> =>
  PUT(
    new Request('http://localhost/api/organization/web-search', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

describe('PUT /api/organization/web-search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stored.settings = { chatEffort: 'low' }
  })

  it('switches web search off, keeping the rest of the bag, and audits the switch', async () => {
    const res = await put({ enabled: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ webSearchEnabled: false })
    expect(stored.settings).toEqual({ chatEffort: 'low', webSearchEnabled: false })
    expect(invalidateCached).toHaveBeenCalledWith('websearch:org_1')
    expect(invalidateBackendModelConfig).toHaveBeenCalledWith('org_1')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.settings.updated',
        metadata: { fields: 'settings.webSearchEnabled' },
      })
    )
  })

  it.each([{}, { enabled: 'off' }, { enabled: null }])('refuses %j without writing', async (body) => {
    const res = await put(body)
    expect(res.status).toBe(400)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('is the operation an agent calls, marked a privacy control', () => {
    const op = findOperation('organization-web-search-set')
    expect(op?.path).toBe('/api/organization/web-search')
    expect(op?.sensitivity).toBe('control')
  })
})
