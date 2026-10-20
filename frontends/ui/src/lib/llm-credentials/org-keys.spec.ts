/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./org-keys-repository', () => ({
  ACTIVE_KEY_INDEX: 'uniq_org_openrouter_keys_active',
  getActiveOrgKey: vi.fn(),
  insertActiveOrgKey: vi.fn(),
}))

vi.mock('./secret-store', () => ({
  deleteSecret: vi.fn().mockResolvedValue(undefined),
  keyFingerprint: vi.fn().mockReturnValue('fp'),
  revealSecret: vi.fn().mockResolvedValue('sk-or-org'),
  storeSecret: vi.fn().mockResolvedValue({ secretBackend: 'local-aes-gcm', vaultObjectId: null, encryptedKey: '{}' }),
}))

const getOrganization = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ organizations: { getOrganization } }),
}))

import { getActiveOrgKey, insertActiveOrgKey } from './org-keys-repository'
import { monthlyLimitUsd, orgKeysEnabled, resolveOrgOpenrouterKey } from './org-keys'
import { deleteSecret, revealSecret } from './secret-store'

const ROW = {
  id: 'key-1',
  organizationId: 'org_1',
  openrouterKeyHash: 'hash-1',
  secretBackend: 'local-aes-gcm',
  vaultObjectId: null,
  encryptedKey: '{}',
  keyFingerprint: 'fp',
  limitUsd: null,
  status: 'active',
  createdAt: new Date(),
  disabledAt: null,
}

function created(key = 'sk-or-new', hash = 'hash-new') {
  return new Response(JSON.stringify({ key, data: { hash } }), { status: 201 })
}

describe('resolveOrgOpenrouterKey', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OPENROUTER_MANAGEMENT_KEY', 'mgmt-key')
    vi.stubEnv('OPENROUTER_ORG_KEY_MONTHLY_LIMIT_USD', '')
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(revealSecret).mockResolvedValue('sk-or-org')
    getOrganization.mockResolvedValue({ id: 'org_1' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('is off without a management key, and touches nothing', async () => {
    vi.stubEnv('OPENROUTER_MANAGEMENT_KEY', '')
    expect(orgKeysEnabled()).toBe(false)
    expect(await resolveOrgOpenrouterKey('org_1')).toBeNull()
    expect(getActiveOrgKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves the stored key without calling OpenRouter', async () => {
    vi.mocked(getActiveOrgKey).mockResolvedValue(ROW as never)
    expect(await resolveOrgOpenrouterKey('org_1')).toEqual({ id: 'key-1', apiKey: 'sk-or-org', keyFingerprint: 'fp' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates the key at OpenRouter the first time, with the monthly backstop', async () => {
    vi.stubEnv('OPENROUTER_ORG_KEY_MONTHLY_LIMIT_USD', '250')
    vi.mocked(getActiveOrgKey).mockResolvedValue(null)
    vi.mocked(insertActiveOrgKey).mockImplementation(async (values) => ({ ...ROW, ...values }) as never)
    fetchMock.mockResolvedValue(created())

    const key = await resolveOrgOpenrouterKey('org_1')

    expect(key).toMatchObject({ apiKey: 'sk-or-new', keyFingerprint: 'fp' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/keys')
    expect(init.headers.Authorization).toBe('Bearer mgmt-key')
    expect(JSON.parse(init.body)).toEqual({
      name: 'Piloti org_1',
      limit: 250,
      limit_reset: 'monthly',
      include_byok_in_limit: false,
    })
    expect(insertActiveOrgKey).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1', openrouterKeyHash: 'hash-new', limitUsd: '250' })
    )
  })

  it('creates one key however many calls race in one process', async () => {
    vi.mocked(getActiveOrgKey).mockResolvedValue(null)
    vi.mocked(insertActiveOrgKey).mockImplementation(async (values) => ({ ...ROW, ...values }) as never)
    fetchMock.mockResolvedValue(created())

    await Promise.all([resolveOrgOpenrouterKey('org_1'), resolveOrgOpenrouterKey('org_1')])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the winner and retires its own key when another replica provisioned first', async () => {
    vi.mocked(getActiveOrgKey).mockResolvedValueOnce(null).mockResolvedValueOnce(ROW as never)
    vi.mocked(insertActiveOrgKey).mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'uniq_org_openrouter_keys_active' })
    )
    fetchMock.mockResolvedValueOnce(created()).mockResolvedValueOnce(new Response('{"deleted":true}'))

    const key = await resolveOrgOpenrouterKey('org_1')

    expect(key).toEqual({ id: 'key-1', apiKey: 'sk-or-org', keyFingerprint: 'fp' })
    expect(deleteSecret).toHaveBeenCalled()
    expect(fetchMock.mock.calls[1][0]).toBe('https://openrouter.ai/api/v1/keys/hash-new')
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE')
  })

  it('fails closed when OpenRouter refuses to create the key, and does not retry at once', async () => {
    vi.mocked(getActiveOrgKey).mockResolvedValue(null)
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(resolveOrgOpenrouterKey('org_refused')).rejects.toMatchObject({ status: 503 })
    await expect(resolveOrgOpenrouterKey('org_refused')).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(insertActiveOrgKey).not.toHaveBeenCalled()
  })

  it('retires the key it created when storing it fails for any other reason', async () => {
    vi.mocked(getActiveOrgKey).mockResolvedValue(null)
    vi.mocked(insertActiveOrgKey).mockRejectedValue(new Error('database down'))
    fetchMock.mockResolvedValueOnce(created()).mockResolvedValueOnce(new Response('{"deleted":true}'))

    await expect(resolveOrgOpenrouterKey('org_store_fails')).rejects.toThrow('database down')

    expect(deleteSecret).toHaveBeenCalled()
    expect(fetchMock.mock.calls[1][0]).toBe('https://openrouter.ai/api/v1/keys/hash-new')
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE')
  })

  it('creates no key for an organization WorkOS does not know', async () => {
    vi.mocked(getActiveOrgKey).mockResolvedValue(null)
    getOrganization.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    await expect(resolveOrgOpenrouterKey('org_unknown')).rejects.toMatchObject({ status: 404 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when the stored key cannot be read', async () => {
    vi.mocked(getActiveOrgKey).mockResolvedValue(ROW as never)
    vi.mocked(revealSecret).mockRejectedValue(new Error('vault down'))
    await expect(resolveOrgOpenrouterKey('org_1')).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('monthlyLimitUsd', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is null when unset and refuses a value that is not a positive number', () => {
    vi.stubEnv('OPENROUTER_ORG_KEY_MONTHLY_LIMIT_USD', '')
    expect(monthlyLimitUsd()).toBeNull()
    vi.stubEnv('OPENROUTER_ORG_KEY_MONTHLY_LIMIT_USD', '-5')
    expect(() => monthlyLimitUsd()).toThrow()
  })
})
