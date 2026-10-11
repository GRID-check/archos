/**
 * Feature-flag evaluation on the server: the session's flag set, and the
 * session-less read. Routes each flag by its kind (ADR-0102):
 *
 *   - an ENTITLEMENT asks WorkOS. `listOrganizationFeatureFlags` returns the
 *     flags **enabled** for an organization, so membership of a slug == "on for
 *     this org". Results are cached briefly per org to avoid a WorkOS
 *     round-trip on every WebSocket upgrade. Fail-closed on any error (no API
 *     key, feature not on the plan, network) and for a caller with no
 *     organization: a flag outage never silently grants an entitlement.
 *   - a ROLLOUT asks PostHog, through `lib/analytics/rollout-flags.ts`, and
 *     fails OPEN: on unless PostHog explicitly answers off. A rollout slug that
 *     WorkOS still lists for an organization is ignored.
 *
 * In a deployment that authenticates nobody, both give their fixed per-kind
 * answer instead. The header of `lib/authz/feature-flags.ts` is the argument for
 * all of it.
 */

import { getWorkOS } from './client'
import { getCached, invalidateCached } from '@/lib/cache'
import {
  FEATURE_FLAGS,
  flagsAreLive,
  isEntitlementFlag,
  isRolloutFlag,
  unauthenticatedDefault,
  type KnownFeatureFlag,
} from '@/lib/authz/feature-flags'
import { enabledRollouts, isRolloutEnabled } from '@/lib/analytics/rollout-flags'

const CACHE_TTL_MS = 30_000

async function enabledSlugsForOrg(organizationId: string): Promise<Set<string>> {
  const slugs = await getCached(`flags:${organizationId}`, CACHE_TTL_MS, async () => {
    const list = await getWorkOS().featureFlags.listOrganizationFeatureFlags({ organizationId })
    // EVERY page, not the first. The endpoint defaults to 10 flags and this
    // reader treats "absent from the set" as "off", so a one-page read silently
    // disables whatever sorts past the tenth — which is not a hypothetical: an
    // organization here is served more than ten. `autoPagination` follows the
    // cursor for us, and deliberately gets NO `limit`: the SDK short-circuits to
    // the first page when the first request carried one.
    const flags = await list.autoPagination()
    return flags.map((flag) => flag.slug)
  })
  return new Set(slugs)
}

/**
 * A live session's `featureFlags` (`lib/auth/session.ts`): the entitlements the
 * WorkOS claim carries, plus the rollouts PostHog has not switched off for the
 * organization.
 *
 * Never `null`. A token without the claim (`null`) contributes no entitlements,
 * which keeps the old stale-token answer for them, and changes nothing about
 * rollouts: their answer does not depend on how fresh the token is. A rollout
 * slug in the claim is dropped, so WorkOS cannot switch a rollout on or off
 * once it has moved.
 */
export async function sessionFeatureFlags(
  claim: readonly string[] | null,
  organizationId: string | null | undefined,
): Promise<string[]> {
  const entitlements = (claim ?? []).filter(isEntitlementFlag)
  return [...new Set(entitlements), ...(await enabledRollouts(organizationId))]
}

/**
 * Every flag on for `organizationId`, for a session built without a token
 * (`lib/auth/pinned-session.ts`): the set a live session would carry, with the
 * entitlements read from WorkOS per organization instead of from a claim.
 *
 * A failed WorkOS lookup THROWS rather than answering "none". Its callers are
 * background work acting for a person, and "none" is not a refusal there but a
 * silent wrong answer that sticks; a throw has the job retry once WorkOS is
 * back. Rollouts never throw, they fail open.
 */
export async function enabledFlagsForOrganization(organizationId: string): Promise<string[]> {
  const [entitlements, rollouts] = await Promise.all([
    process.env.WORKOS_API_KEY ? enabledSlugsForOrg(organizationId) : Promise.resolve(new Set<string>()),
    enabledRollouts(organizationId),
  ])
  return [...[...entitlements].filter(isEntitlementFlag), ...rollouts]
}

/**
 * Whether `flag` is enabled for `organizationId`, for a caller without a
 * session. An entitlement is OFF when there is no organization, no WorkOS API
 * key, or the lookup fails; a rollout is ON unless PostHog answers off; and
 * both get their fixed per-kind answer where nobody authenticates.
 */
export async function isOrgFeatureEnabled(
  flag: KnownFeatureFlag,
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!flagsAreLive()) return unauthenticatedDefault(flag)
  if (isRolloutFlag(flag)) return isRolloutEnabled(flag, organizationId)
  if (!organizationId || !process.env.WORKOS_API_KEY) return false
  try {
    return (await enabledSlugsForOrg(organizationId)).has(flag)
  } catch (error) {
    console.warn(`[FeatureFlags] evaluation of "${flag}" failed; treating it as off`, error)
    return false
  }
}

/**
 * One post-answer stage's runtime switch (see
 * `docs/architecture/post-answer-stages.md` §7.8). The `id` mirrors the
 * `StageSpec.id` declared in `src/aiq_agent/stages/`; `flag` mirrors its
 * `flag_slug` (`tests/aiq_agent/stages/test_stage_flag_parity.py`). Keep the
 * two sides in step — a flagged stage the backend declares but this registry
 * omits can never be switched on. A CORE stage (`flag_slug=None`, memory
 * reflection) has no switch and no entry: the backend runs it without asking.
 */
export interface PostAnswerStageFlag {
  readonly id: string
  readonly flag: KnownFeatureFlag
}

export const POST_ANSWER_STAGE_FLAGS: readonly PostAnswerStageFlag[] = [
  {
    // A rollout, and the only thing that produces follow-up questions since the
    // in-answer `follow_ups` CARD was deleted (ADR-0069). Switching its PostHog
    // flag off stops the frames within a turn or two, no deploy and no
    // reconnect; it does not bring the card back.
    id: 'follow_ups',
    flag: 'post-answer-follow-ups',
  },
]

/**
 * The ids of every flagged post-answer stage switched on for this org.
 *
 * Served per TURN (`GET /api/internal/stages`), not per socket upgrade: the
 * upgrade-time evaluation could not reach an already-open tab, so an operator
 * reaching for the kill switch did not actually switch anything off until every
 * reader reconnected. A 30s flag cache sits underneath, so the per-turn cost is
 * a cache read rather than a round-trip.
 */
export async function enabledPostAnswerStages(
  organizationId: string | null | undefined,
): Promise<string[]> {
  const decisions = await Promise.all(
    POST_ANSWER_STAGE_FLAGS.map(async (stage) =>
      (await isOrgFeatureEnabled(stage.flag, organizationId)) ? stage.id : null,
    ),
  )
  return decisions.filter((id): id is string => id !== null)
}

/**
 * Whether deep research is available to this org, resolved WITHOUT a session.
 *
 * The session-bearing half of this decision is `requireFeature(session,
 * FEATURE_FLAGS.deepResearch)` on `POST /api/jobs/async/submit`, which refuses
 * the job. That gate is necessary and was never sufficient: it closes the queue
 * and nothing upstream of it knows the flag, so the agent still escalated, the
 * clarifier still put a plan in front of the reader, and the approval button
 * answered 403. This is what the agent tier reads per turn (`GET
 * /api/internal/stages`) so it can decline to OFFER the run.
 *
 * The same verdict the session gate reaches: OFF for a caller with no
 * organization. That case used to answer ON, on the reasoning that an
 * org-less caller is an anonymous deployment or a break-glass session rather
 * than a tenant with the flag switched off — which made the one entitlement
 * that costs the most the one that failed open. An anonymous deployment gets
 * its answer from `flagsAreLive` instead (deep research is an entitlement,
 * so off), and a break-glass session has no tenant to bill a run to.
 */
export async function isDeepResearchEnabledForOrg(
  organizationId: string | null | undefined,
): Promise<boolean> {
  return isOrgFeatureEnabled(FEATURE_FLAGS.deepResearch, organizationId)
}

/**
 * Whether this org may create delegated tasks and schedules, WITHOUT a session.
 *
 * Same two-halves shape as {@link isDeepResearchEnabledForOrg}, and the same
 * reason for each half: the agent tier reads this per turn so it can decline to
 * OFFER a hand-off, and `POST /api/internal/tasks` re-reads it so a turn that
 * offers one anyway still creates nothing.
 */
export async function isTaskAutomationEnabledForOrg(
  organizationId: string | null | undefined,
): Promise<boolean> {
  return isOrgFeatureEnabled(FEATURE_FLAGS.taskAutomation, organizationId)
}

/** Test hook: clear a specific org's flag cache entry. */
export async function _clearFeatureFlagCache(organizationId?: string): Promise<void> {
  if (organizationId) {
    await invalidateCached(`flags:${organizationId}`)
  }
}
