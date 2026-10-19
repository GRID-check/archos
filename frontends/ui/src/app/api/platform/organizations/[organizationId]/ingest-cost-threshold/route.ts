/**
 * Platform-owner control of one organisation's ingest-cost confirmation
 * threshold.
 *
 * A sibling of `../upload-limit` rather than a second field on another PUT, for
 * the same reason that route is a sibling of `../storage`: one setting, one
 * contract, one audit action and one refusal. `null` means "back to the
 * deployment default"; `0` is a decision ("never ask"), and folding the two into
 * one nullable field would give `null` two meanings.
 *
 * The read lives with the primitive it governs
 * (`GET /api/documents/{id}/ingest-cost` returns the threshold in force beside
 * the estimate), so this route has no GET of its own.
 *
 * `platformApiRoute` checks `platform:organizations:manage` before the handler;
 * `setIngestCostConfirmationThreshold` checks again, because it writes a
 * platform-owned setting and an audit row whichever route calls it.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { ingestCostThresholdPutSchema } from '@/lib/ingest-cost/contract'
import { setIngestCostConfirmationThreshold } from '@/lib/ingest-cost/threshold'

interface Params {
  organizationId: string
}

/** Set (USD) or clear (`null`) the threshold. Out of range is a 400; an unknown organisation a 404. */
export const PUT = platformApiRoute<Params>(
  async ({ session, request, params }) => {
    const { ingestCostConfirmationThresholdUsd } = await parseJsonBody(request, ingestCostThresholdPutSchema)
    return setIngestCostConfirmationThreshold(
      session,
      params.organizationId,
      ingestCostConfirmationThresholdUsd,
      request
    )
  },
  { permission: PLATFORM_PERMISSIONS.organizationsManage }
)
