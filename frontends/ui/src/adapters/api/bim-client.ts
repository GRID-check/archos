/**
 * BIM API client
 *
 * Typed fetch client for the BIM model queries the revision comparison runs
 * (`/api/bim/models/[id]/query`). Same-origin BFF route. The comparison result
 * is the library's own type (`lib/bim/compare.ts`), so the client and the panel
 * read the same shape the server computes.
 *
 * A non-OK answer throws {@link ApiRequestError} carrying the HTTP status; the
 * panel shows that as a failed comparison.
 */

import type { BimComparison } from '@/lib/bim/compare'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

export type { BimComparison }

/** The comparison's inputs: the older revision, and how many element rows to read from each side. */
export interface CompareBimModelInput {
  baseModelId: string
  limit: number
}

// ============================================================
// Queries
// ============================================================

/**
 * Compare a model with an older revision of it. Answers `null` when the server
 * has no comparison to give, which is not a failure.
 */
export const compareBimModel = async (
  modelId: string,
  input: CompareBimModelInput,
): Promise<BimComparison | null> => {
  const response = await fetch(`/api/bim/models/${modelId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'compare', ...input }),
  })
  if (!response.ok) {
    throw new ApiRequestError(`Failed to compare models: ${response.status}`, response.status)
  }
  const body = (await response.json()) as { comparison?: BimComparison }
  return body.comparison ?? null
}
