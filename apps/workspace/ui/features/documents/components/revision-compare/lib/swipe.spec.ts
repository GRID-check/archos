/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { clampPercent, percentAlong, swipeKeyTarget } from './swipe'

describe('swipe divider math', () => {
  it('reads a pointer as a share of the track', () => {
    expect(percentAlong(150, { left: 100, width: 200 })).toBe(25)
    expect(percentAlong(50, { left: 100, width: 200 })).toBe(0)
    expect(percentAlong(900, { left: 100, width: 200 })).toBe(100)
    expect(percentAlong(10, { left: 0, width: 0 })).toBe(50)
  })

  it('clamps and survives garbage', () => {
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(140)).toBe(100)
    expect(clampPercent(Number.NaN)).toBe(50)
  })

  it('moves by 2%, by 10% with Shift, and to the edges', () => {
    expect(swipeKeyTarget(50, 'ArrowRight', false)).toBe(52)
    expect(swipeKeyTarget(50, 'ArrowLeft', true)).toBe(40)
    expect(swipeKeyTarget(99, 'ArrowRight', true)).toBe(100)
    expect(swipeKeyTarget(50, 'Home', false)).toBe(0)
    expect(swipeKeyTarget(50, 'End', false)).toBe(100)
    expect(swipeKeyTarget(50, 'a', false)).toBeNull()
  })
})
