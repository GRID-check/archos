/**
 * The frame a renderer's model is drawn in, as the geometry stream reports it.
 */

import { describe, expect, it } from 'vitest'
import { frameOf, noteGeometryEvent } from './render-frame'

describe('the render frame', () => {
  it('is unknown until an event reports one', () => {
    const renderer = {}
    noteGeometryEvent(renderer, { type: 'batch' })
    expect(frameOf(renderer)).toBeNull()
  })

  it('keeps the latest offsets per renderer', () => {
    const one = {}
    const other = {}
    noteGeometryEvent(one, { type: 'start', coordinateInfo: { wasmRtcOffset: { x: 1, y: 2, z: 3 } } })
    noteGeometryEvent(one, { type: 'complete', coordinateInfo: { originShift: { x: 4, y: 5, z: 6 }, wasmRtcOffset: { x: 1, y: 2, z: 3 } } })
    expect(frameOf(one)).toEqual({ originShift: { x: 4, y: 5, z: 6 }, wasmRtcOffset: { x: 1, y: 2, z: 3 } })
    expect(frameOf(other)).toBeNull()
  })

  it('does not forget the frame on an event that reports none', () => {
    const renderer = {}
    noteGeometryEvent(renderer, { coordinateInfo: { wasmRtcOffset: { x: 1, y: 0, z: 0 } } })
    noteGeometryEvent(renderer, { type: 'batch', coordinateInfo: null })
    expect(frameOf(renderer)).toEqual({ originShift: null, wasmRtcOffset: { x: 1, y: 0, z: 0 } })
  })
})
