/**
 * Office conventions API client
 *
 * Typed fetch client for the office's conventions (`/api/organization/
 * office-conventions`): the lines the agent read from the office's documents,
 * and a person's decision on each. Same-origin BFF route; the view is the
 * service's own wire type (`lib/office-conventions/office-conventions-wire.ts`).
 *
 * A non-OK answer throws {@link ApiRequestError} carrying the HTTP status. The
 * card shows a failed load as an error state and a failed decision as a toast.
 */

import type { OfficeConventionsView } from '@/lib/office-conventions/office-conventions-wire'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

export type { OfficeConventionsView }

/** A person's answer to one convention line. */
export type OfficeConventionDecision = 'confirmed' | 'declined' | 'undecided'

const ENDPOINT = '/api/organization/office-conventions'

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

// ============================================================
// Conventions
// ============================================================

/** The office's conventions as they stand now. */
export const getOfficeConventions = async (): Promise<OfficeConventionsView> => {
  const response = await fetch(ENDPOINT)
  if (!response.ok) {
    throw new ApiRequestError(`Failed to load office conventions: ${response.status}`, response.status)
  }
  return (await response.json()) as OfficeConventionsView
}

/** Record a decision on one line; answers the view with that decision applied. */
export const decideOfficeConvention = async (
  lineKey: string,
  decision: OfficeConventionDecision,
): Promise<OfficeConventionsView> => {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ lineKey, decision }),
  })
  if (!response.ok) {
    throw new ApiRequestError(`Failed to save office convention: ${response.status}`, response.status)
  }
  return (await response.json()) as OfficeConventionsView
}
