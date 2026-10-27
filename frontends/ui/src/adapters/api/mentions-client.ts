/**
 * Mentions API client
 *
 * Typed fetch client for a thread's mention state: who an `@` can name, who the
 * thread is waiting on (its hand-off state), and releasing a waiting request.
 * Same-origin BFF routes; the shapes are the mentions library's own types
 * (`lib/mentions/types.ts`).
 *
 * A non-OK answer throws {@link ApiRequestError} carrying the HTTP status. The
 * caller decides what that means: a failed poll keeps the last known state.
 */

import type { AwaitingStateResponse, MentionCandidatesResponse } from '@/lib/mentions/types'
import { ApiRequestError } from './api-error'

/** The thread's hand-off state: the open mention requests it is waiting on. */
export const getAwaitingState = async (conversationId: string): Promise<AwaitingStateResponse> => {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/awaiting`)
  if (!response.ok) throw new ApiRequestError(`Failed to load awaiting state: ${response.status}`, response.status)
  return (await response.json()) as AwaitingStateResponse
}

/** Release one open mention request; answers the thread's state with it released. */
export const releaseMention = async (requestId: string): Promise<AwaitingStateResponse> => {
  const response = await fetch(`/api/mentions/${encodeURIComponent(requestId)}/release`, { method: 'POST' })
  if (!response.ok) throw new ApiRequestError(`Failed to release mention: ${response.status}`, response.status)
  return (await response.json()) as AwaitingStateResponse
}

/** Who a thread's `@` can name. */
export const getMentionCandidates = async (conversationId: string): Promise<MentionCandidatesResponse> => {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/mention-candidates`)
  if (!response.ok) throw new ApiRequestError(`Failed to load mention candidates: ${response.status}`, response.status)
  return (await response.json()) as MentionCandidatesResponse
}
