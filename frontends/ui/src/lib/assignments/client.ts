/**
 * The typed client for who is on the hook for a resource (ADR-0055), the one
 * place the browser writes the paths of `/api/assignments/{type}/{id}`: who is
 * assigned (GET), assigning and releasing a person (POST, DELETE), and the
 * people who could be (`…/candidates`): who could open it now
 * (`listAssignmentCandidates`, for a document `mayOpenDocument`), or with
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

/** A person on the hook, as the routes answer: who, and who assigned them. */
export interface AssigneeView extends DirectoryPerson {
  assignedBy?: string
}

const defaultFetch: AssignmentFetch = (path, init) => fetch(path, init)

const resourcePath = (resourceType: string, resourceId: string) =>
  `/api/assignments/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`

async function assignees(response: Response): Promise<AssigneeView[]> {
  if (!response.ok) throw new Error(`assignments ${response.status}`)
  const body = (await response.json()) as { assignees?: AssigneeView[] }
  return body.assignees ?? []
}

/** Who is assigned to the resource. Throws on a refusal. */
export async function listAssignees(
  resourceType: string,
  resourceId: string,
  run: AssignmentFetch = defaultFetch
): Promise<AssigneeView[]> {
  return assignees(await run(resourcePath(resourceType, resourceId)))
}

/** Put a person on the hook; answers who is assigned now. Throws on a refusal. */
export async function assignPerson(
  resourceType: string,
  resourceId: string,
  userId: string,
  run: AssignmentFetch = defaultFetch
): Promise<AssigneeView[]> {
  return assignees(
    await run(resourcePath(resourceType, resourceId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    })
  )
}

/** Take a person off the hook; answers who is assigned now. Throws on a refusal. */
export async function releasePerson(
  resourceType: string,
  resourceId: string,
  userId: string,
  run: AssignmentFetch = defaultFetch
): Promise<AssigneeView[]> {
  return assignees(
    await run(`${resourcePath(resourceType, resourceId)}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' })
  )
}

/**
 * The people who could open (or, with `access: 'write'`, change) the resource,
 * the caller left out, by name. Throws on a refusal: a failed load is not
 * „nobody".
 */
export async function listAssignmentCandidates(
  resourceType: string,
  resourceId: string,
  options: { access?: 'read' | 'write' } = {},
  run: AssignmentFetch = defaultFetch
): Promise<DirectoryPerson[]> {
  const query = options.access === 'write' ? '?access=write' : ''
  const response = await run(`${resourcePath(resourceType, resourceId)}/candidates${query}`)
  if (!response.ok) throw new Error(`candidates ${response.status}`)
  const body = (await response.json()) as { candidates?: DirectoryPerson[] }
  return body.candidates ?? []
}
