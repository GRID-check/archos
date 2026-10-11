/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listOrganizationFeatureFlags = vi.fn()

/**
 * The SDK returns an `AutoPaginatable`, not a plain list: `data` is the FIRST
 * page (10 flags by default) and `autoPagination()` follows the cursor. The
 * double mirrors both, so a reader that only maps `data` fails here instead of
 * in production, where it silently reports every flag past the tenth as off.
 */
function paginated(...pages: { slug: string }[][]) {
  return {
    data: pages[0] ?? [],
    autoPagination: async () => pages.flat(),
  }
}

vi.mock('./client', () => ({
  getWorkOS: () => ({ featureFlags: { listOrganizationFeatureFlags } }),
}))

// PostHog, one level down: the real rollout module runs, against this client.
const getAllFlags = vi.fn()
let posthogConfigured = true
vi.mock('@/lib/analytics/posthog-server', () => ({
  getPosthogServer: () => (posthogConfigured ? { getAllFlags } : null),
}))

import { FEATURE_FLAGS, ROLLOUT_FLAG_SLUGS } from '@/lib/authz/feature-flags'
import { _clearRolloutFlagCache } from '@/lib/analytics/rollout-flags'
import {
  _clearFeatureFlagCache,
  enabledFlagsForOrganization,
  enabledPostAnswerStages,
  isDeepResearchEnabledForOrg,
  isOrgFeatureEnabled,
  isTaskAutomationEnabledForOrg,
  POST_ANSWER_STAGE_FLAGS,
  sessionFeatureFlags,
} from './feature-flags'

const SKILLS = FEATURE_FLAGS.skills
const FOLLOW_UPS = FEATURE_FLAGS.postAnswerFollowUps

beforeEach(async () => {
  // Where people sign in — every deployed stack. The anonymous deployment is
  // its own describe block below.
  vi.stubEnv('REQUIRE_AUTH', 'true')
  vi.stubEnv('WORKOS_API_KEY', 'sk_test')
  await _clearFeatureFlagCache('org-1')
  await _clearRolloutFlagCache('org-1')
  listOrganizationFeatureFlags.mockReset()
  getAllFlags.mockReset()
  getAllFlags.mockResolvedValue({})
  posthogConfigured = true
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isOrgFeatureEnabled: an entitlement asks WorkOS', () => {
  it('is true when the slug is among the org’s enabled flags', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: SKILLS }, { slug: 'other' }]))
    await expect(isOrgFeatureEnabled(SKILLS, 'org-1')).resolves.toBe(true)
    expect(listOrganizationFeatureFlags).toHaveBeenCalledWith({ organizationId: 'org-1' })
    expect(getAllFlags).not.toHaveBeenCalled()
  })

  it('reads past the first page, because the endpoint returns ten at a time', async () => {
    // The defect: `data` alone is one page. Production serves an organization
    // more than ten flags, and a reader that stops at the first page reports
    // whatever sorts after it as OFF — silently, and per organization.
    listOrganizationFeatureFlags.mockResolvedValue(
      paginated(Array.from({ length: 10 }, (_, i) => ({ slug: `filler-${i}` })), [{ slug: SKILLS }]),
    )

    await expect(isOrgFeatureEnabled(SKILLS, 'org-1')).resolves.toBe(true)
  })

  it('asks for no explicit limit, or the SDK short-circuits to one page', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: SKILLS }]))

    await isOrgFeatureEnabled(SKILLS, 'org-1')

    expect(listOrganizationFeatureFlags).toHaveBeenCalledWith({ organizationId: 'org-1' })
  })

  it('is false when the slug is not enabled for the org', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: 'other' }]))
    await expect(isOrgFeatureEnabled(SKILLS, 'org-1')).resolves.toBe(false)
  })

  it('is false when there is no org', async () => {
    await expect(isOrgFeatureEnabled(SKILLS, null)).resolves.toBe(false)
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.deepResearch, undefined)).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('is false when there is no WorkOS API key', async () => {
    vi.stubEnv('WORKOS_API_KEY', '')
    await expect(isOrgFeatureEnabled(SKILLS, 'org-1')).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('fails closed when evaluation throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    listOrganizationFeatureFlags.mockRejectedValue(new Error('feature not on plan'))
    await expect(isOrgFeatureEnabled(SKILLS, 'org-1')).resolves.toBe(false)
  })

  it('caches per org (no second WorkOS call within the TTL)', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: SKILLS }]))
    await isOrgFeatureEnabled(SKILLS, 'org-1')
    await isOrgFeatureEnabled(SKILLS, 'org-1')
    expect(listOrganizationFeatureFlags).toHaveBeenCalledTimes(1)
  })

  it('is never answered by PostHog, whatever PostHog says', async () => {
    getAllFlags.mockResolvedValue({ [SKILLS]: true })
    listOrganizationFeatureFlags.mockResolvedValue(paginated([]))
    await expect(isOrgFeatureEnabled(SKILLS, 'org-1')).resolves.toBe(false)
    expect(getAllFlags).not.toHaveBeenCalled()
  })
})

describe('isOrgFeatureEnabled: a rollout asks PostHog, and fails open', () => {
  it('is off when PostHog answers off for the organization', async () => {
    getAllFlags.mockResolvedValue({ 'ifc-models': false })
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.ifcModels, 'org-1')).resolves.toBe(false)
    expect(getAllFlags).toHaveBeenCalledWith('org:org-1', expect.objectContaining({ personProperties: { organization_id: 'org-1' } }))
  })

  it('is on when PostHog does not know the flag, with WorkOS never asked', async () => {
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.ifcModels, 'org-1')).resolves.toBe(true)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('ignores WorkOS for a rollout: a slug WorkOS no longer lists stays on', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([]))
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.webSearch, 'org-1')).resolves.toBe(true)
  })

  it('is on for a caller with no organization, and on without PostHog', async () => {
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.imageUpload, null)).resolves.toBe(true)
    posthogConfigured = false
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.imageUpload, 'org-1')).resolves.toBe(true)
  })
})

describe('sessionFeatureFlags: what a live session carries', () => {
  it('takes the entitlements from the claim and the rollouts from PostHog', async () => {
    getAllFlags.mockResolvedValue({ 'image-upload': false })
    const flags = await sessionFeatureFlags([SKILLS, FEATURE_FLAGS.deepResearch], 'org-1')

    expect(flags).toEqual(expect.arrayContaining([SKILLS, FEATURE_FLAGS.deepResearch, FEATURE_FLAGS.webSearch]))
    expect(flags).not.toContain(FEATURE_FLAGS.imageUpload)
  })

  it('ignores a rollout the WorkOS claim still carries: PostHog switched it off', async () => {
    getAllFlags.mockResolvedValue({ 'ifc-models': false })
    const flags = await sessionFeatureFlags([FEATURE_FLAGS.ifcModels, SKILLS], 'org-1')

    expect(flags).not.toContain(FEATURE_FLAGS.ifcModels)
    expect(flags).toContain(SKILLS)
  })

  it('drops a slug the registry does not know, and the retired memory-reflection flag', async () => {
    const flags = await sessionFeatureFlags(['memory-reflection', 'something-else', SKILLS], 'org-1')
    expect(flags).not.toContain('memory-reflection')
    expect(flags).not.toContain('something-else')
  })

  it('keeps a stale token’s answer for entitlements and leaves rollouts alone', async () => {
    const flags = await sessionFeatureFlags(null, 'org-1')

    expect(flags).toEqual([...ROLLOUT_FLAG_SLUGS])
  })
})

describe('enabledFlagsForOrganization: a pinned session’s set', () => {
  it('is WorkOS’s entitlements plus PostHog’s rollouts, and no rollout from WorkOS', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: SKILLS }, { slug: 'web-search' }]))
    getAllFlags.mockResolvedValue({ 'web-search': false })

    const flags = await enabledFlagsForOrganization('org-1')

    expect(flags).toContain(SKILLS)
    expect(flags).not.toContain('web-search')
    expect(flags).toContain(FEATURE_FLAGS.imageUpload)
  })

  it('throws when WorkOS fails, so background work retries instead of acting on "none"', async () => {
    listOrganizationFeatureFlags.mockRejectedValue(new Error('down'))
    await expect(enabledFlagsForOrganization('org-1')).rejects.toThrow('down')
  })

  it('carries the rollouts without a WorkOS key', async () => {
    vi.stubEnv('WORKOS_API_KEY', '')
    await expect(enabledFlagsForOrganization('org-1')).resolves.toEqual([...ROLLOUT_FLAG_SLUGS])
  })
})

describe('a deployment that authenticates nobody (REQUIRE_AUTH not true)', () => {
  beforeEach(() => {
    vi.stubEnv('REQUIRE_AUTH', 'false')
  })

  it('serves every rollout, with or without an organization, and asks nobody', async () => {
    await expect(isOrgFeatureEnabled(FOLLOW_UPS, 'org-1')).resolves.toBe(true)
    await expect(enabledPostAnswerStages(undefined)).resolves.toEqual(['follow_ups'])
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
    expect(getAllFlags).not.toHaveBeenCalled()
  })

  it('withholds every entitlement — deep research and tasks included', async () => {
    await expect(isDeepResearchEnabledForOrg(undefined)).resolves.toBe(false)
    await expect(isTaskAutomationEnabledForOrg('org-1')).resolves.toBe(false)
    await expect(isOrgFeatureEnabled(FEATURE_FLAGS.skills, 'org-1')).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('ignores a WorkOS key that happens to be configured', async () => {
    // A key set for Vault or the audit log does not make an anonymous stack a
    // tenant one: there is still nobody signed in to hold an entitlement.
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: FEATURE_FLAGS.deepResearch }]))
    await expect(isDeepResearchEnabledForOrg('org-1')).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })
})

describe('the capabilities the agent reads per turn', () => {
  it('deep research is OFF for a caller with no organization — it used to fail open', async () => {
    await expect(isDeepResearchEnabledForOrg(undefined)).resolves.toBe(false)
    await expect(isDeepResearchEnabledForOrg(null)).resolves.toBe(false)
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })

  it('tasks are OFF for a caller with no organization, the same way', async () => {
    await expect(isTaskAutomationEnabledForOrg(undefined)).resolves.toBe(false)
  })

  it('both follow the organization’s flag', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([{ slug: FEATURE_FLAGS.deepResearch }]))
    await expect(isDeepResearchEnabledForOrg('org-1')).resolves.toBe(true)
    await expect(isTaskAutomationEnabledForOrg('org-1')).resolves.toBe(false)
  })
})

describe('enabledPostAnswerStages', () => {
  it('mirrors the backend’s flagged stage ids; memory reflection is core and absent', () => {
    // A flagged stage the backend declares but this registry omits can never be
    // switched on, so the ids have to be the StageSpec ids verbatim.
    expect(POST_ANSWER_STAGE_FLAGS.map((stage) => stage.id)).toEqual(['follow_ups'])
  })

  it('lists the follow-up stage while PostHog has not switched it off', async () => {
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual(['follow_ups'])
  })

  it('omits it when PostHog answers off — the kill switch, per turn', async () => {
    getAllFlags.mockResolvedValue({ [FOLLOW_UPS]: false })
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual([])
  })

  it('keeps it when PostHog fails, rather than withdraw a shipped feature', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getAllFlags.mockRejectedValue(new Error('PostHog down'))
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual(['follow_ups'])
  })

  it('is not decided by a WorkOS flag any more', async () => {
    listOrganizationFeatureFlags.mockResolvedValue(paginated([]))
    await expect(enabledPostAnswerStages('org-1')).resolves.toEqual(['follow_ups'])
    expect(listOrganizationFeatureFlags).not.toHaveBeenCalled()
  })
})
