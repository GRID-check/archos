/**
 * Project record API client
 *
 * Typed fetch client for the Steckbrief the project record editor saves: the
 * project's start month, and the people who worked on it
 * (`/api/projects/[id]/project-record`, `/api/projects/[id]/people…`). Same-origin
 * BFF routes. Months are the project's own `YYYY-MM` type (`lib/projects/month.ts`).
 *
 * A non-OK answer throws {@link ApiRequestError} carrying the HTTP status. The
 * editor reports every failed save the same way, so no caller needs more.
 */

import type { Month } from '@/lib/projects/month'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** A person's entry as the editor saves it. `userId` links a member of the office; null names someone outside it. */
export interface ProjectPersonInput {
  name: string
  function: string
  company: string
  startedOn: Month | null
  endedOn: Month | null
  userId: string | null
}

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

const recordPath = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/project-record`

const peoplePath = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/people`

const failure = (context: string, status: number): ApiRequestError =>
  new ApiRequestError(`${context}: ${status}`, status)

// ============================================================
// Saves
// ============================================================

/** Save the project's Beginn. `null` clears it. */
export const saveProjectStartMonth = async (projectId: string, startedOn: Month | null): Promise<void> => {
  const response = await fetch(recordPath(projectId), {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ startedOn }),
  })
  if (!response.ok) throw failure('Failed to save the project period', response.status)
}

/** Add a person to the project's record. */
export const addProjectPerson = async (projectId: string, person: ProjectPersonInput): Promise<void> => {
  const response = await fetch(peoplePath(projectId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(person),
  })
  if (!response.ok) throw failure('Failed to add a person', response.status)
}

/** Change one person on the project's record. */
export const updateProjectPerson = async (
  projectId: string,
  personId: string,
  person: ProjectPersonInput,
): Promise<void> => {
  const response = await fetch(`${peoplePath(projectId)}/${encodeURIComponent(personId)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(person),
  })
  if (!response.ok) throw failure('Failed to update a person', response.status)
}

/** Remove one person from the project's record. */
export const removeProjectPerson = async (projectId: string, personId: string): Promise<void> => {
  const response = await fetch(`${peoplePath(projectId)}/${encodeURIComponent(personId)}`, { method: 'DELETE' })
  if (!response.ok) throw failure('Failed to remove a person', response.status)
}
