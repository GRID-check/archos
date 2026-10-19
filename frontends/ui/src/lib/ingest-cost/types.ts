/**
 * The wire contracts of the ingest-cost primitive, and the parsers that hold each
 * side to them (ADR-0055).
 *
 * Two shapes, and a parser per shape because they are two different contracts:
 *
 * - the BACKEND's report, which rides inside an ingest job status as
 *   `FileProgress.ingest_cost` and is spelled in snake_case, mirroring
 *   ``aiq_agent.knowledge.schema.IngestCostReport``;
 * - this BFF's response, which is spelled in camelCase and adds the threshold and
 *   the decision.
 *
 * Parsed, never cast. A cast makes the compiler agree with an assumption; a parse
 * makes the runtime disagree with a wrong one, which is what matters when the
 * backend may be a deploy ahead — an `ingest_cost` this build does not understand
 * reads as "no estimate", never as a number it guessed at.
 *
 * Client-safe: no `server-only`, no db. The dialog imports it.
 */

/**
 * What one file's cheap pre-read expects it to cost, in USD.
 *
 * `expectedUsd` and `upperUsd` are null together, and only when the pre-read
 * could not see the file's embedded rasters — 81% of the ingest bill — so a
 * number here is never one that quietly omits most of the cost. `isCoarse` says
 * some input was missing and a zero stood in for it, so the dollars are a floor;
 * `missingInputs` names those inputs. A reader must not present a coarse estimate
 * as a firm one.
 */
export interface IngestCostReport {
  /** The expected ingest bill in USD, or null when the rasters were not measured. */
  expectedUsd: number | null
  /** `expectedUsd` times the estimator's upper-bound multiplier (4), or null beside it. */
  upperUsd: number | null
  /** True when an input was missing: the dollars are a floor, read `missingInputs`. */
  isCoarse: boolean
  /**
   * The pre-read facts the job could not measure, verbatim. Strings rather than a
   * known-union: a deploy-ahead backend may name a new fact, and dropping it would
   * leave `isCoarse` true with nothing saying why.
   */
  missingInputs: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isUsd = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string' && name.length > 0) : []

/**
 * Read one `FileProgress.ingest_cost` as the backend spelled it, or `null` when
 * the backend reported none or reported something this build cannot read.
 *
 * Null is "no estimate", which is the honest reading of both an absent field (a
 * file the pre-read never priced: an image, a spreadsheet) and a shape from a
 * newer backend. It is never 0: a free ingest and an unmeasured one are not the
 * same claim.
 */
export function parseBackendIngestCostReport(raw: unknown): IngestCostReport | null {
  if (!isRecord(raw)) return null
  return {
    expectedUsd: isUsd(raw.expected_usd) ? raw.expected_usd : null,
    upperUsd: isUsd(raw.upper_usd) ? raw.upper_usd : null,
    isCoarse: raw.is_coarse === true,
    missingInputs: names(raw.missing_inputs),
  }
}

/** This BFF's own report, in camelCase, validated strictly: an unreadable one throws rather than renders. */
function parseResponseReport(raw: unknown): IngestCostReport {
  if (!isRecord(raw)) throw new Error('ingest cost: unreadable estimate')
  const { expectedUsd, upperUsd, isCoarse, missingInputs } = raw
  if (expectedUsd !== null && !isUsd(expectedUsd)) throw new Error('ingest cost: bad expectedUsd')
  if (upperUsd !== null && !isUsd(upperUsd)) throw new Error('ingest cost: bad upperUsd')
  if (typeof isCoarse !== 'boolean') throw new Error('ingest cost: bad isCoarse')
  if (!Array.isArray(missingInputs) || !missingInputs.every((name) => typeof name === 'string')) {
    throw new Error('ingest cost: bad missingInputs')
  }
  return { expectedUsd, upperUsd, isCoarse, missingInputs }
}

/**
 * This BFF's answer for one document: the pre-read's estimate, the threshold in
 * force for the document's organisation, and whether the estimate crosses it.
 *
 * `estimate` is null when there is nothing to show yet — the document has no
 * ingest job, or its pre-read has not reported (it runs once the job reaches the
 * screen stage). `thresholdUsd` of 0 means the confirmation is switched off;
 * `requiresConfirmation` is then false whatever the estimate.
 */
export interface DocumentIngestCost {
  estimate: IngestCostReport | null
  /** The confirmation threshold in force, in USD. 0 means the step is off. */
  thresholdUsd: number
  /** Whether the estimate is above the threshold and a person should be asked. */
  requiresConfirmation: boolean
}

/**
 * Read the response of `GET /api/documents/{id}/ingest-cost`, or throw.
 *
 * Strict on the three fields the dialog draws from and forgiving of anything
 * else: a response this build cannot read is an error the caller shows as "no
 * estimate", not a partially-populated object it renders as fact.
 */
export function parseDocumentIngestCost(raw: unknown): DocumentIngestCost {
  if (!isRecord(raw)) throw new Error('ingest cost: not an object')
  if (!isUsd(raw.thresholdUsd)) throw new Error('ingest cost: no threshold')
  if (typeof raw.requiresConfirmation !== 'boolean') throw new Error('ingest cost: no decision')
  return {
    estimate: raw.estimate === null ? null : parseResponseReport(raw.estimate),
    thresholdUsd: raw.thresholdUsd,
    requiresConfirmation: raw.requiresConfirmation,
  }
}
