/**
 * Project memory API client
 *
 * Typed fetch client for a project's memory and its closing experience
 * (`/api/projects/[id]/memory…`, `/api/projects/[id]/experience`): listing the
 * remembered decisions and constraints, confirming or dismissing one, recording
 * a lesson, and asking the backend to read the project's documents for what they
 * say about the project. Same-origin BFF routes; the item shape is the schema's
 * own (`lib/db/schema/project-memory.ts`) and the extraction result is the
 * experience library's (`lib/project-experience/types.ts`).
 *
 * A non-OK answer throws {@link ApiRequestError} carrying the HTTP status. The
 * closing debrief shows every failure of these calls as the same failed state, so
 * no caller needs more than the status.
 */

import type { ProjectMemoryItem } from '@/lib/db/schema/project-memory'
import type { ProjectExperienceResult } from '@/lib/project-experience/types'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** A memory item as the list route sends it. */
export type ProjectMemoryEntry = Pick<
  ProjectMemoryItem,
  'id' | 'kind' | 'content' | 'status' | 'verification' | 'pinned' | 'provenanceType' | 'evidence'
>

/** One page of a project's memory. */
export interface ProjectMemoryPage {
  items: ProjectMemoryEntry[]
  nextCursor: string | null
}

/** What a memory item may be changed to: a person confirms it, or dismisses it. */
export interface ProjectMemoryUpdate {
  verification?: 'user_confirmed'
  status?: 'dismissed'
}

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

const memoryPath = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/memory`

// ============================================================
// Memory
// ============================================================

/** One page of the project's memory, `limit` items at a time, from `cursor` on. */
export const listProjectMemory = async (
  projectId: string,
  options: { limit: number; cursor?: string | null },
): Promise<ProjectMemoryPage> => {
  const query = new URLSearchParams({ limit: String(options.limit) })
  if (options.cursor) query.set('cursor', options.cursor)
  const response = await fetch(`${memoryPath(projectId)}?${query.toString()}`)
  if (!response.ok) throw new ApiRequestError(`Failed to list project memory: ${response.status}`, response.status)
  return (await response.json()) as ProjectMemoryPage
}

/** Change one item: confirm it, or dismiss it. Answers the item as it now stands. */
export const updateProjectMemoryItem = async (
  projectId: string,
  itemId: string,
  update: ProjectMemoryUpdate,
): Promise<{ item: ProjectMemoryEntry }> => {
  const response = await fetch(`${memoryPath(projectId)}/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(update),
  })
  if (!response.ok) throw new ApiRequestError(`Failed to update project memory: ${response.status}`, response.status)
  return (await response.json()) as { item: ProjectMemoryEntry }
}

/** Record a decision the closer wrote in their own words. Answers the new item. */
export const addProjectMemoryItem = async (
  projectId: string,
  input: { kind: 'decision'; content: string },
): Promise<{ item: ProjectMemoryEntry }> => {
  const response = await fetch(memoryPath(projectId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new ApiRequestError(`Failed to add project memory: ${response.status}`, response.status)
  return (await response.json()) as { item: ProjectMemoryEntry }
}

// ============================================================
// Experience
// ============================================================

/**
 * Have the backend read the project's documents once and write what they say as
 * suggestions. A reason it could not answer comes back in the result's `error`,
 * not as a failed status.
 */
export const extractProjectExperience = async (projectId: string): Promise<ProjectExperienceResult> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/experience`, { method: 'POST' })
  if (!response.ok) throw new ApiRequestError(`Failed to extract project experience: ${response.status}`, response.status)
  return (await response.json()) as ProjectExperienceResult
}
