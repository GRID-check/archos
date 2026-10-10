/**
 * The lifecycle's pure rule (ADR-0098): the moves it has, and which states run
 * schedules and carry an Abschluss.
 */
import { describe, expect, it } from 'vitest'
import {
  abschlussBounds,
  abschlussOf,
  defaultAbschluss,
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

  it('bounds the Abschluss by the Beginn and this month, and by the Beginn alone when it lies ahead', () => {
    expect(abschlussBounds('2023-04', '2026-10')).toEqual({ min: '2023-04', max: '2026-10' })
    expect(abschlussBounds(null, '2026-10')).toEqual({ min: null, max: '2026-10' })
    // A competition not won before its commission would have started: the Beginn's month is the one that fits.
    expect(abschlussBounds('2027-03', '2026-10')).toEqual({ min: '2027-03', max: '2027-03' })
  })

  it('offers an earlier close\'s month only while it still fits', () => {
    expect(defaultAbschluss('2025-06', '2023-04', '2026-10')).toBe('2025-06')
    expect(defaultAbschluss(null, '2023-04', '2026-10')).toBe('2026-10')
    expect(defaultAbschluss('2026-12', '2023-04', '2026-10')).toBe('2026-10')
    expect(defaultAbschluss(null, '2027-03', '2026-10')).toBe('2027-03')
  })

  it('reads an Abschluss only once the project is closed', () => {
    const at = (status: ProjectStatus) => abschlussOf({ status, endedOn: '2024-06-01' })
    expect(at('closed')).toBe('2024-06-01')
    expect(at('active')).toBeNull()
    expect(at('paused')).toBeNull()
  })
})
