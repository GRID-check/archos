import { describe, expect, it } from 'vitest'
import { declutterLabels, type LabelBox } from './declutter'

const box = (left: number, top: number, width = 60, height = 12, movable = true): LabelBox => ({
  left,
  right: left + width,
  top,
  bottom: top + height,
  movable,
})

const BOUNDS = { left: 0, right: 300 }

describe('declutterLabels', () => {
  it('leaves labels that do not touch where they are', () => {
    const nudges = declutterLabels([box(10, 10), box(10, 40), box(120, 10)], BOUNDS)
    expect(nudges).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ])
  })

  it('moves the lower of two overprinted labels down until they clear', () => {
    // „GK4-Grenze" over „+11 m": same column, 5px of overlap.
    const upper = box(100, 20)
    const lower = box(100, 27)
    const [first, second] = declutterLabels([upper, lower], BOUNDS)
    expect(first).toEqual({ dx: 0, dy: 0 })
    expect(second.dx).toBe(0)
    expect(lower.top + second.dy).toBeGreaterThanOrEqual(upper.bottom)
  })

  it('does not move a label sideways to resolve a collision', () => {
    const nudges = declutterLabels([box(100, 20), box(110, 24)], BOUNDS)
    expect(nudges.every(({ dx }) => dx === 0)).toBe(true)
  })

  it('moves the upper label up when the lower one is fixed (a rotated label)', () => {
    const upper = box(100, 20)
    const lower = box(100, 28, 60, 12, false)
    const [first, second] = declutterLabels([upper, lower], BOUNDS)
    expect(second).toEqual({ dx: 0, dy: 0 })
    expect(first.dy).toBeLessThan(0)
    expect(upper.bottom + first.dy).toBeLessThanOrEqual(lower.top)
  })

  it('leaves two fixed labels alone', () => {
    const nudges = declutterLabels([box(100, 20, 60, 12, false), box(100, 24, 60, 12, false)], BOUNDS)
    expect(nudges).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ])
  })

  it('slides a label cut by the left edge back inside it („Ungünstigster Punkt")', () => {
    const [nudge] = declutterLabels([box(-5, 50, 100)], BOUNDS)
    expect(nudge.dx).toBe(5)
  })

  it('slides a label cut by the right edge back inside it', () => {
    const [nudge] = declutterLabels([box(250, 50, 100)], BOUNDS)
    expect(nudge.dx).toBe(-50)
  })

  it('does not move a label wider than the drawing', () => {
    const [nudge] = declutterLabels([box(-5, 50, 400)], BOUNDS)
    expect(nudge.dx).toBe(0)
  })

  it('stops after maxShift so a label stays beside the mark it names', () => {
    const boxes = [box(100, 0), box(100, 2), box(100, 4), box(100, 6), box(100, 8), box(100, 10)]
    const nudges = declutterLabels(boxes, BOUNDS, { maxShift: 14 })
    expect(Math.max(...nudges.map(({ dy }) => Math.abs(dy)))).toBeLessThanOrEqual(14)
  })
})
