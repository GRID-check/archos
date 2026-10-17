/**
 * The typed client for who may be put on the hook for a resource (ADR-0055):
 * `GET /api/assignments/{type}/{id}/candidates`, the people who could open it
 * now (`listAssignmentCandidates`, for a document `mayOpenDocument`). The
 * Zuständige picker and the Anmerkung composer's „@" picker read the same list,
 * so whom a mark may be assigned to and whom it may mention cannot drift.
 *
 * No `server-only`: the browser imports this.
 */

import type { DirectoryPerson } from '@/lib/sharing/types'

/** How a request is made: `fetch` in a browser, the real handler in a route spec. */
export type AssignmentFetch = (path: string, init?: RequestInit) => Promise<Response>

/** The people who could open the resource, the caller left out, by name. Throws on a refusal: a failed load is not „nobody". */
export async function listAssignmentCandidates(
  resourceType: string,
  resourceId: string,
  run: AssignmentFetch = (path, init) => fetch(path, init)
): Promise<DirectoryPerson[]> {
  const response = await run(
    `/api/assignments/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/candidates`
  )
  if (!response.ok) throw new Error(`candidates ${response.status}`)
  const body = (await response.json()) as { candidates?: DirectoryPerson[] }
  return body.candidates ?? []
}
