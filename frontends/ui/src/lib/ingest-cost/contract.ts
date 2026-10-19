/**
 * The ingest-cost confirmation threshold: the number, the values it may take, and
 * the one rule that turns it into a question.
 *
 * ## What the threshold is for
 *
 * A large PDF costs real money to ingest — one vision call per embedded raster,
 * one transcription call per scanned page — and nobody is asked before it is
 * spent. The ingest job's cheap pre-read measures the file *before* the first
 * model call (``aiq_agent.knowledge.ingest_cost_estimate``) and reports what it
 * expects that file to cost. This module holds the one policy number that decides
 * whether that expectation is worth a person's attention: costs ABOVE it are
 * confirmed, costs at or below it are not.
 *
 * ## Why the default is 0.50 USD
 *
 * Fitted from the estimator's own calibration (259 production PDFs, 9.38 USD of
 * ingest spend). Per-document terms:
 *
 * - one vision call ≈ 0.008439 USD (81% of the bill),
 * - one transcription call ≈ 0.017218 USD (12.7%),
 * - one page of vectors ≈ 0.000127 USD (5.5%),
 * - a per-document constant ≈ 0.000228 USD (0.7%).
 *
 * 0.50 USD is therefore reached by ~59 vision calls (close to the extractor's
 * own `MAX_IMAGES_PER_DOCUMENT` of 64) or by ~30 recorded transcription calls —
 * against a sample mean of 3.5 vision calls per document. It is a bar for the
 * genuinely expensive upload, not for an ordinary one: the mean document costs
 * 0.036 USD, so a threshold at the mean would ask about half of every day's
 * uploads. The expected prompt rate is the tail beyond ~17× the mean call count,
 * on the order of a couple of percent of uploads; the calibration ledger does not
 * record the exact percentile, so that rate is an estimate, not a measurement.
 *
 * ## Zero means off
 *
 * `MIN_INGEST_COST_THRESHOLD_USD` is 0, and a stored 0 switches the prompt OFF
 * rather than asking about every positive cost. An office that does not want the
 * step says so with a number, not by an absent field — the same distinction
 * `uploadScreeningPolicy.enabled` makes for the upload screen.
 *
 * Client-safe by construction: no `server-only`, no db. The dialog, the route and
 * the resolution module read this one file.
 */

import { z } from 'zod'

/** Key under `organizations.settings` holding the organisation's own threshold, in USD. */
export const INGEST_COST_THRESHOLD_SETTING = 'ingestCostConfirmationThresholdUsd'

/**
 * The threshold an organisation without its own value gets, in USD.
 * See the module header for the arithmetic behind it.
 */
export const DEFAULT_INGEST_COST_THRESHOLD_USD = 0.5

/** The smallest value platform staff may set. 0 switches the confirmation off. */
export const MIN_INGEST_COST_THRESHOLD_USD = 0

/**
 * The largest threshold platform staff may set, in USD.
 *
 * Not a product limit: the estimator cannot produce a figure anywhere near it.
 * Its ceiling today is a 500-page scan (500 × 0.017218 ≈ 8.6 USD) or a raster at
 * every one of the 64 image slots (64 × 0.008439 ≈ 0.54 USD), so 100 USD is far
 * clear of any real ingest while a mistyped extra digit is still a 400.
 */
export const MAX_INGEST_COST_THRESHOLD_USD = 100

/**
 * The PUT body for a platform threshold write.
 *
 * `null` clears the organisation's own value, so it follows the deployment
 * default again — kept distinct from `0`, which is a decision ("never ask"),
 * exactly as `uploadLimitPutSchema` keeps "back to the default" distinct from a
 * value. Nullable rather than optional for the same reason: clearing is a
 * decision, and an absent field is a malformed request.
 */
export const ingestCostThresholdPutSchema = z.object({
  ingestCostConfirmationThresholdUsd: z
    .number()
    .min(MIN_INGEST_COST_THRESHOLD_USD)
    .max(MAX_INGEST_COST_THRESHOLD_USD)
    .nullable(),
})

export type IngestCostThresholdPut = z.infer<typeof ingestCostThresholdPutSchema>

/**
 * Whether an expected ingest cost is worth asking a person about.
 *
 * The threshold is exclusive: a cost exactly AT it is the largest an office
 * accepted without being asked, so a cost over it — and only over it — asks.
 *
 * `null` never asks. A number the pre-read could not produce is not a cheap
 * ingest, and asking "this may cost something, continue?" trains people to click
 * through the dialog that exists to be read. A threshold of 0 or less never asks
 * either: that is the stored value that switches the step off (see the module
 * header).
 */
export function shouldConfirmIngest(
  expectedUsd: number | null | undefined,
  thresholdUsd: number
): boolean {
  if (expectedUsd === null || expectedUsd === undefined) return false
  if (!Number.isFinite(expectedUsd) || expectedUsd <= 0) return false
  if (!Number.isFinite(thresholdUsd) || thresholdUsd <= MIN_INGEST_COST_THRESHOLD_USD) return false
  return expectedUsd > thresholdUsd
}
