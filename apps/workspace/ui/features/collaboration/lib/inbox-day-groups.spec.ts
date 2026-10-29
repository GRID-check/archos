import { describe, expect, it } from 'vitest'

import { dayGroupOf, inboxSections } from './inbox-day-groups'

// A Thursday afternoon, local time.
const NOW = new Date(2026, 9, 29, 15, 0)
const at = (day: number, hour = 9): string => new Date(2026, 9, day, hour).toISOString()

describe('dayGroupOf', () => {
  it('reads the reader’s calendar days, not 24-hour spans', () => {
    expect(dayGroupOf(at(29, 0), NOW)).toBe('today')
    expect(dayGroupOf(at(28, 23), NOW)).toBe('yesterday')
    expect(dayGroupOf(at(28, 0), NOW)).toBe('yesterday')
    expect(dayGroupOf(at(23), NOW)).toBe('week')
    expect(dayGroupOf(at(22), NOW)).toBe('older')
  })

  it('takes a moment from a skewed clock, or none it can read, as today', () => {
    expect(dayGroupOf(at(30), NOW)).toBe('today')
    expect(dayGroupOf('not a date', NOW)).toBe('today')
  })
})

describe('inboxSections', () => {
  it('cuts the given order where the span changes, without reordering', () => {
    const rows = [{ id: 'a', updatedAt: at(29) }, { id: 'b', updatedAt: at(29, 1) }, { id: 'c', updatedAt: at(27) }, { id: 'd', updatedAt: at(1) }]
    expect(inboxSections(rows, NOW).map((s) => [s.group, s.items.map((r) => r.id)])).toEqual([
      ['today', ['a', 'b']],
      ['week', ['c']],
      ['older', ['d']],
    ])
  })

  it('opens a new section for a row out of order rather than moving it', () => {
    const rows = [{ id: 'a', updatedAt: at(29) }, { id: 'b', updatedAt: at(1) }, { id: 'c', updatedAt: at(29) }]
    expect(inboxSections(rows, NOW).map((s) => s.group)).toEqual(['today', 'older', 'today'])
  })
})
