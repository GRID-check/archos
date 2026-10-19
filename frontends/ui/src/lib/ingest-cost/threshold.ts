/**
 * The per-organisation ingest-cost confirmation threshold, resolved in one place.
 *
 * ## The precedent, and why
 *
 * Shaped exactly like `@/lib/storage/upload-limit`: the organisation's own value
 * lives in the `organizations.settings` bag as one nullable scalar
 * ({@link INGEST_COST_THRESHOLD_SETTING}), the deployment default is a
 * {@link DEFAULT_INGEST_COST_THRESHOLD_USD} constant beside it, a stored value is
 * held to its bounds rather than trusted, and the value is read through a short
 * TTL cache that its one writer invalidates. The reason to mirror that module
 * rather than invent a shape is that this is the SAME kind of setting: the tenant
 * is the party the value CONSTRAINS.
 *
 * ## Why it is platform-owned
 *
 * It is listed in `PLATFORM_OWNED_SETTINGS`. A tenant that could raise its own
 * threshold would simply not be prompted — the exact reason `storageQuotaBytes`
 * and `maxUploadFileBytes` are platform-owned. So only platform staff write it,
 * through {@link setIngestCostConfirmationThreshold}, and the tenant-facing
 * settings merge refuses the key.
 *
 * ## Which number is cached
 *
 * The cache holds the STORED value, not the effective one, and the bounds are
 * applied on read: the default is this build's constant, so a replica serving a
 * newer default must apply its own rather than the one another replica cached.
 */

import 'server-only'
import { UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { GridSession } from '@/lib/auth/types'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { requirePlatformPermission } from '@/lib/authz/platform'
import { getCached, invalidateCached } from '@/lib/cache'
import { getOrgSettings, updatePlatformOwnedOrgSettings } from '@/lib/organizations/service'
import { readKnownOrganizationUsage } from '@/lib/storage/known-organization'
import {
  DEFAULT_INGEST_COST_THRESHOLD_USD,
  INGEST_COST_THRESHOLD_SETTING,
  MAX_INGEST_COST_THRESHOLD_USD,
  MIN_INGEST_COST_THRESHOLD_USD,
  ingestCostThresholdPutSchema,
} from './contract'

export { INGEST_COST_THRESHOLD_SETTING }

/** What a per-organisation threshold may be, for this deployment. */
export interface IngestCostThresholdBounds {
  /** The threshold an organisation without its own value gets. */
  defaultUsd: number
  /** The smallest value platform staff may set. 0 switches the confirmation off. */
  minUsd: number
  /** The largest, so a mistyped extra digit is refused rather than stored. */
  maxUsd: number
}

export function ingestCostThresholdBounds(): IngestCostThresholdBounds {
  return {
    defaultUsd: DEFAULT_INGEST_COST_THRESHOLD_USD,
    minUsd: MIN_INGEST_COST_THRESHOLD_USD,
    maxUsd: MAX_INGEST_COST_THRESHOLD_USD,
  }
}

/**
 * The organisation's own value from a settings bag already read, or null when it
 * has none (or has one that does not read as a non-negative finite number).
 *
 * `0` is a legal stored value and is returned as such: it switches the
 * confirmation off, and reading it as "no value" would silently restore the
 * default and start asking again.
 */
export function configuredIngestCostThreshold(settings: Record<string, unknown>): number | null {
  const value = settings[INGEST_COST_THRESHOLD_SETTING]
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_INGEST_COST_THRESHOLD_USD
    ? value
    : null
}

/** The threshold in force: the organisation's own value held to the bounds, else the default. */
export function effectiveIngestCostThreshold(
  configured: number | null,
  bounds: IngestCostThresholdBounds
): number {
  if (configured === null) return bounds.defaultUsd
  return Math.min(Math.max(configured, bounds.minUsd), bounds.maxUsd)
}

const INGEST_COST_THRESHOLD_CACHE_TTL_MS = 30_000
const ingestCostThresholdCacheKey = (organizationId: string): string =>
  `ingestcostthreshold:${organizationId}`

/**
 * The confirmation threshold in force for an organisation, in USD. The one read
 * every caller goes through, including the document read that answers "should
 * this upload be confirmed?".
 */
export async function resolveIngestCostThreshold(organizationId: string): Promise<number> {
  const configured = await getCached(
    ingestCostThresholdCacheKey(organizationId),
    INGEST_COST_THRESHOLD_CACHE_TTL_MS,
    async () => configuredIngestCostThreshold((await getOrgSettings(organizationId)).settings)
  )
  return effectiveIngestCostThreshold(configured, ingestCostThresholdBounds())
}

export interface IngestCostThresholdState {
  /** The organisation's own value, or null when it follows the deployment default. */
  ingestCostConfirmationThresholdUsd: number | null
  /** The threshold in force. */
  effectiveIngestCostConfirmationThresholdUsd: number
}

/**
 * Set (or clear, with null) an organisation's ingest-cost confirmation threshold.
 * PLATFORM ONLY.
 *
 * Shaped like `setMaxUploadFileBytes`: the permission is checked here, first, so
 * the function is safe whatever calls it; an unknown organisation is refused
 * rather than given a settings row; the write goes through the platform-tier
 * merge that `updateOrgSettings` refuses to tenants.
 *
 * The bounds are re-checked here (a 422) though the route's schema already
 * refuses them (a 400): the invariant belongs to the service, and the route is
 * not its only caller.
 */
export async function setIngestCostConfirmationThreshold(
  session: GridSession,
  organizationId: string,
  ingestCostConfirmationThresholdUsd: number | null,
  request?: Request
): Promise<IngestCostThresholdState> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsManage)
  // The organization's usage is discarded; this is the repo's one "is this a
  // known organization" oracle, and reusing it keeps one answer rather than a
  // second guess about which ids exist.
  await readKnownOrganizationUsage(organizationId)

  const bounds = ingestCostThresholdBounds()
  if (
    ingestCostConfirmationThresholdUsd !== null &&
    !ingestCostThresholdPutSchema.safeParse({ ingestCostConfirmationThresholdUsd }).success
  ) {
    throw new UnprocessableError(
      `The threshold must be between ${bounds.minUsd} and ${bounds.maxUsd} USD, ` +
        `or null to follow the default of ${bounds.defaultUsd} USD`,
      { ...bounds, requestedUsd: ingestCostConfirmationThresholdUsd }
    )
  }

  await updatePlatformOwnedOrgSettings(session, organizationId, {
    settings: { [INGEST_COST_THRESHOLD_SETTING]: ingestCostConfirmationThresholdUsd },
  })
  await invalidateCached(ingestCostThresholdCacheKey(organizationId))

  await recordAuditEvent({
    organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.ingest_cost_threshold.updated',
    targetType: 'organization',
    targetId: organizationId,
    // A cleared value is recorded as the default it follows, so the trail says
    // which number was in force rather than only that the key was removed.
    metadata: { ingestCostConfirmationThresholdUsd: ingestCostConfirmationThresholdUsd ?? bounds.defaultUsd },
    request,
  })

  return {
    ingestCostConfirmationThresholdUsd,
    effectiveIngestCostConfirmationThresholdUsd: effectiveIngestCostThreshold(
      ingestCostConfirmationThresholdUsd,
      bounds
    ),
  }
}
