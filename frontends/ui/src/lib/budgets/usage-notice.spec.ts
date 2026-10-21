/**
 * @vitest-environment node
 */
/**
 * The usage notice picks ONE window out of every limited window that applies,
 * at one of four levels. These cases pin the thresholds, the choice between
 * windows, and the month-pace forecast, against a fixed clock.
 */
import { describe, expect, it } from 'vitest'
import { decideUsageNotice, projectedRunOut, utcWindow, type WindowUtilisation } from './usage-notice'

/** 21 October 2026, 12:00 UTC: 20.5 days into a 31-day month. */
const NOW = new Date('2026-10-21T12:00:00Z')

const usage = (over: Partial<WindowUtilisation>): WindowUtilisation => ({
  scope: 'organization',
  subjectId: null,
  unit: 'credit',
  window: 'month',
  limit: 1000,
  used: 0,
  ...over,
})

describe('utcWindow', () => {
  it('names the day and the month and when each renews', () => {
    expect(utcWindow('day', NOW)).toEqual({
      id: '2026-10-21',
      startsAt: Date.parse('2026-10-21T00:00:00Z'),
      endsAt: Date.parse('2026-10-22T00:00:00Z'),
    })
    expect(utcWindow('month', NOW)).toEqual({
      id: '2026-10',
      startsAt: Date.parse('2026-10-01T00:00:00Z'),
      endsAt: Date.parse('2026-11-01T00:00:00Z'),
    })
  })

  it('rolls a December month over into January', () => {
    expect(utcWindow('month', new Date('2026-12-31T23:00:00Z')).endsAt).toBe(Date.parse('2027-01-01T00:00:00Z'))
  })
})

describe('decideUsageNotice: levels', () => {
  it('says nothing below every line', () => {
    expect(decideUsageNotice([usage({ used: 400 }), usage({ window: 'day', limit: 100, used: 79 })], NOW)).toBeNull()
  })

  it.each([
    [800, 'warning', 80],
    [949, 'warning', 94],
    [950, 'critical', 95],
    [999, 'critical', 99],
    [1000, 'exhausted', 100],
    [1300, 'exhausted', 100],
  ] as const)('%s of 1000 is %s at %s %%', (used, level, percent) => {
    const notice = decideUsageNotice([usage({ window: 'day', used })], NOW)
    expect(notice).toMatchObject({ level, percent })
  })

  it('treats a zero limit as spent', () => {
    expect(decideUsageNotice([usage({ window: 'day', limit: 0, used: 0 })], NOW)).toMatchObject({
      level: 'exhausted',
      percent: 100,
    })
  })

  it('floors the percentage, so 100 is only ever shown for a spent window', () => {
    expect(decideUsageNotice([usage({ window: 'day', used: 999.9 })], NOW)?.percent).toBe(99)
  })

  it('carries the window identity and renewal', () => {
    expect(decideUsageNotice([usage({ window: 'day', used: 900 })], NOW)).toMatchObject({
      windowId: '2026-10-21',
      resetsAt: '2026-10-22T00:00:00.000Z',
    })
  })
})

describe('decideUsageNotice: which window', () => {
  it('prefers the higher level over the fuller window', () => {
    const notice = decideUsageNotice(
      [usage({ scope: 'member', subjectId: 'u1', window: 'day', limit: 10, used: 9.6 }), usage({ used: 1000 })],
      NOW,
    )
    expect(notice).toMatchObject({ level: 'exhausted', scope: 'organization' })
  })

  it('among exhausted windows, names the one that renews last', () => {
    const notice = decideUsageNotice(
      [usage({ window: 'day', limit: 10, used: 50 }), usage({ scope: 'project', subjectId: 'p1', used: 1000 })],
      NOW,
    )
    expect(notice).toMatchObject({ scope: 'project', window: 'month' })
  })

  it('at the same level, names the fuller window', () => {
    const notice = decideUsageNotice(
      [usage({ window: 'day', limit: 100, used: 82 }), usage({ scope: 'member', subjectId: 'u1', used: 870 })],
      NOW,
    )
    expect(notice).toMatchObject({ scope: 'member', percent: 87 })
  })
})

describe('projectedRunOut and the forecast level', () => {
  it('forecasts a half-used month that runs out well before it renews', () => {
    // 700 of 1000 after 20.5 days reaches the limit after 29.3 days: 30 October,
    // more than a day before 1 November.
    const runsOut = projectedRunOut(usage({ used: 700 }), NOW)
    expect(runsOut?.toISOString().slice(0, 10)).toBe('2026-10-30')
    expect(decideUsageNotice([usage({ used: 700 })], NOW)).toMatchObject({
      level: 'forecast',
      runsOutAt: runsOut?.toISOString(),
    })
  })

  it('does not forecast a month on pace to last', () => {
    expect(projectedRunOut(usage({ used: 600 }), NOW)).toBeNull()
    expect(decideUsageNotice([usage({ used: 600 })], NOW)).toBeNull()
  })

  it('does not forecast below half, however fast the pace', () => {
    const early = new Date('2026-10-03T00:00:00Z')
    expect(projectedRunOut(usage({ used: 490 }), early)).toBeNull()
  })

  it('does not forecast a run-out less than a day before renewal', () => {
    // 680 after 20.5 days runs out on 31 Oct ~ 05:00: within the last day.
    expect(projectedRunOut(usage({ used: 680 }), NOW)).toBeNull()
  })

  it('never forecasts a day', () => {
    expect(projectedRunOut(usage({ window: 'day', limit: 100, used: 70 }), new Date('2026-10-21T01:00:00Z'))).toBeNull()
  })

  it('keeps the forecast on a warning, so the copy can say when it runs out', () => {
    expect(decideUsageNotice([usage({ used: 850 })], NOW)).toMatchObject({ level: 'warning' })
    expect(decideUsageNotice([usage({ used: 850 })], NOW)?.runsOutAt).not.toBeNull()
  })

  it('among forecasts, names the window that runs out first', () => {
    const notice = decideUsageNotice(
      [usage({ used: 700 }), usage({ scope: 'member', subjectId: 'u1', limit: 100, used: 75 })],
      NOW,
    )
    expect(notice).toMatchObject({ scope: 'member' })
  })
})
