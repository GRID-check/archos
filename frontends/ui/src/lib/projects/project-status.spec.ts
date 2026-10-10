/**
 * The lifecycle's pure rule (ADR-0098): the moves it has, and which states run
 * schedules and carry an Abschluss.
 */
import { describe, expect, it } from 'vitest'
import {
  abschlussOf,
  canTransition,
  PROJECT_STATUSES,
  runsOnSchedule,
  statusesThatMayBecome,
  type ProjectStatus,
} from './project-status'

describe('the lifecycle', () => {
  it('has exactly these moves', () => {
    const moves = PROJECT_STATUSES.flatMap((from) =>
      PROJECT_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`)
    )
    expect(moves.sort()).toEqual(['active→closed', 'active→paused', 'closed→active', 'paused→active', 'paused→closed'])
  })

  it('never moves a state onto itself, and a closed project is only ever reopened', () => {
    for (const status of PROJECT_STATUSES) expect(canTransition(status, status)).toBe(false)
    expect(statusesThatMayBecome('paused')).toEqual(['active'])
    expect(statusesThatMayBecome('closed')).toEqual(['active', 'paused'])
  })

  it('runs schedules only in an active project', () => {
    expect(PROJECT_STATUSES.filter((status) => runsOnSchedule({ status }))).toEqual(['active'])
    expect(runsOnSchedule(null)).toBe(false)
  })

  it('reads an Abschluss only once the project is closed', () => {
    const at = (status: ProjectStatus) => abschlussOf({ status, endedOn: '2024-06-01' })
    expect(at('closed')).toBe('2024-06-01')
    expect(at('active')).toBeNull()
    expect(at('paused')).toBeNull()
  })
})
