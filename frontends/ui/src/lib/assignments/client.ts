/**
 * The typed client for who may be put on the hook for a resource (ADR-0055):
 * `GET /api/assignments/{type}/{id}/candidates`, the people who could open it
 * now (`listAssignmentCandidates`, for a document `mayOpenDocument`), or with
 * `access: 'write'` who could change it (`mayWriteDocument`). A document's
 * assignee and whom an Anmerkung may mention read the first list; a mark's
 * Zuständige, who must answer and close it, the second, which the server
 * checks again on every write.
 *
 * No `server-only`: the browser imports this.
 */

import type { DirectoryPerson } from '@/lib/sharing/types'

/** How a request is made: `fetch` in a browser, the real handler in a route spec. */
export type AssignmentFetch = (path: string, init?: RequestInit) => Promise<Response>

/** The people who could open (or, with `access: 'write'`, change) the resource, the caller left out, by name. Throws on a refusal: a failed load is not „nobody". */
export async function listAssignmentCandidates(
  resourceType: string,
  resourceId: string,
  options: { access?: 'read' | 'write' } = {},
  run: AssignmentFetch = (path, init) => fetch(path, init)
): Promise<DirectoryPerson[]> {
  const query = options.access === 'write' ? '?access=write' : ''
  const response = await run(
    `/api/assignments/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/candidates${query}`
  )
  if (!response.ok) throw new Error(`candidates ${response.status}`)
  const body = (await response.json()) as { candidates?: DirectoryPerson[] }
  return body.candidates ?? []
}
