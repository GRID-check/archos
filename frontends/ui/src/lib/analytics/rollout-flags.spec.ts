/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAllFlags = vi.fn()
let configured = true
vi.mock('./posthog-server', () => ({
  getPosthogServer: () => (configured ? { getAllFlags } : null),
}))

import { ROLLOUT_FLAG_SLUGS } from '@/lib/authz/feature-flags'
import { _clearRolloutFlagCache, enabledRollouts, isRolloutEnabled, rolloutDistinctId } from './rollout-flags'

beforeEach(async () => {
  configured = true
  getAllFlags.mockReset()
  getAllFlags.mockResolvedValue({})
  await _clearRolloutFlagCache('org_1')
  await _clearRolloutFlagCache('org_2')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('what PostHog is asked', () => {
  it('evaluates as the ORGANIZATION, with its id as a person property and no groups', async () => {
    await enabledRollouts('org_1')

    expect(getAllFlags).toHaveBeenCalledTimes(1)
    const [distinctId, options] = getAllFlags.mock.calls[0] as [string, Record<string, unknown>]
    expect(distinctId).toBe('org:org_1')
    expect(rolloutDistinctId('org_1')).toBe('org:org_1')
    expect(options.personProperties).toEqual({ organization_id: 'org_1' })
    expect(options).not.toHaveProperty('groups')
  })

  it('asks only about the rollout keys', async () => {
    await enabledRollouts('org_1')

    const options = getAllFlags.mock.calls[0]?.[1] as { flagKeys: string[] }
    expect([...options.flagKeys].sort()).toEqual([...ROLLOUT_FLAG_SLUGS].sort())
    expect(options.flagKeys).not.toContain('deep-research')
  })
})

describe('fail open', () => {
  it('turns every rollout on while PostHog is not configured, and asks nothing', async () => {
    configured = false

    await expect(enabledRollouts('org_1')).resolves.toEqual([...ROLLOUT_FLAG_SLUGS])
    expect(getAllFlags).not.toHaveBeenCalled()
  })

  it('keeps a rollout on when its flag does not exist in PostHog', async () => {
    getAllFlags.mockResolvedValue({ 'some-other-flag': false })

    await expect(isRolloutEnabled('ifc-models', 'org_1')).resolves.toBe(true)
  })

  it('keeps every rollout on, and warns, when evaluation throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getAllFlags.mockRejectedValue(new Error('network'))

    await expect(enabledRollouts('org_1')).resolves.toEqual([...ROLLOUT_FLAG_SLUGS])
    expect(warn).toHaveBeenCalled()
  })

  it('turns every rollout on for a caller with no organization, without asking', async () => {
    await expect(enabledRollouts(null)).resolves.toEqual([...ROLLOUT_FLAG_SLUGS])
    await expect(isRolloutEnabled('web-search', undefined)).resolves.toBe(true)
    expect(getAllFlags).not.toHaveBeenCalled()
  })
})

describe('an explicit answer', () => {
  it('honours an explicit off, for that rollout only', async () => {
    getAllFlags.mockResolvedValue({ 'web-search': false, 'image-upload': true })

    await expect(isRolloutEnabled('web-search', 'org_1')).resolves.toBe(false)
    await expect(isRolloutEnabled('image-upload', 'org_1')).resolves.toBe(true)
    await expect(isRolloutEnabled('ifc-models', 'org_1')).resolves.toBe(true)
  })

  it('reads a multivariate answer as on: only `false` withdraws', async () => {
    getAllFlags.mockResolvedValue({ 'web-search': 'control' })

    await expect(isRolloutEnabled('web-search', 'org_1')).resolves.toBe(true)
  })
})

describe('the cache', () => {
  it('asks PostHog once per organization within the TTL', async () => {
    getAllFlags.mockResolvedValue({ 'web-search': false })

    await isRolloutEnabled('web-search', 'org_1')
    await isRolloutEnabled('image-upload', 'org_1')
    await enabledRollouts('org_1')

    expect(getAllFlags).toHaveBeenCalledTimes(1)
  })

  it('keeps one organization’s answer from another', async () => {
    getAllFlags.mockImplementation(async (distinctId: string) =>
      distinctId === 'org:org_1' ? { 'web-search': false } : {},
    )

    await expect(isRolloutEnabled('web-search', 'org_1')).resolves.toBe(false)
    await expect(isRolloutEnabled('web-search', 'org_2')).resolves.toBe(true)
    expect(getAllFlags).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure: the next read asks again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getAllFlags.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ 'web-search': false })

    await expect(isRolloutEnabled('web-search', 'org_1')).resolves.toBe(true)
    await expect(isRolloutEnabled('web-search', 'org_1')).resolves.toBe(false)
  })
})
