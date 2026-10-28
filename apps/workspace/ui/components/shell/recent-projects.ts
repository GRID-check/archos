'use client'

/**
 * The projects this reader opened last, newest first: what the project switcher
 * sheet offers above the full list.
 *
 * An architect on site moves between the two or three projects of this week,
 * and a name-sorted list of every running project makes each switch a search.
 * Per browser, in `localStorage`, like the last-section memory beside it
 * (`use-last-project-section`): a convenience that may come back empty, never a
 * record anyone else reads. Every access is guarded, because storage throws in
 * a private window and in some embedded previews.
 */

import { useEffect } from 'react'

export const RECENT_PROJECTS_STORAGE_KEY = 'project.recent'

/** How many ids are kept. The sheet shows fewer; the rest absorb deletions. */
const KEEP = 8

export function readRecentProjectIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY) ?? '[]'
    )
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** Move a project to the front of the list. */
export function withRecentProject(ids: readonly string[], projectId: string): string[] {
  return [projectId, ...ids.filter((id) => id !== projectId)].slice(0, KEEP)
}

export function recordRecentProject(projectId: string): void {
  if (typeof window === 'undefined') return
  try {
    const next = withRecentProject(readRecentProjectIds(), projectId)
    window.localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable: the sheet simply has no recents to offer.
  }
}

/** Record entering a project. Mount once in the project chrome. */
export function useRecordRecentProject(projectId: string): void {
  useEffect(() => {
    recordRecentProject(projectId)
  }, [projectId])
}
