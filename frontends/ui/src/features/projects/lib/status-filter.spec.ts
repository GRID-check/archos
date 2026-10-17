/**
 * The projects list's status filter (ADR-0098): one segment per state, opening
 * on the active projects unless there are none.
 */
import { describe, expect, it } from 'vitest'
import { countByStatus, defaultProjectStatusFilter, filterProjectsByStatus, isProjectStatusFilter } from './status-filter'

const projects = [{ status: 'active' as const }, { status: 'paused' as const }, { status: 'closed' as const }, { status: 'closed' as const }]

describe('the status filter', () => {
  it('filters each state to itself, and all to everything', () => {
    expect(filterProjectsByStatus(projects, 'active')).toHaveLength(1)
    expect(filterProjectsByStatus(projects, 'paused')).toHaveLength(1)
    expect(filterProjectsByStatus(projects, 'closed')).toHaveLength(2)
    expect(filterProjectsByStatus(projects, 'all')).toHaveLength(4)
  })

  it('counts every state', () => {
    expect(countByStatus(projects)).toEqual({ active: 1, paused: 1, closed: 2, all: 4 })
  })

  it('opens on the active projects, or on all of them when none is active: a paused one does not count', () => {
    expect(defaultProjectStatusFilter(projects)).toBe('active')
    expect(defaultProjectStatusFilter([{ status: 'paused' }, { status: 'closed' }])).toBe('all')
  })

  it('knows its own segments', () => {
    expect(isProjectStatusFilter('paused')).toBe(true)
    expect(isProjectStatusFilter('archived')).toBe(false)
  })
})
