/**
 * Project lifecycle API client
 *
 * Typed fetch client for a project's lifecycle: renaming it, deleting and
 * restoring it, reindexing its documents, moving its status (active, paused,
 * closed), reading its closing record, and the list of what was recently
 * deleted (`/api/projects/[id]…`, `/api/deletions`). Same-origin BFF routes; the
 * record is the service's own type (`lib/projects/project-record-types.ts`).
 *
 * A non-OK answer throws {@link ProjectRequestError}, which carries the HTTP
 * status and the envelope's `error` text as `serverMessage`. Callers show the
 * server's sentence when there is one and their own when there is not.
 */

import type { ProjectOutcome } from '@/lib/projects/project-status'
import type { Month } from '@/lib/projects/month'
import type { ProjectRecordView } from '@/lib/projects/project-record-types'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** What a close names: how the project ended, and its Abschluss month. */
export interface ClosingChoice {
  outcome: ProjectOutcome
  endedOn: Month
}

/** A status move: back to active, paused, or closed with its outcome. */
export type ProjectStatusChange =
  | { status: 'active' }
  | { status: 'paused' }
  | ({ status: 'closed' } & ClosingChoice)

/** What a deletion answers: the grace deadline the project can still be restored before. */
export interface ProjectDeletion {
  purgeAfter?: string | null
}

/** One entry of the recently-deleted list. */
export interface DeletionEntry {
  id: string
  entityType: string
  entityId: string
  displayName: string
  purgeAfter: string
  status: 'pending' | 'failed'
  lastError: string | null
}

/**
 * A refused lifecycle request: the status, and the envelope's `error` text when
 * the server sent one. Callers branch on the status (a 409 is "someone moved it
 * first") and show `serverMessage` where the server had a sentence to say.
 */
export class ProjectRequestError extends ApiRequestError {
  readonly serverMessage: string | null

  constructor(message: string, status: number, serverMessage: string | null) {
    super(message, status)
    this.name = 'ProjectRequestError'
    this.serverMessage = serverMessage
  }
}

// ============================================================
// Helpers
// ============================================================

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

const projectPath = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}`

const failure = async (response: Response, context: string): Promise<ProjectRequestError> => {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  const serverMessage = typeof body?.error === 'string' ? body.error : null
  return new ProjectRequestError(`${context}: ${response.status}`, response.status, serverMessage)
}

// ============================================================
// Changes
// ============================================================

/** Rename the project. */
export const renameProject = async (projectId: string, name: string): Promise<void> => {
  const response = await fetch(projectPath(projectId), {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  })
  if (!response.ok) throw await failure(response, 'Failed to rename project')
}

/**
 * Delete the project. The caller names it again (`confirmName`) so a stray
 * click cannot delete it. Answers the grace deadline the project can be restored before.
 */
export const deleteProject = async (projectId: string, confirmName: string): Promise<ProjectDeletion> => {
  const response = await fetch(projectPath(projectId), {
    method: 'DELETE',
    headers: jsonHeaders,
    body: JSON.stringify({ confirmName }),
  })
  if (!response.ok) throw await failure(response, 'Failed to delete project')
  return ((await response.json().catch(() => null)) as ProjectDeletion | null) ?? {}
}

/** Restore a project from the recently-deleted list. */
export const restoreProject = async (projectId: string): Promise<void> => {
  const response = await fetch(`${projectPath(projectId)}/restore`, { method: 'POST' })
  if (!response.ok) throw await failure(response, 'Failed to restore project')
}

/** Queue a reindex of the project's documents. The job runs on its own; the answer carries no count. */
export const reindexProject = async (projectId: string): Promise<void> => {
  const response = await fetch(`${projectPath(projectId)}/reindex`, { method: 'POST' })
  if (!response.ok) throw await failure(response, 'Failed to reindex project')
}

/** Move the project to a new status. A 409 means someone moved it first. */
export const setProjectStatus = async (projectId: string, change: ProjectStatusChange): Promise<void> => {
  const response = await fetch(`${projectPath(projectId)}/status`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(change),
  })
  if (!response.ok) throw await failure(response, 'Failed to change project status')
}

// ============================================================
// Reads
// ============================================================

/** The project's closing record, as far as the server has built it. */
export const getProjectRecord = async (projectId: string): Promise<Partial<ProjectRecordView>> => {
  const response = await fetch(`${projectPath(projectId)}/project-record`)
  if (!response.ok) throw await failure(response, 'Failed to load project record')
  return (await response.json()) as Partial<ProjectRecordView>
}

/** What was deleted and can still be restored. A caller without the compliance capability is refused (403). */
export const listDeletions = async (): Promise<DeletionEntry[]> => {
  const response = await fetch('/api/deletions')
  if (!response.ok) throw await failure(response, 'Failed to list deletions')
  return (await response.json()) as DeletionEntry[]
}
