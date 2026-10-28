/**
 * A drawing Piloti made, as the starting scene of a sketch the person edits.
 *
 * ## Why this exists rather than `@excalidraw/mermaid-to-excalidraw`
 *
 * Excalidraw publishes its own converter, and it is the obvious buy. It was
 * read and not taken, for two measured reasons (2026-10-27):
 *
 *   - it depends on `mermaid ^11.12.1` while this product runs mermaid 12, so
 *     it would ship a SECOND mermaid next to the one that already parsed the
 *     fence;
 *   - it parses the SOURCE again and lays it out with mermaid's own layout,
 *     so the sketch would open in a different arrangement from the drawing the
 *     person just looked at. "I clicked edit and it moved" is the defect.
 *
 * The models in `../model.ts` are already the parsed diagram, and dagre (a
 * dependency of the views) is already the layout. So this reads the model and
 * lays it out the way the view does, and hands Excalidraw *skeleton* elements:
 * its documented input format (`convertToExcalidrawElements`), which binds the
 * labels into their shapes and the arrows to their ends itself.
 *
 * ## What the scene claims, and what it must not
 *
 * Nothing dimensional. The coordinates below are a layout engine's choice, not
 * a measurement, and there are none from the source: a node's size comes from
 * its label's length. The doctrine (`lib/diagrams/diagram-sources.ts`) is a
 * rule about SUBJECT, and only flow and map models reach here, so the subject
 * is a Verfahren, a decision path or a Gliederung. A Lageplan never is.
 *
 * Pure: no Excalidraw import, no DOM. The editor converts the skeletons.
 */

import dagre from '@dagrejs/dagre'
import type { FlowModel, FlowNode, MapModel, MapNode } from '../model'

/** The two models whose drawing is a node graph, and so has a sketch. */
export type SketchableModel = FlowModel | MapModel

export function isSketchable(model: { kind: string } | null | undefined): model is SketchableModel {
  return model?.kind === 'flow' || model?.kind === 'map'
}

/**
 * Excalidraw's `FONT_FAMILY.Helvetica`. Its hand-drawn face (Excalifont) is a
 * webfont the filed SVG cannot carry without an inlined `<style>` (refused by
 * `lib/diagrams/svg.ts`) and the PDF cannot draw at all (`@react-pdf/renderer`
 * lands every family on Helvetica). Helvetica on the canvas is what keeps the
 * editor, the SVG and the PDF showing the same type.
 */
export const SKETCH_FONT_FAMILY = 2
export const SKETCH_FONT_SIZE = 16

/** Ink, close to Excalidraw's default and legible on its white canvas. */
const INK = '#1e1e1e'

const NODE_MIN_WIDTH = 120
const NODE_MAX_WIDTH = 240
/** One character of 16px Helvetica, on average, plus the shape's own inset. */
const CHAR_WIDTH = 8.4
const LINE_HEIGHT = SKETCH_FONT_SIZE * 1.25
const INSET = { x: 28, y: 24 }

/**
 * The subset of Excalidraw's `ExcalidrawElementSkeleton` this module writes.
 *
 * Its own type rather than Excalidraw's, so that a pure function nobody has to
 * download a 2.5 MB package for can be imported and tested anywhere. The
 * editor passes it to `convertToExcalidrawElements`, which accepts it as is.
 */
export type SketchSkeleton = SketchShape | SketchArrow

interface SketchCommon {
  id: string
  x: number
  y: number
  strokeColor: string
  strokeWidth: number
  roughness: number
}

export interface SketchShape extends SketchCommon {
  type: 'rectangle' | 'diamond' | 'ellipse'
  width: number
  height: number
  backgroundColor: string
  fillStyle: 'solid'
  roundness?: { type: 3 }
  label?: SketchLabel
}

export interface SketchArrow extends SketchCommon {
  type: 'arrow'
  points: [number, number][]
  start: { id: string }
  end: { id: string }
  strokeStyle: 'solid' | 'dashed'
  endArrowhead: 'arrow' | null
  label?: SketchLabel
}

interface SketchLabel {
  text: string
  fontFamily: number
  fontSize: number
  strokeColor: string
}

/** A label's box: as wide as its longest line up to the cap, one line taller per wrap. */
export function labelBox(label: string): { width: number; height: number } {
  const room = NODE_MAX_WIDTH - INSET.x
  let lines = 0
  let widest = 0
  for (const paragraph of label.split('\n')) {
    const width = paragraph.length * CHAR_WIDTH
    widest = Math.max(widest, Math.min(width, room))
    lines += Math.max(1, Math.ceil(width / room))
  }
  return {
    width: Math.round(Math.max(NODE_MIN_WIDTH, widest + INSET.x)),
    height: Math.round(lines * LINE_HEIGHT + INSET.y),
  }
}

interface GraphNode {
  id: string
  label: string
  shape: FlowNode['shape']
}

interface GraphEdge {
  id: string
  from: string
  to: string
  label?: string
  dashed?: boolean
}

interface Graph {
  direction: 'TB' | 'LR'
  nodes: GraphNode[]
  edges: GraphEdge[]
  arrows: boolean
}

function graphOf(model: SketchableModel): Graph {
  if (model.kind === 'flow') {
    return {
      direction: model.direction === 'right' ? 'LR' : 'TB',
      nodes: model.nodes,
      edges: model.edges,
      arrows: true,
    }
  }
  // A Gliederung reads from its root to the right, as the map view draws it,
  // and a tree has no direction to point an arrowhead in.
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const walk = (node: MapNode) => {
    nodes.push({ id: node.id, label: node.label, shape: 'step' })
    for (const child of node.children) {
      edges.push({ id: `${node.id}>${child.id}`, from: node.id, to: child.id })
      walk(child)
    }
  }
  walk(model.root)
  return { direction: 'LR', nodes, edges, arrows: false }
}

function nodeSize(node: GraphNode): { width: number; height: number } {
  if (node.shape === 'point') return { width: 20, height: 20 }
  const box = labelBox(node.label)
  // A diamond holds its label in its middle half; give it the room.
  return node.shape === 'decision' ? { width: Math.round(box.width * 1.4), height: Math.round(box.height * 1.6) } : box
}

/** Prefixed so an id from the source can never collide with one Excalidraw mints. */
const shapeId = (id: string) => `n:${id}`
const arrowId = (id: string) => `e:${id}`

function shapeFor(node: GraphNode, x: number, y: number, size: { width: number; height: number }): SketchShape {
  const common = {
    id: shapeId(node.id),
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height,
    strokeColor: INK,
    strokeWidth: 1,
    roughness: 1,
    fillStyle: 'solid' as const,
  }
  if (node.shape === 'point') return { ...common, type: 'ellipse', backgroundColor: INK }
  const label = { text: node.label, fontFamily: SKETCH_FONT_FAMILY, fontSize: SKETCH_FONT_SIZE, strokeColor: INK }
  if (node.shape === 'decision') return { ...common, type: 'diamond', backgroundColor: 'transparent', label }
  if (node.shape === 'end') return { ...common, type: 'ellipse', backgroundColor: 'transparent', label }
  return { ...common, type: 'rectangle', backgroundColor: 'transparent', roundness: { type: 3 }, label }
}

/**
 * The starting scene: one shape per node, one bound arrow per edge, laid out by
 * dagre with the same direction the view drew. Returns `[]` for an empty graph.
 */
export function sketchFromModel(model: SketchableModel): SketchSkeleton[] {
  const graph = graphOf(model)
  if (graph.nodes.length === 0) return []
  const layout = new dagre.graphlib.Graph({ multigraph: true })
  layout.setGraph({ rankdir: graph.direction, nodesep: 40, ranksep: 64, edgesep: 16, marginx: 0, marginy: 0 })
  layout.setDefaultEdgeLabel(() => ({}))
  const sizes = new Map(graph.nodes.map((node) => [node.id, nodeSize(node)]))
  for (const node of graph.nodes) layout.setNode(node.id, { ...sizes.get(node.id) })
  const known = new Set(graph.nodes.map((node) => node.id))
  const edges = graph.edges.filter((edge) => known.has(edge.from) && known.has(edge.to))
  for (const edge of edges) {
    const label = edge.label ? { ...labelBox(edge.label), labelpos: 'c' } : {}
    layout.setEdge(edge.from, edge.to, label, edge.id)
  }
  dagre.layout(layout)

  const elements: SketchSkeleton[] = []
  for (const node of graph.nodes) {
    const placed = layout.node(node.id)
    const size = sizes.get(node.id) ?? { width: NODE_MIN_WIDTH, height: 44 }
    elements.push(shapeFor(node, placed.x - size.width / 2, placed.y - size.height / 2, size))
  }
  for (const edge of edges) {
    const placed = layout.edge({ v: edge.from, w: edge.to, name: edge.id }) as { points?: { x: number; y: number }[] }
    const route = placed?.points ?? []
    if (route.length < 2) continue
    const [origin] = route
    elements.push({
      id: arrowId(edge.id),
      type: 'arrow',
      x: Math.round(origin.x),
      y: Math.round(origin.y),
      points: route.map((point) => [Math.round(point.x - origin.x), Math.round(point.y - origin.y)]),
      start: { id: shapeId(edge.from) },
      end: { id: shapeId(edge.to) },
      strokeColor: INK,
      strokeWidth: 1,
      roughness: 1,
      strokeStyle: edge.dashed ? 'dashed' : 'solid',
      endArrowhead: graph.arrows ? 'arrow' : null,
      ...(edge.label
        ? { label: { text: edge.label, fontFamily: SKETCH_FONT_FAMILY, fontSize: SKETCH_FONT_SIZE - 2, strokeColor: INK } }
        : {}),
    })
  }
  return elements
}
