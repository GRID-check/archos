/**
 * Where a mark's pin stands: its stored point in this viewer's frame, else
 * the centre of its elements, projected each frame and hidden off screen.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifyFrame, onFrameOf, pinPoints, placePins, unionCentre } from './viewpoint-pins'

const SIZE = { width: 800, height: 600 }

function layerWith(ids: string[]): HTMLDivElement {
  const layer = document.createElement('div')
  for (const id of ids) {
    const node = document.createElement('div')
    node.dataset.pinId = id
    node.style.visibility = 'hidden'
    layer.appendChild(node)
  }
  return layer
}

const child = (layer: HTMLElement, id: string): HTMLElement => {
  const node = layer.querySelector<HTMLElement>(`[data-pin-id="${id}"]`)
  if (!node) throw new Error(`no pin ${id}`)
  return node
}

describe('unionCentre', () => {
  it('is the middle of the boxes together, not the mean of their centres', () => {
    expect(
      unionCentre([
        { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } },
        { min: { x: 8, y: 0, z: 0 }, max: { x: 10, y: 4, z: 2 } },
        { min: { x: 9, y: 0, z: 0 }, max: { x: 10, y: 4, z: 2 } },
      ])
    ).toEqual({ x: 5, y: 2, z: 1 })
  })

  it('is nothing for no boxes', () => {
    expect(unionCentre([])).toBeNull()
  })
})

describe('pinPoints', () => {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 6, z: 2 } }

  it('puts a stored point into the render frame: Z-up world to Y-up, minus the offset', () => {
    const points = pinPoints(
      [{ id: 'm1', world: { x: 2683010, y: 1245020, z: 3 }, globalIds: ['ignored'] }],
      { wasmRtcOffset: { x: 2683000, y: 1245000, z: 0 } },
      () => box
    )
    expect(points.get('m1')).toEqual({ x: 10, y: 3, z: -20 })
  })

  it('stands on the centre of the elements when no point was stored', () => {
    const points = pinPoints([{ id: 'm2', world: null, globalIds: ['a', 'missing'] }], null, (id) => (id === 'a' ? box : null))
    expect(points.get('m2')).toEqual({ x: 2, y: 3, z: 1 })
  })

  it('leaves out a pin with neither', () => {
    expect(pinPoints([{ id: 'm3', world: null, globalIds: ['missing'] }], null, () => null).has('m3')).toBe(false)
  })
})

describe('placePins', () => {
  it('moves each pin to its projected point', () => {
    const layer = layerWith(['m1'])
    placePins(layer, new Map([['m1', { x: 1, y: 2, z: 3 }]]), (p) => ({ x: p.x * 100 + 0.04, y: p.y * 100 }), SIZE)
    expect(child(layer, 'm1').style.visibility).toBe('visible')
    expect(child(layer, 'm1').style.transform).toBe('translate(100px, 200px)')
  })

  it('hides a pin behind the camera, off the canvas, or without a point, rather than pinning it to an edge', () => {
    const layer = layerWith(['behind', 'outside', 'unknown'])
    placePins(
      layer,
      new Map([
        ['behind', { x: 0, y: 0, z: 0 }],
        ['outside', { x: 1, y: 0, z: 0 }],
      ]),
      (p) => (p.x === 0 ? null : { x: 900, y: 10 }),
      SIZE
    )
    for (const id of ['behind', 'outside', 'unknown']) expect(child(layer, id).style.visibility).toBe('hidden')
  })
})

describe('the frame hook', () => {
  afterEach(() => vi.restoreAllMocks())

  it('calls the listener of that canvas each frame, and no more once it is gone', () => {
    const canvas = {}
    const listener = vi.fn()
    const off = onFrameOf(canvas, listener)
    const project = () => null
    notifyFrame(canvas, project, SIZE)
    notifyFrame({}, project, SIZE)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(project, SIZE)
    off()
    notifyFrame(canvas, project, SIZE)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
