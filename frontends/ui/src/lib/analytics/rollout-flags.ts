/**
 * Rollout switches, evaluated by PostHog per organization (ADR-0102).
 *
 * A rollout (`FLAG_KINDS` in `lib/authz/feature-flags.ts`) is a feature shipped
 * to everybody, and its flag is a kill switch. This module is the one place
 * that asks PostHog about one. Entitlements never come here: they are
 * authorization, they stay in WorkOS, and PostHog flags are never
 * authorization (ADR-0100).
 *
 * ## Fail open, unlike an entitlement
 *
 * A rollout is ON unless PostHog explicitly answers `false` for it. ON when
 * PostHog is not configured (`getPosthogServer()` is null), when the flag does
 * not exist in PostHog, when the organization is unknown, and when evaluation
 * throws (logged). posthog-node itself reports an unreachable PostHog, a
 * timeout or a spent flag quota as "no flags", which reads as ON by the same
 * rule. The flag exists so an operator can withdraw a feature in a hurry; an
 * outage of the analytics vendor must not withdraw it for everybody.
 *
 * One consequence an operator must know: remote evaluation OMITS a flag that
 * is switched off as a whole (its "Enabled" toggle), and an omitted flag is ON
 * here. Withdraw a rollout by its release condition (0 %, or a condition on
 * `organization_id`), never by disabling the flag. Local evaluation does
 * resolve a disabled flag to `false`, so the toggle works there, but a
 * deployment without the secure key must not be the one where it does not.
 *
 * ## Per organization, not per person
 *
 * An office sees one product: two colleagues must not get two answers. The
 * distinct id is therefore the organization's, `org:<organizationId>`, and
 * `organization_id` is passed as a person property so a release condition can
 * target an office. PostHog's group analytics would express this natively and
 * is a paid add-on, so no groups. Nothing is captured: `getAllFlags`, unlike
 * `evaluateFlags(...).isEnabled`, sends no `$feature_flag_called` event, and the
 * property travels as an evaluation override that PostHog does not store on a
 * person. The synthetic id never becomes a person through this module.
 *
 * ## Local evaluation when the secure key is set
 *
 * With `POSTHOG_FEATURE_FLAGS_SECURE_API_KEY` the shared client polls flag
 * definitions every 30 s and evaluates here, without a request per
 * organization (`posthog-server.ts`). Without it every cache miss is one
 * `/flags` request. Either way the answer is cached per organization for 30 s
 * in the shared cache, so a page render, the per-turn stage read and the
 * WebSocket upgrade ask PostHog once between them.
 */
import 'server-only'

import { getCached, invalidateCached } from '@/lib/cache'
import { ROLLOUT_FLAG_SLUGS, type RolloutFlag } from '@/lib/authz/feature-flags'

import { getPosthogServer } from './posthog-server'

const CACHE_TTL_MS = 30_000

/** The cache key of one organization's answer. Carries the organization by rule. */
const rolloutCacheKey = (organizationId: string): string => `rolloutflags:${organizationId}`

/** The PostHog distinct id an organization's rollouts are evaluated as. */
export const rolloutDistinctId = (organizationId: string): string => `org:${organizationId}`

/**
 * The rollouts PostHog explicitly switched off for this organization. Cached as
 * the off-list, a plain array (the shared cache round-trips JSON), so the
 * fail-open default is what an empty or missing answer means.
 */
async function rolloutsSwitchedOff(organizationId: string): Promise<string[]> {
  const posthog = getPosthogServer()
  if (!posthog) return []
  try {
    return await getCached(rolloutCacheKey(organizationId), CACHE_TTL_MS, async () => {
      const answers = await posthog.getAllFlags(rolloutDistinctId(organizationId), {
        personProperties: { organization_id: organizationId },
        flagKeys: [...ROLLOUT_FLAG_SLUGS],
      })
      return ROLLOUT_FLAG_SLUGS.filter((slug) => answers[slug] === false)
    })
  } catch (error) {
    console.warn('[RolloutFlags] PostHog evaluation failed; every rollout stays on', error)
    return []
  }
}

/**
 * Every rollout that is on for `organizationId`: all of them, minus what
 * PostHog switched off. With no organization there is nothing to ask, and a
 * rollout is shipped to everybody, so all of them.
 */
export async function enabledRollouts(organizationId: string | null | undefined): Promise<RolloutFlag[]> {
  if (!organizationId) return [...ROLLOUT_FLAG_SLUGS]
  const off = new Set(await rolloutsSwitchedOff(organizationId))
  return ROLLOUT_FLAG_SLUGS.filter((slug) => !off.has(slug))
}

/** Whether one rollout is on for `organizationId`. See the module header. */
export async function isRolloutEnabled(
  flag: RolloutFlag,
  organizationId: string | null | undefined,
): Promise<boolean> {
  return (await enabledRollouts(organizationId)).includes(flag)
}

/** Test hook: forget one organization's cached answer. */
export async function _clearRolloutFlagCache(organizationId: string): Promise<void> {
  await invalidateCached(rolloutCacheKey(organizationId))
}
