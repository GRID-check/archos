/**
 * Project clean-out API client
 *
 * Typed fetch client for closing a project's clean-out: the proposal of which
 * documents to bin when a project closes, and running the clean-out
 * (`/api/projects/[id]/cleanup…`). Same-origin BFF routes; the proposal is the
 * library's own type (`lib/projects/cleanup-types.ts`).
 *
 * A refused clean-out throws {@link CleanupRequestError} with the envelope kept
 * as `body`: when a clean-out could not be fully undone, the envelope names the
 * folders it may have left files in, and the close dialog shows them.
 */

import type { CleanupProposal } from '@/lib/projects/cleanup-types'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

export type { CleanupProposal }

/** The documents to bin, and the proposal they were chosen from. */
export interface CleanupRequest {
  documentIds: string[]
  proposedIds: string[]
  aiUsed: boolean
}

/** A refused clean-out: the status, and the envelope as the server sent it (or null when it sent none). */
export class CleanupRequestError extends ApiRequestError {
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`Failed to run the clean-out: ${status}`, status)
    this.name = 'CleanupRequestError'
    this.body = body
  }
}

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

/** Which documents the clean-out would bin for this project, written in the caller's language. */
export const requestCleanupProposal = async (projectId: string, locale: 'de' | 'en'): Promise<CleanupProposal> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/cleanup/proposal`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ locale }),
  })
  if (!response.ok) {
    throw new ApiRequestError(`Failed to propose a clean-out: ${response.status}`, response.status)
  }
  return (await response.json()) as CleanupProposal
}

/** Bin the chosen documents. */
export const runCleanup = async (projectId: string, request: CleanupRequest): Promise<void> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/cleanup`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new CleanupRequestError(response.status, await response.json().catch(() => null))
}
