/**
 * Quality scope API client
 *
 * Typed fetch client for the organizations and projects a quality view can be
 * scoped to (`/api/platform/quality/scope-options`). The options are the quality
 * library's own type (`lib/quality/scope-options.ts`). The caller shapes the
 * query string from its scope; a non-OK answer throws {@link ApiRequestError}
 * carrying the HTTP status.
 */

import type { QualityScopeOptions } from '@/lib/quality/scope-options'
import { ApiRequestError } from './api-error'

export type { QualityScopeOptions }

/** The organizations and projects the scope described by `query` can name. */
export const getQualityScopeOptions = async (
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<QualityScopeOptions> => {
  const response = await fetch(`/api/platform/quality/scope-options?${query}`, { signal: options.signal })
  if (!response.ok) {
    throw new ApiRequestError(`Failed to load quality scope options: ${response.status}`, response.status)
  }
  return (await response.json()) as QualityScopeOptions
}
