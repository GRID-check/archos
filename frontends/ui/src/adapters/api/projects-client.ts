/**
 * Projects API client
 *
 * Typed fetch client for the projects the caller can see (`/api/projects`). The
 * server decides which projects those are; this client only transports the
 * request and the typed answer. Same-origin BFF route.
 *
 * A non-OK answer throws {@link ApiRequestError} carrying the HTTP status.
 */

import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** The part of a project a list needs to name it. */
export interface ProjectListItem {
  id: string
  name: string
}

const PROJECTS_PATH = '/api/projects'

// ============================================================
// Projects
// ============================================================

/**
 * The projects the caller can see. Pass a signal to abandon the read when the
 * caller no longer needs it.
 */
export const listProjects = async (options: { signal?: AbortSignal } = {}): Promise<ProjectListItem[]> => {
  const response = await fetch(PROJECTS_PATH, { signal: options.signal })
  if (!response.ok) {
    throw new ApiRequestError(`Failed to list projects: ${response.status}`, response.status)
  }
  return (await response.json()) as ProjectListItem[]
}

/** The part of one project the file sources need: the collection its documents are indexed in. */
export interface ProjectCollection {
  collectionName?: string
}

/** One project's collection, as `/api/projects/[id]` answers it. */
export const getProjectCollection = async (projectId: string): Promise<ProjectCollection> => {
  const response = await fetch(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}`)
  if (!response.ok) {
    throw new ApiRequestError(`Failed to load project: ${response.status}`, response.status)
  }
  return (await response.json()) as ProjectCollection
}
