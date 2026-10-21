/**
 * @vitest-environment node
 */
/**
 * A secret is write-only through the agent door (ADR-0122, "Sensitive
 * operations"). The organization's LLM provider key goes in through
 * `organization-llm-credential-create` and never comes back out: not in a
 * result, not in a refusal, not in the telemetry the door records. The
 * operations run here as they do for an external agent, through
 * `runOperation`, the catalog entry and the real route; only the credential
 * service (it talks to the provider and the vault) is a stand-in, and the
 * answer it gives is built by the real `toView`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/llm-credentials/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/llm-credentials/service')>()),
  createCredential: vi.fn(),
  listOrgCredentials: vi.fn(),
  getLlmProviderMode: vi.fn(),
  verifyOrgCredential: vi.fn(),
}))
vi.mock('./telemetry', () => ({ recordOperationCalled: vi.fn(), recordCapabilityMissing: vi.fn() }))
// The scope is not enforced by WorkOS yet, so no principal sees these; the visibility guards
// have their own spec (policy.spec.ts). Here the question is only what comes back.
vi.mock('./policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./policy')>()
  const { findOperation } = await import('./catalog')
  return { ...actual, findVisibleOperation: (_principal: unknown, name: string) => findOperation(name) }
})

import { UnprocessableError } from '@/lib/api/errors'
import { FEATURE_FLAGS } from '@/lib/authz/feature-flags'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import type { OrgLlmCredential } from '@/lib/db/schema'
import { keyFingerprint, keyHint } from '@/lib/llm-credentials/secret-store'
import {
  createCredential,
  getLlmProviderMode,
  listOrgCredentials,
  toView,
  verifyOrgCredential,
} from '@/lib/llm-credentials/service'
import { runOperation } from './discovery'
import type { AgentPrincipal } from './principal'
import { recordOperationCalled } from './telemetry'

const API_KEY = 'sk-or-v1-THIS-IS-THE-SECRET-0123456789abcdef'
const CREDENTIAL_ID = '6a0c1f0e-6a52-4d7e-9a43-1b2f3c4d5e6f'

const principal: AgentPrincipal = {
  actor: 'external_agent',
  clientId: 'client_claude',
  scopes: ['piloti:sensitive'],
  sensitiveOptIns: ['secret'],
  session: {
    userId: 'user_1',
    email: 'a@piloti.test',
    name: null,
    accessToken: '',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [ORG_PERMISSIONS.modelsManage],
    featureFlags: [FEATURE_FLAGS.byokLlm],
  },
}
const ctx = { principal, mode: 'search' as const }

function storedRow(): OrgLlmCredential {
  return {
    id: CREDENTIAL_ID,
    organizationId: 'org_1',
    provider: 'openrouter',
    label: 'Office key',
    baseUrl: 'https://openrouter.ai/api/v1',
    secretBackend: 'local-aes-gcm',
    secretRef: 'ref_1',
    encryptedKey: 'ciphertext',
    keyHint: keyHint(API_KEY),
    keyFingerprint: keyFingerprint(API_KEY),
    status: 'active',
    createdBy: 'user_1',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    lastVerifiedAt: new Date('2026-10-01T00:00:00Z'),
    lastUsedAt: null,
    revokedAt: null,
    rotatedFrom: null,
  } as unknown as OrgLlmCredential
}

/** Everything the door produced for the call: the result and every telemetry event. */
function emitted(result: unknown): string {
  return JSON.stringify([result, vi.mocked(recordOperationCalled).mock.calls])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('REQUIRE_AUTH', 'true')
  vi.mocked(createCredential).mockImplementation(async () => toView(storedRow()))
  vi.mocked(listOrgCredentials).mockResolvedValue([toView(storedRow())])
  vi.mocked(getLlmProviderMode).mockResolvedValue('byok')
  vi.mocked(verifyOrgCredential).mockResolvedValue({ credential: toView(storedRow()), modelCount: 12 })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('an LLM provider key through the agent door', () => {
  it('goes in on create and comes back only as a masked hint', async () => {
    const result = await runOperation(ctx, 'organization-llm-credential-create', {
      body: { provider: 'openrouter', label: 'Office key', apiKey: API_KEY },
    })

    expect(result.isError).toBeUndefined()
    expect(createCredential).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: API_KEY }),
      expect.any(Request),
    )
    expect(emitted(result)).toContain('…cdef')
    expect(emitted(result)).not.toContain(API_KEY)
  })

  it('never appears in the list, the check or the telemetry', async () => {
    for (const [name, input] of [
      ['organization-llm-credential-list', {}],
      ['organization-llm-credential-verify', { params: { id: CREDENTIAL_ID } }],
    ] as const) {
      const result = await runOperation(ctx, name, input)
      expect(result.isError, name).toBeUndefined()
      expect(emitted(result), name).not.toContain(API_KEY)
    }
  })

  it('is not echoed by a refusal, from the provider or from the input check', async () => {
    vi.mocked(createCredential).mockRejectedValue(new UnprocessableError('The provider rejected this API key'))
    const rejected = await runOperation(ctx, 'organization-llm-credential-create', {
      body: { provider: 'openrouter', label: 'Office key', apiKey: API_KEY },
    })
    expect(rejected.isError).toBe(true)
    expect(emitted(rejected)).not.toContain(API_KEY)

    const tooLong = `${API_KEY}${'x'.repeat(600)}`
    const invalid = await runOperation(ctx, 'organization-llm-credential-create', {
      body: { provider: 'not-a-provider', label: 'Office key', apiKey: tooLong },
    })
    expect(invalid.isError).toBe(true)
    expect(emitted(invalid)).not.toContain(API_KEY)
  })
})
