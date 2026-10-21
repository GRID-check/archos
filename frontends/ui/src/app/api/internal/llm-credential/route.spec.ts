/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceUnavailableError } from '@/lib/api/errors'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', async () => ({
  ...(await vi.importActual<typeof import('@/lib/db/tenant-context')>('@/lib/db/tenant-context')),
  withTenant: (_context: unknown, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('@/lib/llm-credentials/service', () => ({
  resolveActiveCredentialForBackend: vi.fn(),
}))
vi.mock('@/lib/llm-credentials/org-keys', () => ({
  orgKeysEnabled: vi.fn(),
  resolveOrgOpenrouterKey: vi.fn(),
}))

import { orgKeysEnabled, resolveOrgOpenrouterKey } from '@/lib/llm-credentials/org-keys'
import { resolveActiveCredentialForBackend } from '@/lib/llm-credentials/service'
import { GET } from './route'

const call = (organizationId = 'org_01ABC'): Promise<Response> =>
  GET(
    new Request(`http://localhost/api/internal/llm-credential?organizationId=${organizationId}`, {
      headers: { 'x-grid-internal-token': 'test-token' },
    })
  )

describe('GET /api/internal/llm-credential', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
    vi.mocked(resolveActiveCredentialForBackend).mockResolvedValue(null)
    vi.mocked(orgKeysEnabled).mockReturnValue(true)
    vi.mocked(resolveOrgOpenrouterKey).mockResolvedValue({ id: 'key-1', apiKey: 'sk-or-org', keyFingerprint: 'fp' })
  })

  it('answers the BYOK credential, the organization’s platform key and whether per-org keys are on', async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      credential: null,
      platformKey: { id: 'key-1', apiKey: 'sk-or-org', keyFingerprint: 'fp' },
      perOrgKeys: true,
    })
    expect(resolveOrgOpenrouterKey).toHaveBeenCalledWith('org_01ABC')
  })

  it('says per-org keys are off on a deployment without a management key', async () => {
    vi.mocked(orgKeysEnabled).mockReturnValue(false)
    vi.mocked(resolveOrgOpenrouterKey).mockResolvedValue(null)
    expect(await (await call()).json()).toMatchObject({ platformKey: null, perOrgKeys: false })
  })

  it('is a 503, never a null key, when the organization’s key cannot be resolved', async () => {
    vi.mocked(resolveOrgOpenrouterKey).mockRejectedValue(new ServiceUnavailableError('vault down'))
    expect((await call()).status).toBe(503)
  })
})
