/**
 * A project's lifecycle (ADR-0098, ADR-0090): a small state machine. The pure
 * rule, with no I/O, so the authorization seam, the agent's service-token paths
 * and the UI read one answer.
 *
 *   active ⇄ paused        pausing parks it; nothing about access changes
 *   active|paused → closed  the work is over, completed or not realized
 *   closed → active         reopening, for a defect claim or a next phase
 *
 * Only `closed` changes what anyone may do. A paused project is an active one
 * that has left the list's „Aktiv" view and whose schedules do not run
 * ({@link runsOnSchedule}); it stays writable and members-only.
 *
 * A closed project is read-only for its files, folders, versions, its profile
 * and its project memory. Chat about it stays. What a permission still allows
 * in a closed project is {@link CLOSED_PROJECT_KEEPS}; everything else is
 * refused with {@link projectClosedError}, before the organization-admin bypass,
 * so an admin is refused too.
 *
 * Every member of the organization may read a closed project and chat about
 * it, whether or not they were a member of it ({@link CLOSED_PROJECT_OPEN_TO_ORGANIZATION}).
 * Someone who reads it only for that reason clears no folder with its own role
 * list: their folder clearance is that of a member holding no role
 * (`clearanceOf` in `lib/authz/folder-access.ts`), so closing never opens a
 * restricted folder.
 */

import { ForbiddenError } from '@/lib/api/api-error'
import type { ProjectPermission } from '@/lib/authz/permissions'
import { dateToMonth, isMonth, isOrderedPeriod, type Month } from './month'

export const PROJECT_STATUSES = ['active', 'paused', 'closed'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

/**
 * How a closed project ended (migration 0129): built and handed over, or not
 * realized (a competition not won, a commission withdrawn). Either way it is
 * the office's reference; the outcome says which kind.
 */
export const PROJECT_OUTCOMES = ['completed', 'cancelled'] as const
export type ProjectOutcome = (typeof PROJECT_OUTCOMES)[number]

/** Every move the lifecycle allows, from each state. Anything else is refused (409 `invalid-transition`). */
export const PROJECT_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  active: ['paused', 'closed'],
  paused: ['active', 'closed'],
  closed: ['active'],
}

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_TRANSITIONS[from].includes(to)
}

/** The states a project may be in for a move to `to`: what the repository's UPDATE matches on. */
export function statusesThatMayBecome(to: ProjectStatus): ProjectStatus[] {
  return PROJECT_STATUSES.filter((from) => canTransition(from, to))
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value)
}

/** A status read from anywhere (a row, the wire, stored metadata); anything unknown reads as active. */
export function toProjectStatus(value: unknown): ProjectStatus {
  return isProjectStatus(value) ? value : 'active'
}

/**
 * The Abschluss a project has: its `ended_on`, but only once it is closed. An
 * active or paused project is still running whatever is stored (a reopen keeps
 * the old month as the next close's suggestion), so every surface and every
 * period search reads it through here.
 */
export function closingOf(project: { status?: ProjectStatus | string | null; endedOn?: string | null }): string | null {
  return isProjectClosed(project) ? (project.endedOn ?? null) : null
}

/**
 * Where a project stands, as every surface that shows or moves its lifecycle
 * reads it: the status card, the close dialog, the banner. Isomorphic: the
 * server builds it from the row, the browser renders it.
 */
export interface ProjectLifecycleView {
  status: ProjectStatus
  /** ISO timestamp; set while paused. */
  pausedAt: string | null
  /** ISO timestamp; set while closed. */
  closedAt: string | null
  /** How it ended; set while closed. */
  closedOutcome: ProjectOutcome | null
  /** The outcome a close offers: what an earlier close said, kept across a reopen; null means none yet. */
  suggestedOutcome: ProjectOutcome | null
  /** The Abschluss month; set while closed. */
  endedOn: Month | null
  /** The Beginn month, which an Abschluss may not precede. */
  startedOn: Month | null
  /**
   * The month a close offers: the Abschluss an earlier close left behind, when
   * it still fits after the Beginn; null means this month.
   */
  suggestedEndedOn: Month | null
}

type LifecycleRow = {
  status: ProjectStatus
  pausedAt: Date | string | null
  closedAt: Date | string | null
  closedOutcome: ProjectOutcome | null
  startedOn: string | null
  endedOn: string | null
}

const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null)

export function lifecycleViewOf(project: LifecycleRow): ProjectLifecycleView {
  const startedOn = dateToMonth(project.startedOn)
  const stored = dateToMonth(project.endedOn)
  return {
    status: project.status,
    pausedAt: iso(project.pausedAt),
    closedAt: iso(project.closedAt),
    closedOutcome: isProjectClosed(project) ? project.closedOutcome : null,
    suggestedOutcome: project.closedOutcome,
    endedOn: dateToMonth(closingOf(project)),
    startedOn,
    suggestedEndedOn: stored && isOrderedPeriod(startedOn, stored) ? stored : null,
  }
}

/**
 * The months a close may name as the Abschluss: from the Beginn to this month.
 * When the Beginn lies ahead, a commission that ends before it starts (a
 * competition not won, say) ends in the Beginn's month, the one month that is
 * neither before it nor invented.
 */
export function closingBounds(startedOn: Month | null, thisMonth: Month): { min: Month | null; max: Month } {
  return { min: startedOn, max: startedOn && startedOn > thisMonth ? startedOn : thisMonth }
}

/** Why a month cannot be a close's Abschluss, or null: it must be a month within `closingBounds`. */
export function closingProblem(
  endedOn: string,
  startedOn: Month | null,
  thisMonth: Month
): 'invalid' | 'future' | 'beforeStart' | null {
  if (!isMonth(endedOn)) return 'invalid'
  const { min, max } = closingBounds(startedOn, thisMonth)
  if (endedOn > max) return 'future'
  if (min && endedOn < min) return 'beforeStart'
  return null
}

/** The month a close offers first: an earlier close's, when it still fits, else the latest allowed. */
export function defaultClosing(suggested: Month | null, startedOn: Month | null, thisMonth: Month): Month {
  const { min, max } = closingBounds(startedOn, thisMonth)
  if (suggested && suggested <= max && (!min || suggested >= min)) return suggested
  return max
}

/**
 * What a scheduled run skipped because its project was not active records as
 * its `error`. Resuming or reopening reads it back to re-arm the one-shots
 * those skips retired (`rearmOneShotsSkippedWhileParked`).
 */
export const SCHEDULE_SKIPPED_BECAUSE = { paused: 'Project is paused', closed: 'Project is closed' } as const

/** Whether a project's schedules fire: only an active one's. Paused and closed record a skipped run, so resuming resumes them. */
export function runsOnSchedule(project: { status?: ProjectStatus | string | null } | null | undefined): boolean {
  return project?.status === 'active'
}

/** The machine-readable reason a write into a closed project is refused. */
export const PROJECT_CLOSED_REASON = 'project-closed'

/**
 * What a closed project still allows whoever holds it. Reading, chatting, and
 * managing who is a member (offboarding someone stays possible). Deep research
 * and tasks (`project:documents:generate`, `project:skills:manage`) are refused:
 * both file into the project or run on a schedule as if it were live.
 * `project:manage` is refused too, because it also changes folder access, the
 * name and the Papierkorb; reopening asks it with `evenWhenClosed`.
 */
export const CLOSED_PROJECT_KEEPS: ReadonlySet<ProjectPermission> = new Set<ProjectPermission>([
  'project:view',
  'project:chat',
  'project:members:manage',
])

/** What every member of the organization holds on a closed project, member of it or not. */
export const CLOSED_PROJECT_OPEN_TO_ORGANIZATION: ReadonlySet<ProjectPermission> = new Set<ProjectPermission>([
  'project:view',
  'project:chat',
])

export function isProjectClosed(project: { status?: ProjectStatus | string | null } | null | undefined): boolean {
  return project?.status === 'closed'
}

/** The permissions of `accepted` a closed project still allows. Empty: the request is a write. */
export function keptWhenClosed(accepted: readonly ProjectPermission[]): ProjectPermission[] {
  return accepted.filter((permission) => CLOSED_PROJECT_KEEPS.has(permission))
}

/** Whether every one of `accepted` is open to every member of the organization on a closed project. */
export function openToOrganizationWhenClosed(accepted: readonly ProjectPermission[]): boolean {
  return accepted.length > 0 && accepted.every((permission) => CLOSED_PROJECT_OPEN_TO_ORGANIZATION.has(permission))
}

/** The refusal of a write into a closed project. Says so: everyone in the organization may see the project exists. */
export function projectClosedError(): ForbiddenError {
  return new ForbiddenError('This project is closed and can only be read. Reopen it to change it.', {
    reason: PROJECT_CLOSED_REASON,
  })
}

/** Whether `error` is the refusal of a write into a closed project. */
export function isProjectClosedError(error: unknown): boolean {
  if (!(error instanceof ForbiddenError)) return false
  const details = error.details as { reason?: unknown } | undefined
  return details?.reason === PROJECT_CLOSED_REASON
}

/** Whether a response body is the refusal of a write into a closed project (`details.reason`). */
export function isProjectClosedBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const details = (body as { details?: unknown }).details
  return !!details && typeof details === 'object' && (details as { reason?: unknown }).reason === PROJECT_CLOSED_REASON
}

/** The SQLSTATE the database's backstop raises for an insert into a closed project (migration 0116). */
export const PROJECT_CLOSED_SQLSTATE = 'GPC01'
