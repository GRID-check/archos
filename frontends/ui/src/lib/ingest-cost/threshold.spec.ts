/**
 * @vitest-environment node
 */
/**
 * The per-organisation ingest-cost confirmation threshold.
 *
 * What these protect, in order of how expensive the bug would be:
 *   - an organisation with no value of its own gets the deployment default;
 *   - a stored 0 disables the prompt and is NOT read as "no value" (which would
 *     silently restore the default and start asking again);
 *   - a stored value is held to its bounds rather than trusted;
 *   - a write is visible to the next read, not thirty seconds later;
 *   - only platform staff write it, checked before the organisation is probed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const getOrgSettings = vi.fn()
const updatePlatformOwnedOrgSettings = vi.fn()
vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: (...args: unknown[]) => getOrgSettings(...args),
  updatePlatformOwnedOrgSettings: (...args: unknown[]) => updatePlatformOwnedOrgSettings(...args),
}))

const readKnownOrganizationUsage = vi.fn()
vi.mock('@/lib/storage/known-organization', () => ({
  readKnownOrganizationUsage: (...args: unknown[]) => readKnownOrganizationUsage(...args),
}))

const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}))

const requirePlatformPermission = vi.fn()
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/authz/platform')>()
  return { ...original, requirePlatformPermission: (s: unknown) => requirePlatformPermission(s) }
})

import { NotFoundError } from '@/lib/api/errors'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { setCacheStore, type CacheStore } from '@/lib/cache'
import type { GridSession } from '@/lib/auth/types'
import {
  INGEST_COST_THRESHOLD_SETTING,
  configuredIngestCostThreshold,
  effectiveIngestCostThreshold,
  ingestCostThresholdBounds,
  resolveIngestCostThreshold,
  setIngestCostConfirmationThreshold,
} from './threshold'

/** A real store, so the read-through and the invalidation are what is tested. */
const mapStore = (): CacheStore => {
  const entries = new Map<string, string>()
  return {
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => void entries.set(key, value),
    delete: async (key) => void entries.delete(key),
    deletePrefix: async (prefix) => {
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key)
    },
  }
}

const platformSession = (): GridSession => ({
  userId: 'user-1',
  email: 'staff@example.com',
  name: 'Staff',
  accessToken: 'token',
  organizationId: 'org-platform',
  organizationMembershipId: 'om-1',
  role: 'admin',
  permissions: [],
  featureFlags: null,
  profilePictureUrl: null,
})

const withOwnThreshold = (value: unknown): { settings: Record<string, unknown> } => ({
  settings: value === undefined ? {} : { [INGEST_COST_THRESHOLD_SETTING]: value },
})

describe('per-organisation ingest-cost confirmation threshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCacheStore(mapStore())
    getOrgSettings.mockResolvedValue(withOwnThreshold(undefined))
    readKnownOrganizationUsage.mockResolvedValue({
      project: { bytes: 0, documents: 0 },
      archiv: { bytes: 0, documents: 0 },
      total: { bytes: 0, documents: 0 },
    })
    requirePlatformPermission.mockResolvedValue(undefined)
    updatePlatformOwnedOrgSettings.mockResolvedValue(undefined)
    recordAuditEvent.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('bounds', () => {
    it('defaults to 0.50 USD, allows 0 (off), and tops out at 100', () => {
      expect(ingestCostThresholdBounds()).toEqual({ defaultUsd: 0.5, minUsd: 0, maxUsd: 100 })
    })

    it('holds a stored value to the bounds instead of trusting it', () => {
      const bounds = ingestCostThresholdBounds()
      expect(effectiveIngestCostThreshold(null, bounds)).toBe(0.5)
      expect(effectiveIngestCostThreshold(2, bounds)).toBe(2)
      expect(effectiveIngestCostThreshold(200, bounds)).toBe(100)
      expect(effectiveIngestCostThreshold(-5, bounds)).toBe(0)
    })

    it('reads a stored 0 as a decision (off), never as "no value"', () => {
      expect(configuredIngestCostThreshold({ [INGEST_COST_THRESHOLD_SETTING]: 0 })).toBe(0)
    })

    it('reads an absent, null or malformed value as no value of its own', () => {
      expect(configuredIngestCostThreshold({})).toBeNull()
      expect(configuredIngestCostThreshold({ [INGEST_COST_THRESHOLD_SETTING]: null })).toBeNull()
      expect(configuredIngestCostThreshold({ [INGEST_COST_THRESHOLD_SETTING]: '2' })).toBeNull()
      expect(configuredIngestCostThreshold({ [INGEST_COST_THRESHOLD_SETTING]: -1 })).toBeNull()
      expect(configuredIngestCostThreshold({ [INGEST_COST_THRESHOLD_SETTING]: Number.NaN })).toBeNull()
    })
  })

  describe('resolveIngestCostThreshold', () => {
    it('is the deployment default when the organisation has no value of its own', async () => {
      expect(await resolveIngestCostThreshold('org-1')).toBe(0.5)
    })

    it("uses the organisation's own value", async () => {
      getOrgSettings.mockResolvedValue(withOwnThreshold(2))
      expect(await resolveIngestCostThreshold('org-1')).toBe(2)
    })

    it('returns 0 when the organisation switched the prompt off', async () => {
      getOrgSettings.mockResolvedValue(withOwnThreshold(0))
      expect(await resolveIngestCostThreshold('org-1')).toBe(0)
    })

    it('never exceeds its bounds, whatever is stored', async () => {
      getOrgSettings.mockResolvedValue(withOwnThreshold(1_000))
      expect(await resolveIngestCostThreshold('org-1')).toBe(100)
    })

    it('reads an explicit null or a malformed value as the default', async () => {
      getOrgSettings.mockResolvedValue(withOwnThreshold(null))
      expect(await resolveIngestCostThreshold('org-1')).toBe(0.5)
      getOrgSettings.mockResolvedValue(withOwnThreshold('2'))
      expect(await resolveIngestCostThreshold('org-2')).toBe(0.5)
    })

    it('caches per organization, and a write is visible to the next read', async () => {
      getOrgSettings.mockResolvedValue(withOwnThreshold(2))
      expect(await resolveIngestCostThreshold('org-1')).toBe(2)
      expect(await resolveIngestCostThreshold('org-1')).toBe(2)
      expect(getOrgSettings).toHaveBeenCalledTimes(1)

      // Another organization is its own entry, never the first one's answer.
      getOrgSettings.mockResolvedValue(withOwnThreshold(undefined))
      expect(await resolveIngestCostThreshold('org-2')).toBe(0.5)

      getOrgSettings.mockResolvedValue(withOwnThreshold(8))
      await setIngestCostConfirmationThreshold(platformSession(), 'org-1', 8)
      expect(await resolveIngestCostThreshold('org-1')).toBe(8)
    })
  })

  describe('setIngestCostConfirmationThreshold', () => {
    it('stores the value, invalidates, and audits it', async () => {
      const result = await setIngestCostConfirmationThreshold(platformSession(), 'org-1', 2)

      expect(result).toEqual({
        ingestCostConfirmationThresholdUsd: 2,
        effectiveIngestCostConfirmationThresholdUsd: 2,
      })
      expect(updatePlatformOwnedOrgSettings).toHaveBeenCalledWith(platformSession(), 'org-1', {
        settings: { [INGEST_COST_THRESHOLD_SETTING]: 2 },
      })
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'org.ingest_cost_threshold.updated',
          organizationId: 'org-1',
          targetId: 'org-1',
          metadata: { ingestCostConfirmationThresholdUsd: 2 },
        })
      )
    })

    it('clears with null, back to the default, audited as the default it follows', async () => {
      const result = await setIngestCostConfirmationThreshold(platformSession(), 'org-1', null)

      expect(result).toEqual({
        ingestCostConfirmationThresholdUsd: null,
        effectiveIngestCostConfirmationThresholdUsd: 0.5,
      })
      expect(updatePlatformOwnedOrgSettings).toHaveBeenCalledWith(platformSession(), 'org-1', {
        settings: { [INGEST_COST_THRESHOLD_SETTING]: null },
      })
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { ingestCostConfirmationThresholdUsd: 0.5 } })
      )
    })

    it('accepts exactly the two endpoints (0 and 100)', async () => {
      await expect(setIngestCostConfirmationThreshold(platformSession(), 'org-1', 0)).resolves.toEqual({
        ingestCostConfirmationThresholdUsd: 0,
        effectiveIngestCostConfirmationThresholdUsd: 0,
      })
      await expect(setIngestCostConfirmationThreshold(platformSession(), 'org-1', 100)).resolves.toEqual({
        ingestCostConfirmationThresholdUsd: 100,
        effectiveIngestCostConfirmationThresholdUsd: 100,
      })
    })

    it.each([
      ['above the ceiling', 100.01],
      ['below zero', -0.01],
    ])('refuses a value %s with a 422 naming the range', async (_label, usd) => {
      await expect(setIngestCostConfirmationThreshold(platformSession(), 'org-1', usd)).rejects.toMatchObject({
        status: 422,
      })
      expect(updatePlatformOwnedOrgSettings).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    it('refuses an organization Grid has never heard of', async () => {
      readKnownOrganizationUsage.mockRejectedValue(new NotFoundError('Organization not found'))
      await expect(setIngestCostConfirmationThreshold(platformSession(), 'org-typo', 2)).rejects.toMatchObject({
        status: 404,
      })
      expect(updatePlatformOwnedOrgSettings).not.toHaveBeenCalled()
    })

    it('refuses a caller without the platform permission before probing the organization', async () => {
      requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
      await expect(setIngestCostConfirmationThreshold(platformSession(), 'org-typo', 2)).rejects.toMatchObject({
        status: 403,
      })
      expect(readKnownOrganizationUsage).not.toHaveBeenCalled()
      expect(updatePlatformOwnedOrgSettings).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })
  })
})
