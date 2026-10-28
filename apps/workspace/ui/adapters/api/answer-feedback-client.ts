/**
 * Answer feedback API client
 *
 * Typed fetch client for the operator's answer-feedback reads: the digest of
 * what people voted on, and the filter options the export and the ratings
 * views offer (`/api/platform/answer-feedback/…`). Same-origin BFF routes; the
 * filter options are the export service's own type (`lib/feedback/export-service.ts`).
 *
 * The caller shapes its query string (the window, the filters) and passes it in:
 * the client only transports it. A non-OK answer throws {@link ApiRequestError}
 * carrying the HTTP status.
 */

import type { FeedbackFilterOptions } from '@/lib/feedback/export-service'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

export type { FeedbackFilterOptions }

/** The digest of one window of votes, as the model wrote it. */
export interface FeedbackDigestPayload {
  headline: string
  strengths: string[]
  concerns: string[]
  recommendation: string | null
  generatedAt: string
  windowDays: number
  votes: number
  /** Sampled unhelpful votes by decided cause; absent on a digest cached before causes existed. */
  causes?: { cause: string; count: number }[]
}

/** The digest route's answer: the digest, or the reason there is none. */
export interface AnswerFeedbackDigestResponse {
  digest: FeedbackDigestPayload | null
  error: string | null
}

// ============================================================
// Reads
// ============================================================

/** The digest of the window `query` describes (`days`, `locale`, the filters, and `refresh` to write a new one). */
export const getAnswerFeedbackDigest = async (query: string): Promise<AnswerFeedbackDigestResponse> => {
  const response = await fetch(`/api/platform/answer-feedback/digest?${query}`)
  if (!response.ok) {
    throw new ApiRequestError(`Failed to load answer feedback digest: ${response.status}`, response.status)
  }
  return (await response.json()) as AnswerFeedbackDigestResponse
}

/** The filter options for the window `query` describes; a caller that moves on passes a signal to abandon it. */
export const getAnswerFeedbackFilterOptions = async (
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<FeedbackFilterOptions> => {
  const response = await fetch(`/api/platform/answer-feedback/options?${query}`, { signal: options.signal })
  if (!response.ok) {
    throw new ApiRequestError(`Failed to load answer feedback options: ${response.status}`, response.status)
  }
  return (await response.json()) as FeedbackFilterOptions
}
