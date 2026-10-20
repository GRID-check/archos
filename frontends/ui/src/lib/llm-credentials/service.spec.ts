/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./repository', () => ({
  getActiveCredential: vi.fn(),
  getCredential: vi.fn(),
  insertActiveCredential: vi.fn(),
  listCredentials: vi.fn().mockResolvedValue([]),
  markUsed: vi.fn().mockResolvedValue(undefined),
  markVerified: vi.fn(),
  revokeCredential: vi.fn(),
}))

vi.mock('./secret-store', () => ({
  activeSecretBackend: vi.fn().mockReturnValue('local-aes-gcm'),
  deleteSecret: vi.fn(),
  keyFingerprint: vi.fn().mockReturnValue('fp'),
  keyHint: vi.fn().mockReturnValue('…abcd'),
  revealSecret: vi.fn().mockResolvedValue('sk-tenant'),
  storeSecret: vi.fn(),
}))

vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: vi.fn().mockResolvedValue({ displayName: null, defaultLocale: 'en', settings: {} }),
  updateOrgSettings: vi.fn(),
}))

vi.mock('@/lib/workos/feature-flags', () => ({
  isOrgFeatureEnabled: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { getActiveCredentialProvider, resolveActiveCredentialForBackend } from './service'
import { getActiveCredential, markUsed } from './repository'
import { revealSecret } from './secret-store'
import { getOrgSettings } from '@/lib/organizations/service'

const ROW = {
  id: 'cred-1',
  organizationId: 'org-1',
  provider: 'openrouter',
  baseUrl: null,
  secretBackend: 'local-aes-gcm',
  vaultObjectId: null,
  encryptedKey: '{"v":1}',
  keyFingerprint: 'fp',
  status: 'active',
  lastUsedAt: new Date(),
}

describe('resolveActiveCredentialForBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getOrgSettings).mockResolvedValue({ displayName: null, defaultLocale: 'en', settings: {} })
    vi.mocked(revealSecret).mockResolvedValue('sk-tenant')
  })

  it('returns the decrypted credential in byok mode (the default)', async () => {
    vi.mocked(getActiveCredential).mockResolvedValue(ROW as never)
    const credential = await resolveActiveCredentialForBackend('org-1')
    expect(credential).toMatchObject({
      id: 'cred-1',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-tenant',
    })
  })

  it('returns null in platform mode even though a credential is stored', async () => {
    vi.mocked(getActiveCredential).mockResolvedValue(ROW as never)
    vi.mocked(getOrgSettings).mockResolvedValue({
      displayName: null,
      defaultLocale: 'en',
      settings: { llmProviderMode: 'platform' },
    })
    expect(await resolveActiveCredentialForBackend('org-1')).toBeNull()
    expect(revealSecret).not.toHaveBeenCalled()
  })

  it('returns null when the org has no credential', async () => {
    vi.mocked(getActiveCredential).mockResolvedValue(null)
    expect(await resolveActiveCredentialForBackend('org-1')).toBeNull()
  })

  it('returns null without the byok-llm flag, before anything is decrypted', async () => {
    // The check used to run only under GRID_ENFORCE_FEATURE_FLAGS, so a
    // deployment without it served every stored key whatever WorkOS said.
    vi.mocked(isOrgFeatureEnabled).mockResolvedValueOnce(false)
    vi.mocked(getActiveCredential).mockResolvedValue(ROW as never)
    expect(await resolveActiveCredentialForBackend('org-1')).toBeNull()
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('byok-llm', 'org-1')
    expect(revealSecret).not.toHaveBeenCalled()
  })

  it('fails closed when the secret cannot be revealed (ADR-0118: no fallback to the platform key)', async () => {
    vi.mocked(getActiveCredential).mockResolvedValue(ROW as never)
    vi.mocked(revealSecret).mockRejectedValue(new Error('vault down'))
    await expect(resolveActiveCredentialForBackend('org-1')).rejects.toMatchObject({ status: 503 })
  })
})

describe('getActiveCredentialProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getOrgSettings).mockResolvedValue({ displayName: null, defaultLocale: 'en', settings: {} })
  })

  it('names the BYOK provider without revealing the key or marking it used', async () => {
    vi.mocked(getActiveCredential).mockResolvedValue({ ...ROW, provider: 'openai', lastUsedAt: null } as never)
    expect(await getActiveCredentialProvider('org-1')).toBe('openai')
    expect(revealSecret).not.toHaveBeenCalled()
    expect(markUsed).not.toHaveBeenCalled()
  })

  it('is null on the platform key: no credential, or platform mode', async () => {
    vi.mocked(getActiveCredential).mockResolvedValue(null)
    expect(await getActiveCredentialProvider('org-1')).toBeNull()
    vi.mocked(getActiveCredential).mockResolvedValue(ROW as never)
    vi.mocked(getOrgSettings).mockResolvedValue({
      displayName: null,
      defaultLocale: 'en',
      settings: { llmProviderMode: 'platform' },
    })
    expect(await getActiveCredentialProvider('org-1')).toBeNull()
  })
})
