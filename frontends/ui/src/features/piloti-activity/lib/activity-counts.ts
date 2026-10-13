/**
 * The numbers „Was Piloti tut" states, counted once for the section and the
 * Overview tile so the two cannot disagree.
 *
 * A count is a count of what is in the response. When a section is
 * `truncated` the real figure is larger and unknown; callers say „und
 * weitere" next to the number instead of inventing one.
 */

import type { PilotiActivityResponse, WaitingItem } from '@/lib/piloti-activity/types'

/** What waits for a decision: each proposal is one, each proposed mark is one (a `proposed_marks` row holds `count`). */
export function waitingCount(items: readonly WaitingItem[]): number {
  return items.reduce((sum, item) => sum + (item.kind === 'proposed_marks' ? item.count : 1), 0)
}

export interface ActivityCounts {
  running: number
  runningTruncated: boolean
  waiting: number
  waitingTruncated: boolean
}

export function activityCounts(activity: PilotiActivityResponse): ActivityCounts {
  return {
    running: activity.running.items.length,
    runningTruncated: activity.running.truncated,
    waiting: waitingCount(activity.waiting.items),
    waitingTruncated: activity.waiting.truncated,
  }
}
