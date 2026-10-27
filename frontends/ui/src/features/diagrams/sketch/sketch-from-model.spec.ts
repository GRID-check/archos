import { describe, expect, it } from 'vitest'
import type { FlowModel, MapModel } from '../model'
import { isSketchable, labelBox, sketchFromModel, SKETCH_FONT_FAMILY, type SketchArrow, type SketchShape } from './sketch-from-model'

const flow: FlowModel = {
  kind: 'flow',
  direction: 'down',
  nodes: [
    { id: 'A', label: 'Einreichung', shape: 'step' },
    { id: 'B', label: 'Unterlagen vollständig?', shape: 'decision' },
    { id: 'C', label: 'Baubewilligung', shape: 'end' },
  ],
  edges: [
    { id: 'e1', from: 'A', to: 'B' },
    { id: 'e2', from: 'B', to: 'C', label: 'ja' },
    { id: 'e3', from: 'B', to: 'A', label: 'nein', dashed: true },
  ],
}

const shapes = (elements: ReturnType<typeof sketchFromModel>) =>
  elements.filter((element): element is SketchShape => element.type !== 'arrow')
const arrows = (elements: ReturnType<typeof sketchFromModel>) =>
  elements.filter((element): element is SketchArrow => element.type === 'arrow')

describe('sketchFromModel', () => {
  it('draws one shape per node, in the shape the view gives it, labelled in Helvetica', () => {
    const drawn = shapes(sketchFromModel(flow))
    expect(drawn.map((shape) => [shape.id, shape.type, shape.label?.text])).toEqual([
      ['n:A', 'rectangle', 'Einreichung'],
      ['n:B', 'diamond', 'Unterlagen vollständig?'],
      ['n:C', 'ellipse', 'Baubewilligung'],
    ])
    for (const shape of drawn) expect(shape.label?.fontFamily).toBe(SKETCH_FONT_FAMILY)
  })

  it('binds every arrow to the shapes it joins and keeps its label and its dash', () => {
    const drawn = arrows(sketchFromModel(flow))
    expect(drawn.map((arrow) => [arrow.start.id, arrow.end.id, arrow.label?.text ?? null, arrow.strokeStyle])).toEqual([
      ['n:A', 'n:B', null, 'solid'],
      ['n:B', 'n:C', 'ja', 'solid'],
      ['n:B', 'n:A', 'nein', 'dashed'],
    ])
    for (const arrow of drawn) {
      expect(arrow.points[0]).toEqual([0, 0])
      expect(arrow.points.length).toBeGreaterThanOrEqual(2)
      expect(arrow.endArrowhead).toBe('arrow')
    }
  })

  it('lays a downward flow out top to bottom, as the view does', () => {
    const [a, b, c] = shapes(sketchFromModel(flow))
    expect(a.y).toBeLessThan(b.y)
    expect(b.y).toBeLessThan(c.y)
  })

  it('opens a Gliederung as a tree from its root to the right, without arrowheads', () => {
    const map: MapModel = {
      kind: 'map',
      root: {
        id: 'root',
        label: 'OIB-Richtlinie 2',
        children: [
          { id: 'root.0', label: 'Brandabschnitte', children: [] },
          { id: 'root.1', label: 'Fluchtwege', children: [{ id: 'root.1.0', label: 'Treppenhäuser', children: [] }] },
        ],
      },
    }
    const elements = sketchFromModel(map)
    const [root, first] = shapes(elements)
    expect(root.label?.text).toBe('OIB-Richtlinie 2')
    expect(root.x).toBeLessThan(first.x)
    expect(arrows(elements)).toHaveLength(3)
    for (const arrow of arrows(elements)) expect(arrow.endArrowhead).toBeNull()
  })

  it('carries no number from anywhere but the layout: sizes come from label length alone', () => {
    const short = labelBox('A')
    const long = labelBox('Eine sehr lange Bezeichnung, die umbrechen muss, weil sie breiter ist als ein Kasten')
    expect(short.width).toBeGreaterThanOrEqual(120)
    expect(long.width).toBeLessThanOrEqual(240)
    expect(long.height).toBeGreaterThan(short.height)
  })

  it('drops an edge to a node the model does not have, rather than an unbound arrow', () => {
    const broken: FlowModel = { ...flow, edges: [{ id: 'x', from: 'A', to: 'Z' }] }
    expect(arrows(sketchFromModel(broken))).toEqual([])
  })

  it('has nothing to draw for an empty graph', () => {
    expect(sketchFromModel({ kind: 'flow', direction: 'down', nodes: [], edges: [] })).toEqual([])
  })
})

describe('isSketchable', () => {
  it('is true for the two node graphs only', () => {
    expect(isSketchable({ kind: 'flow' })).toBe(true)
    expect(isSketchable({ kind: 'map' })).toBe(true)
    expect(isSketchable({ kind: 'handoff' })).toBe(false)
    expect(isSketchable({ kind: 'schedule' })).toBe(false)
    expect(isSketchable({ kind: 'shares' })).toBe(false)
    expect(isSketchable(null)).toBe(false)
  })
})
