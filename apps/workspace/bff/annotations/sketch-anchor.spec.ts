import { describe, expect, it } from 'vitest'
import {
  elementBounds,
  elementRegion,
  paddedFrame,
  presentIds,
  regionInFrame,
  sheetFrame,
  viewBoxOf,
  type AnchorElement,
} from './sketch-anchor'

const rect = (id: string, x: number, y: number, width: number, height: number, extra: Partial<AnchorElement> = {}): AnchorElement => ({
  id,
  x,
  y,
  width,
  height,
  ...extra,
})

describe('elementBounds', () => {
  it('reads a rectangle as its corners', () => {
    expect(elementBounds(rect('a', 10, 20, 100, 50))).toEqual([10, 20, 110, 70])
  })

  it('turns a rotated rectangle about its centre', () => {
    const [left, top, right, bottom] = elementBounds(rect('a', 0, 0, 100, 20, { angle: Math.PI / 2 }))!
    expect(left).toBeCloseTo(40)
    expect(top).toBeCloseTo(-40)
    expect(right).toBeCloseTo(60)
    expect(bottom).toBeCloseTo(60)
  })

  it('reads an arrow by its points, not its width', () => {
    const arrow: AnchorElement = { id: 'r', x: 50, y: 50, width: 0, height: 0, points: [[0, 0], [100, -30], [120, 40]] }
    expect(elementBounds(arrow)).toEqual([50, 20, 170, 90])
  })

  it('draws nothing for a deleted element', () => {
    expect(elementBounds(rect('a', 0, 0, 10, 10, { isDeleted: true }))).toBeNull()
  })
})

describe('the sheet', () => {
  const scene = { elements: [rect('a', 100, 100, 200, 100), rect('b', 400, 300, 100, 100)] }

  it('reads the padding off the viewBox', () => {
    // Bounds 100..500 x 100..400; exported with 16 on each side: 432 x 332.
    expect(sheetFrame(scene.elements, { width: 432, height: 332 })).toEqual({ left: 84, top: 84, width: 432, height: 332 })
    expect(paddedFrame(scene.elements)).toEqual({ left: 84, top: 84, width: 432, height: 332 })
  })

  it('places one element as its share of the sheet', () => {
    const region = elementRegion(scene, ['a'], { width: 432, height: 332 })!
    expect(region.x).toBeCloseTo(16 / 432)
    expect(region.y).toBeCloseTo(16 / 332)
    expect(region.w).toBeCloseTo(200 / 432)
    expect(region.h).toBeCloseTo(100 / 332)
  })

  it('unites several elements into one box', () => {
    const region = elementRegion(scene, ['a', 'b'], { width: 432, height: 332 })!
    expect(region.x + region.w).toBeCloseTo(416 / 432)
    expect(region.y + region.h).toBeCloseTo(316 / 332)
  })

  it('keeps a flat line a box, and on the sheet', () => {
    const line: AnchorElement = { id: 'l', x: 0, y: 0, points: [[0, 0], [100, 0]] }
    const frame = paddedFrame([line])!
    const region = regionInFrame([line], ['l'], frame)!
    expect(region.h).toBeGreaterThan(0)
    expect(region.y + region.h).toBeLessThanOrEqual(1)
  })

  it('answers null when every element named is gone', () => {
    expect(elementRegion(scene, ['gone'], { width: 432, height: 332 })).toBeNull()
    expect(
      elementRegion({ elements: [rect('a', 0, 0, 1, 1, { isDeleted: true })] }, ['a'], { width: 33, height: 33 })
    ).toBeNull()
  })

  it('says which of the ids the scene still draws', () => {
    expect(presentIds([...scene.elements, rect('c', 0, 0, 1, 1, { isDeleted: true })], ['c', 'b', 'x'])).toEqual(['b'])
  })
})

describe('viewBoxOf', () => {
  it('reads the root viewBox', () => {
    expect(viewBoxOf('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 432 332.5"><g/></svg>')).toEqual({
      width: 432,
      height: 332.5,
    })
  })

  it('is null without one', () => {
    expect(viewBoxOf('<svg width="10" height="10"></svg>')).toBeNull()
  })
})
