/**
 * An ```` ```excalidraw ```` fence in an answer: the sketch Piloti drew, checked
 * and reduced to what the browser may hand Excalidraw (ADR-0145).
 *
 * The fence holds Excalidraw's element skeleton (`ExcalidrawElementSkeleton`,
 * the input of `convertToExcalidrawElements`), either as a bare array or as
 * `{ "title": …, "elements": [ … ] }`. This module is pure: it imports nothing
 * of Excalidraw, so the chat can decide what to show without downloading it.
 *
 * ## Two checks, one rule set
 *
 * `src/aiq_agent/common/sketch_fence.py` is the server's check and this is the
 * browser's. They refuse the same fences with the same word, held together by
 * `__fixtures__/sketch-fences.json`, which both test suites run. The server's
 * verdict is stored in the answer: a refused fence arrives retagged
 * `excalidraw-refused` and is shown as its source. This one exists because a
 * fence still streaming, and every answer stored before the server checked,
 * arrive without that verdict.
 *
 * ## What reaches Excalidraw
 *
 * Only the fields in `ALLOWED_FIELDS`, with enumerated values held to their
 * enumeration and numbers to a range: a `link` (Excalidraw makes an element
 * clickable with it), `customData`, a `fileId` or anything else the model
 * wrote is dropped, not refused, because a sketch with one stray field is
 * still a sketch. Every text is set in Helvetica (`SKETCH_FONT_FAMILY`), the
 * type the filed SVG and PDF can show, so the file reads like the sketch.
 *
 * The doctrine (`diagram-sources.ts`) holds by subject, not by parse: a sketch
 * claims no dimension, and the reader is told so beside it. A label that reads
 * like a measurement is counted (`dimensionLabels`), as the server counts it.
 */

/** The fence tag the model writes, and the one the server stores a refused sketch under. */
export const SKETCH_FENCE_LANGUAGE = 'excalidraw'
export const REFUSED_SKETCH_FENCE_LANGUAGE = 'excalidraw-refused'

export const MAX_SKETCH_SOURCE_BYTES = 32 * 1024
export const MAX_SKETCH_ELEMENTS = 150
export const MAX_SKETCH_COORDINATE = 10_000
export const MAX_SKETCH_TEXT_CHARS = 500
export const MAX_SKETCH_POINTS = 200
export const MAX_SKETCH_TITLE_CHARS = 120

/** Excalidraw's `FONT_FAMILY.Helvetica`; why, in `features/diagrams/sketch/sketch-from-model.ts`. */
const SKETCH_FONT_FAMILY = 2

export const SKETCH_ELEMENT_TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'frame'] as const
export type SketchElementType = (typeof SKETCH_ELEMENT_TYPES)[number]

export const SKETCH_REFUSALS = [
  'too-large',
  'malformed-json',
  'not-a-scene',
  'empty',
  'too-many-elements',
  'unsupported-element',
  'bad-coordinate',
  'missing-text',
  'text-too-long',
  'bad-points',
  'duplicate-id',
  'dangling-binding',
] as const
export type SketchRefusal = (typeof SKETCH_REFUSALS)[number]

/** One skeleton element as it is handed to `convertToExcalidrawElements`. */
export type SceneSkeleton = { type: SketchElementType } & Record<string, unknown>

export type SketchFence =
  | {
      ok: true
      title: string | null
      elements: SceneSkeleton[]
      /** Labels that read like a measurement, which a sketch must not claim. */
      dimensionLabels: number
    }
  | { ok: false; refusal: SketchRefusal }

/** A number with a unit of length or area, the server's `_DIMENSION`. */
const DIMENSION = /\d(?:[.,]\d+)?\s*(?:mm|cm|dm|km|m²|m2|m³|m)(?![a-zäöüß])/i

class Refused extends Error {
  constructor(readonly refusal: SketchRefusal) {
    super(refusal)
  }
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function coordinate(value: unknown, required: boolean): void {
  if (value == null && !required) return
  if (!isNumber(value) || Math.abs(value) > MAX_SKETCH_COORDINATE) throw new Refused('bad-coordinate')
}

function text(value: unknown, required: boolean): string {
  if (value == null && !required) return ''
  if (typeof value !== 'string' || !value.trim()) throw new Refused('missing-text')
  // Python counts code points; a string's length counts UTF-16 units.
  if ([...value].length > MAX_SKETCH_TEXT_CHARS) throw new Refused('text-too-long')
  return value
}

function sceneElements(scene: unknown): { title: string | null; elements: unknown[] } {
  let title: string | null = null
  let elements: unknown = scene
  if (isObject(scene)) {
    const raw = scene.title
    if (raw !== undefined && raw !== null && (typeof raw !== 'string' || [...raw].length > MAX_SKETCH_TITLE_CHARS)) {
      throw new Refused('not-a-scene')
    }
    title = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    elements = scene.elements
  }
  if (!Array.isArray(elements)) throw new Refused('not-a-scene')
  if (elements.length === 0) throw new Refused('empty')
  if (elements.length > MAX_SKETCH_ELEMENTS) throw new Refused('too-many-elements')
  return { title, elements }
}

function points(value: unknown): void {
  if (value == null) return
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_SKETCH_POINTS) throw new Refused('bad-points')
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) throw new Refused('bad-points')
    coordinate(point[0], true)
    coordinate(point[1], true)
  }
}

function isSketchType(value: unknown): value is SketchElementType {
  return typeof value === 'string' && (SKETCH_ELEMENT_TYPES as readonly string[]).includes(value)
}

/** Check one element on its own; the words it shows. */
function elementTexts(element: Json): string[] {
  const kind = element.type
  if (!isSketchType(kind)) throw new Refused('unsupported-element')
  if (kind === 'frame') {
    if (!Array.isArray(element.children)) throw new Refused('not-a-scene')
    return [text(element.name, false)]
  }
  coordinate(element.x, true)
  coordinate(element.y, true)
  coordinate(element.width, false)
  coordinate(element.height, false)
  if (kind === 'text') return [text(element.text, true)]
  if (kind === 'arrow' || kind === 'line') points(element.points)
  if (element.label == null) return []
  if (!isObject(element.label)) throw new Refused('missing-text')
  return [text(element.label.text, true)]
}

/** The ids an element points at: an arrow's bound ends, a frame's children. */
function references(element: Json): unknown[] {
  if (element.type === 'frame') return element.children as unknown[]
  const ends = [element.start, element.end].filter((end) => end !== undefined && end !== null)
  if (ends.some((end) => !isObject(end))) throw new Refused('dangling-binding')
  return ends.map((end) => (end as Json).id)
}

// ---------------------------------------------------------------------------
// What reaches Excalidraw: the allow-list, applied after the check passed.
// ---------------------------------------------------------------------------

const COLOR = /^(?:#[0-9a-f]{3,8}|transparent)$/i
const ENUMS: Record<string, readonly (string | null)[]> = {
  fillStyle: ['hachure', 'cross-hatch', 'solid', 'zigzag'],
  strokeStyle: ['solid', 'dashed', 'dotted'],
  textAlign: ['left', 'center', 'right'],
  verticalAlign: ['top', 'middle', 'bottom'],
  startArrowhead: [null, 'arrow', 'bar', 'dot', 'triangle', 'circle', 'diamond'],
  endArrowhead: [null, 'arrow', 'bar', 'dot', 'triangle', 'circle', 'diamond'],
}
const RANGES: Record<string, readonly [number, number]> = {
  fontSize: [10, 64],
  strokeWidth: [0.5, 8],
  roughness: [0, 2],
  opacity: [10, 100],
  angle: [-Math.PI * 2, Math.PI * 2],
}
const SHAPE_FIELDS = ['id', 'x', 'y', 'width', 'height', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'angle']
const ALLOWED_FIELDS: Record<SketchElementType, readonly string[]> = {
  rectangle: [...SHAPE_FIELDS, 'roundness', 'label'],
  ellipse: [...SHAPE_FIELDS, 'label'],
  diamond: [...SHAPE_FIELDS, 'roundness', 'label'],
  text: ['id', 'x', 'y', 'text', 'fontSize', 'textAlign', 'strokeColor', 'opacity', 'angle'],
  arrow: [...SHAPE_FIELDS, 'points', 'start', 'end', 'startArrowhead', 'endArrowhead', 'label'],
  line: [...SHAPE_FIELDS, 'points'],
  frame: ['id', 'children', 'name'],
}
const LABEL_FIELDS = ['text', 'fontSize', 'textAlign', 'verticalAlign', 'strokeColor']

/** One field's value as Excalidraw gets it, or `undefined` to drop it. */
function kept(field: string, value: unknown): unknown {
  if (field === 'strokeColor' || field === 'backgroundColor') {
    return typeof value === 'string' && COLOR.test(value) ? value : undefined
  }
  if (field in ENUMS) return ENUMS[field].includes(value as string | null) ? value : undefined
  if (field in RANGES) {
    const [low, high] = RANGES[field]
    return isNumber(value) ? Math.min(high, Math.max(low, value)) : undefined
  }
  if (field === 'roundness') return isObject(value) && (value.type === 2 || value.type === 3) ? { type: value.type } : undefined
  if (field === 'start' || field === 'end') return isObject(value) ? { id: value.id } : undefined
  if (field === 'label') return isObject(value) ? labelOf(value) : undefined
  if (field === 'children') return [...(value as unknown[])]
  if (field === 'points') return (value as number[][]).map(([x, y]) => [x, y])
  return value
}

function labelOf(label: Json): Json {
  const out: Json = { fontFamily: SKETCH_FONT_FAMILY }
  for (const field of LABEL_FIELDS) {
    const value = label[field] == null ? undefined : kept(field, label[field])
    if (value !== undefined) out[field] = value
  }
  return out
}

function skeletonOf(element: Json): SceneSkeleton {
  const type = element.type as SketchElementType
  const out: SceneSkeleton = { type }
  for (const field of ALLOWED_FIELDS[type]) {
    // A JSON null is an absent field, except where Excalidraw reads it (an arrow with no head).
    if (element[field] === undefined || (element[field] === null && !field.endsWith('Arrowhead'))) continue
    const value = kept(field, element[field])
    if (value !== undefined) out[field] = value
  }
  if (type === 'text') out.fontFamily = SKETCH_FONT_FAMILY
  return out
}

function checked(scene: unknown): SketchFence {
  const { title, elements } = sceneElements(scene)
  if (elements.some((element) => !isObject(element))) throw new Refused('not-a-scene')
  const objects = elements as Json[]
  const texts = objects.flatMap(elementTexts)
  const ids = objects.filter((element) => 'id' in element).map((element) => element.id)
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Refused('duplicate-id')
  }
  const known = new Set(ids)
  if (objects.some((element) => references(element).some((ref) => typeof ref !== 'string' || !known.has(ref)))) {
    throw new Refused('dangling-binding')
  }
  return {
    ok: true,
    title,
    elements: objects.map(skeletonOf),
    dimensionLabels: texts.filter((value) => DIMENSION.test(value)).length,
  }
}

/** The verdict on one fence's body, and on a pass the skeletons to draw. */
export function readSketchFence(body: string): SketchFence {
  if (new TextEncoder().encode(body).length > MAX_SKETCH_SOURCE_BYTES) return { ok: false, refusal: 'too-large' }
  let scene: unknown
  try {
    scene = JSON.parse(body)
  } catch {
    return { ok: false, refusal: 'malformed-json' }
  }
  try {
    return checked(scene)
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal }
    throw error
  }
}

/** Where the element array starts in a fence still being written, or -1. */
function arrayStart(text: string): number {
  const first = text.search(/\S/)
  if (first >= 0 && text[first] === '[') return first
  const key = /"elements"\s*:\s*\[/.exec(text)
  return key ? key.index + key[0].length - 1 : -1
}

/** The complete top-level objects of an array whose closing bracket has not arrived yet. */
function completeObjects(text: string, from: number): string[] {
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = from + 1; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') {
      if (depth === 0) start = i
      depth++
    } else if (char === '}' || char === ']') {
      if (depth === 0) break
      depth--
      if (depth === 0 && char === '}') objects.push(text.slice(start, i + 1))
    }
    if (objects.length >= MAX_SKETCH_ELEMENTS) break
  }
  return objects
}

/**
 * The elements of a fence still being written, as far as they have arrived: the
 * sketch draws itself element by element while Piloti writes it, as Excalidraw's
 * own MCP app does.
 *
 * Lenient where `readSketchFence` refuses, because the fence is not finished: an
 * element that does not pass on its own is left out, and a binding to an id that
 * has not arrived yet is left off until it has. The finished fence is judged by
 * `readSketchFence` as a whole, and that verdict is the one that stays.
 */
export function streamedSketchElements(partial: string): SceneSkeleton[] {
  const at = arrayStart(partial)
  if (at < 0) return []
  const elements: Json[] = []
  const seen = new Set<unknown>()
  for (const raw of completeObjects(partial, at)) {
    let element: unknown
    try {
      element = JSON.parse(raw)
      if (!isObject(element)) continue
      elementTexts(element)
    } catch {
      continue
    }
    if ('id' in element && (typeof element.id !== 'string' || seen.has(element.id))) continue
    seen.add(element.id)
    elements.push(element)
  }
  return elements.map((element) => {
    const bound: Json = { ...element }
    if (element.type === 'frame') bound.children = (element.children as unknown[]).filter((id) => seen.has(id))
    for (const end of ['start', 'end'] as const) {
      const value = element[end]
      if (value != null && !(isObject(value) && seen.has(value.id))) delete bound[end]
    }
    return skeletonOf(bound)
  })
}

/** Which kind of sketch fence a code block's class names, if any. */
export function sketchFenceKind(className: string | undefined): 'sketch' | 'refused' | null {
  if (/(?:^|\s)language-excalidraw-refused(?:$|\s)/i.test(className ?? '')) return 'refused'
  if (/(?:^|\s)language-excalidraw(?:$|\s)/i.test(className ?? '')) return 'sketch'
  return null
}
