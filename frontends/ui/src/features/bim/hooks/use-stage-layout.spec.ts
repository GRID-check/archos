/**
 * Which chrome a given piece of glass gets.
 *
 * The decision is a table, so it is tested as one. The media queries around it
 * are the browser's business; what this pins is the RULE — above all that a
 * phone on its side is NOT "wider than `sm`, therefore a desktop".
 */

import { describe, expect, it } from 'vitest'
import { PHONE_LANDSCAPE_QUERY, PHONE_QUERY, resolveStageLayout } from './use-stage-layout'

describe('resolveStageLayout', () => {
  it.each([
    [false, false, 'desktop'],
    [true, false, 'phone'],
    // 852 x 393: not narrow, but a finger, on its side, with no height.
    [false, true, 'phone-landscape'],
    // A short landscape viewport that is also narrow is still landscape: a
    // bottom sheet there would leave no building at all.
    [true, true, 'phone-landscape'],
  ] as const)('phone=%s landscape=%s -> %s', (phone, landscape, expected) => {
    expect(resolveStageLayout(phone, landscape)).toBe(expected)
  })

  it('asks "is this a finger on a short landscape screen", not "how wide is it"', () => {
    // A half-width desktop window has none of the three, and must keep the
    // desktop chrome.
    expect(PHONE_LANDSCAPE_QUERY).toContain('(pointer: coarse)')
    expect(PHONE_LANDSCAPE_QUERY).toContain('(orientation: landscape)')
    expect(PHONE_LANDSCAPE_QUERY).toMatch(/max-height/)
    expect(PHONE_QUERY).toBe('(max-width: 639px)')
  })
})
