/**
 * The elements a Skizze edit writes (`sketch-edit.ts`): Excalidraw scene
 * elements built from a fence skeleton, the boxes the relative operations
 * measure, and an arrow routed between the shapes it is bound to. Pure.
 *
 * A skeleton becomes the elements Excalidraw's `convertToExcalidrawElements`
 * would make of it: a shape, its label as a bound text (`containerId`, the
 * container's `boundElements`), an arrow with `startBinding`/`endBinding`, a
 * frame around its children. Only the fields the scene reads are written; the
 * server's render restores the rest (`restoreElements` in the worker) and lays
 * out every new text with the editor's metrics, so a width here is a first
 * guess that never reaches the file.
 */

import type { SceneSkeleton } from './sketch-fence'
import type { SceneElement } from './sketch-scene'

/** A scene element while an edit builds it: the fields the outline reads, the rest kept. */
export type EditElement = { -readonly [K in keyof SceneElement]: SceneElement[K] } & Record<string, unknown>

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const SHAPE_TYPES: ReadonlySet<string> = new Set(['rectangle', 'ellipse', 'diamond'])
export const CONNECTOR_TYPES: ReadonlySet<string> = new Set(['arrow', 'line'])

/** Every text Piloti writes is Helvetica at 16 (`sketch-fence.ts`). */
const FONT_FAMILY = 2
const FONT_SIZE = 16
const LINE_HEIGHT = 1.25
/** Excalidraw's `BOUND_TEXT_PADDING`. */
export const BOUND_TEXT_PADDING = 5
/** The gap Excalidraw keeps between a bound arrow's end and its shape. */
const ARROW_GAP = 4
/** Room a frame keeps around its children, as `convertToExcalidrawElements` does. */
const FRAME_PADDING = 20

const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** A first guess at a text's size: Helvetica averages about 0.55 em a character. The render measures it exactly. */
export function estimatedTextSize(text: string, fontSize = FONT_SIZE): { width: number; height: number } {
  const lines = text.split('\n')
  return {
    width: Math.max(...lines.map((line) => [...line].length)) * fontSize * 0.55,
    height: lines.length * fontSize * LINE_HEIGHT,
  }
}

/** The absolute points of a line or arrow. */
export function absolutePoints(element: EditElement): [number, number][] {
  const raw = Array.isArray(element.points) ? (element.points as unknown[]) : []
  return raw.flatMap((point) =>
    Array.isArray(point) && point.length >= 2 ? [[element.x + num(point[0]), element.y + num(point[1])] as [number, number]] : []
  )
}

/** An element's box on the sheet: its size, or a connector's points. Width and height may be negative on a flipped shape. */
export function boxOf(element: EditElement): Box {
  if (CONNECTOR_TYPES.has(element.type)) {
    const points = absolutePoints(element)
    if (points.length > 0) {
      const xs = points.map(([x]) => x)
      const ys = points.map(([, y]) => y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
  }
  const width = num(element.width)
  const height = num(element.height)
  return { x: Math.min(element.x, element.x + width), y: Math.min(element.y, element.y + height), w: Math.abs(width), h: Math.abs(height) }
}

const centre = (box: Box): [number, number] => [box.x + box.w / 2, box.y + box.h / 2]

/** The ids an element's `boundElements` names, of one kind or every kind. */
export function boundIds(element: EditElement, kind?: 'text' | 'arrow'): string[] {
  const bound = Array.isArray(element.boundElements) ? (element.boundElements as { id?: unknown; type?: unknown }[]) : []
  return bound.flatMap((entry) => (typeof entry?.id === 'string' && (!kind || entry.type === kind) ? [entry.id] : []))
}

/** `element.boundElements` with `{ type, id }` added once. */
export function addBound(element: EditElement, type: 'text' | 'arrow', id: string): void {
  const bound = Array.isArray(element.boundElements) ? (element.boundElements as { id: string; type: string }[]) : []
  if (bound.some((entry) => entry.id === id)) return
  element.boundElements = [...bound, { type, id }]
}

/** `element.boundElements` without the ids in `gone`. */
export function dropBound(element: EditElement, gone: ReadonlySet<string>): void {
  if (!Array.isArray(element.boundElements)) return
  const kept = (element.boundElements as { id: string }[]).filter((entry) => !gone.has(entry.id))
  if (kept.length !== element.boundElements.length) element.boundElements = kept
}

export interface ElementFactory {
  /** A fresh 31-bit integer (Excalidraw's `randomInteger`): seed and nonce. */
  nonce: () => number
  /** Whether an id is already used, in the sketch or by this edit. */
  taken: (id: string) => boolean
  now: number
}

function base(type: string, id: string, factory: ElementFactory, fields: Record<string, unknown>): EditElement {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: factory.nonce(),
    version: 1,
    versionNonce: factory.nonce(),
    isDeleted: false,
    boundElements: [],
    updated: factory.now,
    link: null,
    locked: false,
    ...fields,
  }
}

/** A free id derived from `stem`: `stem-label`, then `stem-label-2`, … */
export function freeId(stem: string, factory: ElementFactory): string {
  if (!factory.taken(stem)) return stem
  for (let n = 2; ; n++) if (!factory.taken(`${stem}-${n}`)) return `${stem}-${n}`
}

/** A text element: free on the sheet, or bound into `container` (placed in its middle; the render lays it out). */
export function textElement(
  id: string,
  text: string,
  factory: ElementFactory,
  options: { container?: EditElement; x?: number; y?: number; style?: Record<string, unknown> } = {}
): EditElement {
  const fontSize = num(options.style?.fontSize, FONT_SIZE)
  const { width, height } = estimatedTextSize(text, fontSize)
  const box = options.container ? boxOf(options.container) : null
  const [cx, cy] = box ? centre(box) : [0, 0]
  return base('text', id, factory, {
    x: box ? cx - width / 2 : num(options.x),
    y: box ? cy - height / 2 : num(options.y),
    width,
    height,
    boundElements: null,
    text,
    originalText: text,
    fontSize,
    fontFamily: FONT_FAMILY,
    textAlign: box ? 'center' : 'left',
    verticalAlign: box ? 'middle' : 'top',
    containerId: options.container?.id ?? null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
    ...Object.fromEntries(
      Object.entries(options.style ?? {}).filter(([key]) => ['strokeColor', 'textAlign', 'opacity', 'angle', 'customData'].includes(key))
    ),
  })
}

/**
 * The fields of a skeleton copied onto the element as they are (the fence kept
 * them to their ranges): its styles, and its link into the workspace.
 */
const STYLE_FIELDS = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'angle', 'roundness', 'customData'] as const

function styleOf(skeleton: SceneSkeleton): Record<string, unknown> {
  return Object.fromEntries(STYLE_FIELDS.filter((field) => skeleton[field] !== undefined).map((field) => [field, skeleton[field]]))
}

/** The default size of a shape: wide enough for its label, as `convertToExcalidrawElements` sizes an unsized one. */
function shapeSize(skeleton: SceneSkeleton): { width: number; height: number } {
  const label = (skeleton.label as { text?: string } | undefined)?.text
  const text = label ? estimatedTextSize(label) : { width: 0, height: 0 }
  return {
    width: num(skeleton.width, Math.max(160, text.width + 40)),
    height: num(skeleton.height, Math.max(80, text.height + 40)),
  }
}

/**
 * The elements a skeleton adds, its own first and its label after it, with
 * the bindings it names written on both sides. `live` is the scene as the edit
 * has built it so far; the elements a binding or a frame names are changed in
 * place there.
 */
export function elementsFromSkeleton(skeleton: SceneSkeleton, live: Map<string, EditElement>, factory: ElementFactory): EditElement[] {
  const id = String(skeleton.id)
  const style = styleOf(skeleton)
  if (skeleton.type === 'frame') return [frameElement(id, skeleton, live, factory)]
  if (skeleton.type === 'text') {
    return [textElement(id, String(skeleton.text), factory, { x: num(skeleton.x), y: num(skeleton.y), style: { ...style, fontSize: skeleton.fontSize, textAlign: skeleton.textAlign } })]
  }
  const own = CONNECTOR_TYPES.has(skeleton.type)
    ? connectorElement(id, skeleton, live, factory, style)
    : base(skeleton.type, id, factory, {
        x: num(skeleton.x),
        y: num(skeleton.y),
        ...shapeSize(skeleton),
        roundness: skeleton.type === 'ellipse' ? null : { type: 3 },
        ...style,
      })
  const label = skeleton.label as { text?: string; [field: string]: unknown } | undefined
  if (!label?.text) return [own]
  const text = textElement(freeId(`${id}-label`, factory), label.text, factory, { container: own, style: label })
  addBound(own, 'text', text.id)
  return [own, text]
}

function connectorElement(
  id: string,
  skeleton: SceneSkeleton,
  live: Map<string, EditElement>,
  factory: ElementFactory,
  style: Record<string, unknown>
): EditElement {
  const points = Array.isArray(skeleton.points) ? (skeleton.points as [number, number][]) : [[0, 0], [num(skeleton.width, 100), num(skeleton.height, 0)]]
  const arrow = base(skeleton.type, id, factory, {
    x: num(skeleton.x),
    y: num(skeleton.y),
    points: points.map(([x, y]) => [x, y]),
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: skeleton.type === 'arrow' ? (skeleton.startArrowhead ?? null) : null,
    endArrowhead: skeleton.type === 'arrow' ? (skeleton.endArrowhead === undefined ? 'arrow' : skeleton.endArrowhead) : null,
    elbowed: false,
    ...style,
  })
  for (const end of ['start', 'end'] as const) {
    const target = live.get(String((skeleton[end] as { id?: unknown } | undefined)?.id ?? ''))
    if (target) bindEnd(arrow, end, target)
  }
  routeConnector(arrow, live)
  return arrow
}

/** Bind one end of a connector to `target`, on both sides. */
export function bindEnd(connector: EditElement, end: 'start' | 'end', target: EditElement): void {
  const binding: Record<string, unknown> = { elementId: target.id, focus: 0, gap: ARROW_GAP }
  ;(connector as Record<string, unknown>)[`${end}Binding`] = binding
  addBound(target, 'arrow', connector.id)
}

function frameElement(id: string, skeleton: SceneSkeleton, live: Map<string, EditElement>, factory: ElementFactory): EditElement {
  const children = (skeleton.children as string[]).flatMap((child) => (live.get(child) ? [live.get(child) as EditElement] : []))
  const boxes = children.map(boxOf)
  const x = boxes.length ? Math.min(...boxes.map((box) => box.x)) - FRAME_PADDING : 0
  const y = boxes.length ? Math.min(...boxes.map((box) => box.y)) - FRAME_PADDING : 0
  const right = boxes.length ? Math.max(...boxes.map((box) => box.x + box.w)) + FRAME_PADDING : 200
  const bottom = boxes.length ? Math.max(...boxes.map((box) => box.y + box.h)) + FRAME_PADDING : 200
  for (const child of children) {
    child.frameId = id
    for (const text of boundIds(child, 'text')) {
      const label = live.get(text)
      if (label) label.frameId = id
    }
  }
  return base('frame', id, factory, { x, y, width: right - x, height: bottom - y, name: skeleton.name ?? null, boundElements: null })
}

/** Where a ray from a box's centre towards `toward` leaves the box, `gap` outside it. */
function edgePoint(box: Box, toward: [number, number], gap: number): [number, number] {
  const [cx, cy] = centre(box)
  const dx = toward[0] - cx
  const dy = toward[1] - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const scale = Math.min(dx === 0 ? Infinity : (box.w / 2 + gap) / Math.abs(dx), dy === 0 ? Infinity : (box.h / 2 + gap) / Math.abs(dy))
  return [cx + dx * Math.min(scale, 1), cy + dy * Math.min(scale, 1)]
}

/**
 * A connector's points drawn again between what it is bound to: a straight
 * segment from edge to edge, as Excalidraw draws a fresh binding. An unbound
 * end stays where it is; the editor's own routing takes over once a person
 * touches it. Its label moves with the segment's middle.
 */
export function routeConnector(connector: EditElement, live: Map<string, EditElement>): void {
  const points = absolutePoints(connector)
  if (points.length < 2) return
  const startTarget = live.get(String((connector.startBinding as { elementId?: unknown } | null)?.elementId ?? ''))
  const endTarget = live.get(String((connector.endBinding as { elementId?: unknown } | null)?.elementId ?? ''))
  if (!startTarget && !endTarget) return
  const first = points[0]
  const last = points[points.length - 1]
  const startAim = endTarget ? centre(boxOf(endTarget)) : last
  const start = startTarget ? edgePoint(boxOf(startTarget), startAim, ARROW_GAP) : first
  const endAim = startTarget ? centre(boxOf(startTarget)) : start
  const end = endTarget ? edgePoint(boxOf(endTarget), endAim, ARROW_GAP) : last
  const before = centre(boxOf(connector))
  connector.x = start[0]
  connector.y = start[1]
  connector.points = [[0, 0], [end[0] - start[0], end[1] - start[1]]]
  connector.width = Math.abs(end[0] - start[0])
  connector.height = Math.abs(end[1] - start[1])
  const after = centre(boxOf(connector))
  for (const text of boundIds(connector, 'text')) {
    const label = live.get(text)
    if (label) {
      label.x += after[0] - before[0]
      label.y += after[1] - before[1]
    }
  }
}
