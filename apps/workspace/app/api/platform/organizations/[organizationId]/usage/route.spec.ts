/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = { userId: 'user_operator', organizationId: 'org_platform' }
vi.mock('@/lib/auth/session', () => ({ getGridSession: async () => session }))

const requirePlatformPermission = vi.fn()
vi.mock('@/lib/authz/platform', () => {
  class PlatformAccessDeniedError extends Error { readonly status = 403 }
  return {
    PlatformAccessDeniedError,
    requirePlatformPermission: (...args: unknown[]) => requirePlatformPermission(...args),
  }
})

const getPlatformOrgUsage = vi.fn()
vi.mock('@/lib/budgets/platform-service', () => ({
  getPlatformOrgUsage: (...args: unknown[]) => getPlatformOrgUsage(...args),
}))

import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { GET } from './route'

const context = { params: Promise.resolve({ organizationId: 'org_tenant' }) }
const url = 'http://localhost/api/platform/organizations/org_tenant/usage'

describe('platform organization usage route', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requirePlatformPermission.mockResolvedValue(undefined)
    getPlatformOrgUsage.mockResolvedValue({ organization: { id: 'org_tenant', name: 'Büro Nord' }, usage: {}, members: [] })
  })

  it('reads the URL organization under the usage-view permission', async () => {
    expect((await GET(new Request(url), context)).status).toBe(200)
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, PLATFORM_PERMISSIONS.usageView)
    expect(getPlatformOrgUsage).toHaveBeenCalledWith(session, 'org_tenant')
  })

  it('refuses a caller without it before reaching the service', async () => {
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
    expect((await GET(new Request(url), context)).status).toBe(403)
    expect(getPlatformOrgUsage).not.toHaveBeenCalled()
  })
})
