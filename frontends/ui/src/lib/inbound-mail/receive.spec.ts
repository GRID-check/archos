/**
 * @vitest-environment node
 */
/**
 * The webhook's limits (step 7): charged narrowest first, address, then
 * organization, then signing key, so a refusal never spends a wider bucket and
 * one flooded address cannot use up its office's or every office's budget.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/limits/enforce', () => ({ enforceLimit: vi.fn(async () => undefined) }))
vi.mock('@/lib/workos/feature-flags', () => ({ enabledFlagsForOrganization: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({ withPlatformAccess: vi.fn(), withTenant: vi.fn() }))
vi.mock('./repository', () => ({
  completeReception: vi.fn(),
  findActiveAddressByToken: vi.fn(),
  findMailIdByDeliveryKey: vi.fn(),
  forgetReceptionObject: vi.fn(),
  insertReception: vi.fn(),
  stagedBytes: vi.fn(async () => ({ address: 0, organization: 0 })),
}))
vi.mock('./staging', () => ({ eraseStagedObjects: vi.fn(), putRawMessage: vi.fn(), stagingBucketFor: vi.fn() }))

import type { VerifiedSignature } from '@/lib/internal-auth'
import { enforceLimit } from '@/lib/limits/enforce'
import {
  INBOUND_MAIL_ADDRESS_LIMIT,
  INBOUND_MAIL_ORGANIZATION_LIMIT,
  INBOUND_MAIL_SIGNING_KEY_LIMIT,
} from '@/lib/limits/catalog'
import { enforceInboundLimits } from './receive'
import type { ResolvedInboundAddress } from './repository'

const signature = { keyId: 'worker-1' } as VerifiedSignature
const address = { organizationId: 'org_1', addressId: 'addr-1' } as ResolvedInboundAddress

beforeEach(() => vi.clearAllMocks())

describe('the inbound limits', () => {
  it('are charged address, then organization, then signing key', async () => {
    await enforceInboundLimits(signature, address, 1_000)
    expect(vi.mocked(enforceLimit).mock.calls.map(([rule, subject]) => [rule.name, subject])).toEqual([
      [INBOUND_MAIL_ADDRESS_LIMIT.name, 'org_1:addr-1'],
      [INBOUND_MAIL_ORGANIZATION_LIMIT.name, 'org_1'],
      [INBOUND_MAIL_SIGNING_KEY_LIMIT.name, 'keyid:worker-1'],
    ])
  })

  it('spend no wider bucket when the address refuses', async () => {
    vi.mocked(enforceLimit).mockImplementation(async (rule) => {
      if (rule.name === INBOUND_MAIL_ADDRESS_LIMIT.name) throw new Error('429')
    })
    await expect(enforceInboundLimits(signature, address, 1_000)).rejects.toThrow('429')
    expect(vi.mocked(enforceLimit).mock.calls.map(([rule]) => rule.name)).toEqual([INBOUND_MAIL_ADDRESS_LIMIT.name])
  })
})
