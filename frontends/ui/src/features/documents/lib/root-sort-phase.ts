/**
 * What the root-sort dialog shows, decided from the server's state (ADR-0121).
 *
 * Pure: the dialog passes what it has read (the root's summary, the run it
 * follows, and whether the root could not be read), and this says which phase
 * to draw. Nothing here makes a request or moves a file.
 */

import { RootSortRequestError } from '@/lib/filing/root-sort-client'
import {
  ROOT_SORT_WORKING_STATUSES,
  type RootSortRunStatus,
  type RootSortRunView,
  type RootSortSummary,
} from '@/lib/filing/root-sort-types'

/** The statuses the server is working: the dialog follows them. */
export type WorkingRootSortStatus = 'judging' | 'grouping' | 'applying' | 'undoing'

export function isWorking(status: RootSortRunStatus): status is WorkingRootSortStatus {
  return ROOT_SORT_WORKING_STATUSES.includes(status)
}

/**
 * What the dialog draws. `loading` reads the root; `intro` offers to start; the
 * rest follow a run. `failed` is also the root that could not be read (no run).
 */
export type RootSortPhase =
  | 'loading'
  | 'intro'
  | 'working'
  | 'review'
  | 'done'
  | 'undone'
  | 'failed'
  | 'cancelled'

/**
 * The phase of the dialog. `run` is the run the dialog follows (a start, an
 * apply, a poll); without one, the root's latest run says where the server got
 * to. A run that was cancelled or undone is its own phase, and the dialog
 * offers to start another from it.
 */
export function phaseOf(
  summary: RootSortSummary | null,
  run: RootSortRunView | null,
  loadError: boolean
): RootSortPhase {
  if (loadError) return 'failed'
  const current = run ?? summary?.run ?? null
  if (current === null) return summary === null ? 'loading' : 'intro'
  if (isWorking(current.status)) return 'working'
  switch (current.status) {
    case 'ready':
      return 'review'
    case 'applied':
      return 'done'
    case 'undone':
      return 'undone'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
  }
}

/** The server refused a request because a sort of this shelf is already in work. */
export function isSortConflict(error: unknown): boolean {
  return error instanceof RootSortRequestError && error.status === 409
}
