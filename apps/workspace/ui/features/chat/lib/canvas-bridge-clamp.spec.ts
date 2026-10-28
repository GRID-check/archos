/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { clampFocusRegion } from './canvas-bridge'

describe('clampFocusRegion', () => {
  it('keeps a region on its page when rounding overshot the edge', () => {
    const region = clampFocusRegion({ page: 2, x: 0.8001, y: 0.25, w: 0.2, h: 0.75004, annotation_id: 'a' })

    expect(region.x + region.w).toBeLessThanOrEqual(1)
    expect(region.y + region.h).toBeLessThanOrEqual(1)
    expect(region).toMatchObject({ page: 2, annotation_id: 'a', y: 0.25 })
  })

  it('leaves a region that fits untouched', () => {
    expect(clampFocusRegion({ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
  })
})
