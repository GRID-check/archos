/**
 * Sharing API client
 *
 * Typed fetch client for who can see a resource (`/api/sharing/[type]/[id]…`):
 * the roster, its visibility, the grants and the invite candidates. Same-origin
 * BFF routes; the state and candidate types are the service's own
 * (`lib/sharing/types.ts`).
 *
 * A refused mutation throws {@link SharingRequestError}, which carries the
 * envelope's `details` as a {@link SharingFailure}: the share dialog needs the
 * reason, the person and the restricted folders to say why, not only the status.
 * A failed read throws a plain {@link ApiRequestError}.
 */

import type {
  ResourceRole,
  ResourceSharingState,
  ResourceVisibility,
  ShareCandidate,
  ShareableResourceType,
} from '@/lib/sharing/types'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** A refusal the UI can localise, extracted from the standard error envelope. */
export interface SharingFailure {
  /** `details.reason` when the server supplied one (e.g. `last-owner`). */
  reason: string | null
  /** Server-supplied message, as a fallback when the reason is unrecognised. */
  message: string | null
  /** `details.person`: who a `restricted-content` refusal is about, when the server named them. */
  person?: string | null
  /** `details.folders`: the restricted folders, named only to a sharer cleared for them. */
  folders?: readonly string[]
}

/** The failure a caller gets when it could not read the envelope at all. */
export const NO_FAILURE_DETAIL: SharingFailure = { reason: null, message: null }

/** The invite candidates, as the route answers them: a bare list, or the list under `candidates`. */
export type ShareCandidatesResponse = ShareCandidate[] | { candidates: ShareCandidate[] }

/** A refused sharing change: the status, and the envelope's details as {@link SharingFailure}. */
export class SharingRequestError extends ApiRequestError {
  readonly failure: SharingFailure

  constructor(failure: SharingFailure, status: number) {
    super(`Sharing change failed: ${status}`, status, failure.reason)
    this.name = 'SharingRequestError'
    this.failure = failure
  }
}

// ============================================================
// Helpers
// ============================================================

const sharingPath = (resourceType: ShareableResourceType, resourceId: string): string =>
  `/api/sharing/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`

const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

async function readSharingFailure(response: Response): Promise<SharingFailure> {
  try {
    const body = (await response.json()) as {
      error?: string
      details?: { reason?: unknown; person?: unknown; folders?: unknown } | null
    }
    const details = body.details ?? {}
    const folders = Array.isArray(details.folders)
      ? details.folders.filter((folder): folder is string => typeof folder === 'string')
      : []
    return {
      reason: typeof details.reason === 'string' ? details.reason : null,
      message: body.error ?? null,
      person: typeof details.person === 'string' ? details.person : null,
      folders,
    }
  } catch {
    return NO_FAILURE_DETAIL
  }
}

/** A sharing change: the server's answer is the roster to render, never an optimistic guess. */
const sendSharingChange = async (path: string, init: RequestInit): Promise<ResourceSharingState> => {
  const response = await fetch(path, init)
  if (!response.ok) throw new SharingRequestError(await readSharingFailure(response), response.status)
  return (await response.json()) as ResourceSharingState
}

// ============================================================
// Reads
// ============================================================

/** Who can see the resource: its visibility, its grants and what the caller may do. */
export const getResourceSharing = async (
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<ResourceSharingState> => {
  const response = await fetch(sharingPath(resourceType, resourceId))
  if (!response.ok) throw new ApiRequestError(`Failed to load sharing: ${response.status}`, response.status)
  return (await response.json()) as ResourceSharingState
}

/** Who could be invited to the resource. */
export const getShareCandidates = async (
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<ShareCandidatesResponse> => {
  const response = await fetch(`${sharingPath(resourceType, resourceId)}/candidates`)
  if (!response.ok) throw new ApiRequestError(`Failed to load share candidates: ${response.status}`, response.status)
  return (await response.json()) as ShareCandidatesResponse
}

// ============================================================
// Changes
// ============================================================

export const setResourceVisibility = (
  resourceType: ShareableResourceType,
  resourceId: string,
  visibility: ResourceVisibility,
): Promise<ResourceSharingState> =>
  sendSharingChange(sharingPath(resourceType, resourceId), jsonRequest('PATCH', { visibility }))

export const grantResourceAccess = (
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
  role: ResourceRole,
): Promise<ResourceSharingState> =>
  sendSharingChange(`${sharingPath(resourceType, resourceId)}/grants`, jsonRequest('POST', { subjectUserId, role }))

export const changeResourceRole = (
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
  role: ResourceRole,
): Promise<ResourceSharingState> =>
  sendSharingChange(`${sharingPath(resourceType, resourceId)}/grants`, jsonRequest('PATCH', { subjectUserId, role }))

export const revokeResourceAccess = (
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
): Promise<ResourceSharingState> =>
  sendSharingChange(
    `${sharingPath(resourceType, resourceId)}/grants/${encodeURIComponent(subjectUserId)}`,
    { method: 'DELETE' },
  )

/** Send the grants route its `escalate` request, which the share dialog's escalation control makes. */
export const escalateResourceAccess = (
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<ResourceSharingState> =>
  sendSharingChange(`${sharingPath(resourceType, resourceId)}/grants`, jsonRequest('POST', { escalate: true }))
