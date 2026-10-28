/**
 * What the chat says about the budget before it runs out (the usage notice).
 *
 * `getBudgetUtilisation` lists every LIMITED window of every scope that applies
 * to one person in one project. This module turns that list into at most one
 * notice, the one that matters most to the person about to type:
 *
 *   forecast  — a monthly window is half used and, at the pace of the month so
 *               far, runs out at least a day before it renews;
 *   warning   — a window is 80 % used (the same line as `budget_threshold_crossed`);
 *   critical  — 95 %: a long research run may now stop before it finishes,
 *               because the tracker stops at the next model call (ADR-0015);
 *   exhausted — 100 %: no turn starts until the window renews or a limit moves.
 *
 * Choosing ONE window is the point. Six meters say nothing a person acts on;
 * "the office's monthly budget is used up until 1 November" does. The highest
 * level wins. Among exhausted windows the one that renews LAST wins, because that
 * one decides when chat works again; among the rest, the fullest wins.
 *
 * Pure: no I/O and the clock is a parameter, so the thresholds and the window
 * arithmetic are tested without a database. Windows are UTC, like the rollup.
 */

import type { BudgetScope, BudgetUnit } from '@/lib/db/schema/budgets'

export type UsageNoticeLevel = 'forecast' | 'warning' | 'critical' | 'exhausted'

/** Percent of a limit at which each level starts, highest first. */
export const USAGE_NOTICE_THRESHOLDS = [
  { level: 'exhausted', percent: 100 },
  { level: 'critical', percent: 95 },
  { level: 'warning', percent: 80 },
] as const satisfies ReadonlyArray<{ level: UsageNoticeLevel; percent: number }>

/** A monthly window is forecast only once this much of it is used: earlier, one long run is noise. */
export const FORECAST_MIN_PERCENT = 50
/** And only when the projected run-out is at least this long before it renews. */
const FORECAST_MIN_LEAD_MS = 24 * 60 * 60_000
/** And only once an hour of the month has passed, so a rollover second is not a pace. */
const FORECAST_MIN_ELAPSED_MS = 60 * 60_000

const LEVEL_RANK: Record<UsageNoticeLevel, number> = { forecast: 0, warning: 1, critical: 2, exhausted: 3 }

/** One limited window as `getBudgetUtilisation` reports it. */
export interface WindowUtilisation {
  scope: BudgetScope
  subjectId: string | null
  unit: BudgetUnit
  window: 'day' | 'month'
  limit: number
  used: number
}

/** The notice, before the viewer's rights decide what it may link to and show. */
export interface UsageNoticeDecision {
  level: UsageNoticeLevel
  scope: BudgetScope
  subjectId: string | null
  window: 'day' | 'month'
  unit: BudgetUnit
  /** Whole percent used, floored, so "100" is only ever shown for a spent window. */
  percent: number
  used: number
  limit: number
  /** UTC identity of the window (`2026-10-21`, `2026-10`), for "dismissed in this window". */
  windowId: string
  /** ISO instant the window renews. */
  resetsAt: string
  /** ISO instant a monthly window runs out at this month's pace, when that is before it renews. */
  runsOutAt: string | null
}

/** The UTC window `now` is in: its identity, where it started and when it renews. */
export const utcWindow = (window: 'day' | 'month', now: Date): { id: string; startsAt: number; endsAt: number } => {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  if (window === 'month') {
    return { id: now.toISOString().slice(0, 7), startsAt: Date.UTC(year, month, 1), endsAt: Date.UTC(year, month + 1, 1) }
  }
  const day = now.getUTCDate()
  return {
    id: now.toISOString().slice(0, 10),
    startsAt: Date.UTC(year, month, day),
    endsAt: Date.UTC(year, month, day + 1),
  }
}

/** Percent used. A zero limit is spent before anything is used. */
const percentUsed = (used: number, limit: number): number => (limit > 0 ? (used / limit) * 100 : 100)

/**
 * When this window runs out if it keeps the pace it has kept since it started:
 * only for a month (a day is one or two long runs, not a pace), and only when
 * that is well before it renews. Null when there is nothing to forecast.
 */
export const projectedRunOut = (usage: WindowUtilisation, now: Date): Date | null => {
  if (usage.window !== 'month' || usage.limit <= 0 || usage.used >= usage.limit) return null
  if (percentUsed(usage.used, usage.limit) < FORECAST_MIN_PERCENT) return null
  const { startsAt, endsAt } = utcWindow('month', now)
  const elapsed = now.getTime() - startsAt
  if (elapsed < FORECAST_MIN_ELAPSED_MS) return null
  const runsOutAt = startsAt + elapsed * (usage.limit / usage.used)
  return runsOutAt <= endsAt - FORECAST_MIN_LEAD_MS ? new Date(runsOutAt) : null
}

const levelOf = (usage: WindowUtilisation, runsOutAt: Date | null): UsageNoticeLevel | null => {
  const percent = percentUsed(usage.used, usage.limit)
  const crossed = USAGE_NOTICE_THRESHOLDS.find((threshold) => percent >= threshold.percent)
  if (crossed) return crossed.level
  return runsOutAt ? 'forecast' : null
}

/** Which of two candidates at the same level the person should hear about. */
const outranks = (a: UsageNoticeDecision, b: UsageNoticeDecision): boolean => {
  if (LEVEL_RANK[a.level] !== LEVEL_RANK[b.level]) return LEVEL_RANK[a.level] > LEVEL_RANK[b.level]
  if (a.level === 'exhausted' && a.resetsAt !== b.resetsAt) return a.resetsAt > b.resetsAt
  if (a.level === 'forecast' && a.runsOutAt && b.runsOutAt && a.runsOutAt !== b.runsOutAt) {
    return a.runsOutAt < b.runsOutAt
  }
  return percentUsed(a.used, a.limit) > percentUsed(b.used, b.limit)
}

/** The one notice the chat shows for these windows at `now`, or null when none is worth saying. */
export function decideUsageNotice(usages: readonly WindowUtilisation[], now: Date): UsageNoticeDecision | null {
  let best: UsageNoticeDecision | null = null
  for (const usage of usages) {
    const runsOutAt = projectedRunOut(usage, now)
    const level = levelOf(usage, runsOutAt)
    if (!level) continue
    const window = utcWindow(usage.window, now)
    const candidate: UsageNoticeDecision = {
      level,
      scope: usage.scope,
      subjectId: usage.subjectId,
      window: usage.window,
      unit: usage.unit,
      percent: Math.min(100, Math.floor(percentUsed(usage.used, usage.limit))),
      used: usage.used,
      limit: usage.limit,
      windowId: window.id,
      resetsAt: new Date(window.endsAt).toISOString(),
      runsOutAt: runsOutAt?.toISOString() ?? null,
    }
    if (!best || outranks(candidate, best)) best = candidate
  }
  return best
}

/**
 * The usage notice as the chat shows it to this viewer (`getChatUsageNotice`):
 * the decision above, plus what the viewer's rights allow. `canChange` says
 * whether they can move the limit that binds, which decides between "raise the
 * limit" and "ask an admin". `used` and `limit` travel only to someone who may
 * already read them on a settings page: whoever can change the limit, and a
 * member for their own limit. Everyone else gets the percentage, which the
 * exhausted banner has always implied anyway.
 */
export interface ChatUsageNotice {
  level: UsageNoticeLevel
  scope: BudgetScope
  window: 'day' | 'month'
  unit: BudgetUnit
  percent: number
  amounts: { used: number; limit: number } | null
  resetsAt: string
  runsOutAt: string | null
  canChange: boolean
  /** Where the binding limit is shown and, for `canChange`, edited. */
  href: string
  /** Stable per scope, subject, window and level: a dismissal holds until one of them moves. */
  key: string
}
