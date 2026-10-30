/**
 * A Skizze edit applied to a scene: Piloti's operations (`sketch-edit-wire.ts`)
 * turned into the next scene, with what changed and the layout problems it
 * would leave. Pure: the server applies it under the person's yes
 * (`sketch-edit-service.ts`), checks it before a proposal is filed, and draws
 * its preview from it; the render, the versioning and the Freigabe rules are
 * the save's (`sketch-document.ts`).
 *
 * ## What the operations mean
 *
 *   - `add` takes a fence skeleton (`checkSketchSkeleton`): a new id, bindings
 *     and frame children that name the sketch's elements or earlier adds.
 *   - `update` sets geometry, style, a label or a text. Moving a shape moves
 *     its label; moving a frame moves what is in it.
 *   - `remove` takes the element's label and every arrow bound to it along
 *     (the eval's most common failure was a removal that left an arrow
 *     dangling); a frame lets its children go rather than deleting them.
 *   - `rebind` moves an arrow's ends to other elements.
 *   - `place`, `align`, `distribute` and `stack` are relative: the model names
 *     a reference and a side, the server works out the numbers, so an edit
 *     never needs pixel arithmetic from an outline.
 *
 * Every arrow bound to something that moved, grew or was rebound is routed
 * again (`routeConnector`). A label that no longer fits its box is grown into
 * it by the render, which measures text exactly (`sketch-label-fit.ts`).
 *
 * A wrong operation is a {@link SketchEditError}: an unknown id, an add whose id
 * is taken, a field the element does not have. Layout problems are warnings
 * (`sketch-edit-lints.ts`): the edit is still a valid one to propose.
 */

import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import { checkSketchSkeleton, MAX_SKETCH_COORDINATE, type SketchRefusal } from './sketch-fence'
import { keptSketchLink } from './sketch-links'
import {
  absolutePoints,
  addBound,
  bindEnd,
  boundIds,
  boxOf,
  CONNECTOR_TYPES,
  dropBound,
  elementsFromSkeleton,
  freeId,
  routeConnector,
  SHAPE_TYPES,
  textElement,
  type Box,
  type EditElement,
  type ElementFactory,
} from './sketch-edit-elements'
import { lintSketchEdit } from './sketch-edit-lints'
import type { SceneElement, SketchScene } from './sketch-scene'
import { MAX_SKETCH_EDIT_INTENT_CHARS, MAX_SKETCH_EDIT_OPS, type SketchEditDiff, type SketchEditOp, type SketchEditWarning } from './sketch-edit-wire'

export const SKETCH_EDIT_REFUSALS = [
  'too-many-ops',
  'unknown-id',
  'id-taken',
  'not-a-connector',
  'not-movable',
  'field-not-allowed',
  'bad-color',
  'empty-update',
  'empty-rebind',
  'bad-intent',
  'too-many-ids',
] as const
export type SketchEditRefusal = (typeof SKETCH_EDIT_REFUSALS)[number] | SketchRefusal

/** An operation the sketch cannot take: which one, and why, in words a model can act on. */
export class SketchEditError extends Error {
  constructor(
    readonly refusal: SketchEditRefusal,
    /** Zero-based. */
    readonly opIndex: number,
    readonly elementId?: string
  ) {
    super(`op ${opIndex + 1}: ${refusal}${elementId ? ` (${elementId})` : ''}`)
    this.name = 'SketchEditError'
  }
}

export interface AppliedSketchScene {
  scene: SketchScene
  diff: SketchEditDiff
  /** At most `MAX_SKETCH_EDIT_WARNINGS`, so neither the card nor Piloti's text grows with the scene. */
  warnings: SketchEditWarning[]
  /** How many more the edit would leave. */
  moreWarnings: number
}

export interface ApplyOptions {
  nonce?: () => number
  now?: number
}

/** At most this many elements in one `align`, `distribute` or `stack`: a step a person reads as one. */
export const MAX_SKETCH_EDIT_IDS = 100

const COLOR = /^(?:#[0-9a-f]{3,8}|transparent)$/i
const DEFAULT_GAP = 40
/** Fields that are bookkeeping, not drawing: a change to them alone is no change a person sees. */
const BOOKKEEPING = new Set(['boundElements', 'version', 'versionNonce', 'updated', 'seed', 'index'])

/** Whether Excalidraw's fractional indexing reads `index` as a key. */
function validKey(index: unknown): index is string {
  if (typeof index !== 'string') return false
  try {
    generateKeyBetween(index, null)
    return true
  } catch {
    return false
  }
}

/** The scene's top valid fractional index, or null when it has none (a scene from before Excalidraw indexed). */
function lastIndex(elements: readonly SceneElement[]): string | null {
  const indices = elements.flatMap((element) => (validKey(element.index) ? [element.index] : []))
  return indices.length ? indices.reduce((top, index) => (index > top ? index : top)) : null
}

const randomNonce = () => Math.floor(Math.random() * 2 ** 31)

/** The ids an edit needs to find in the sketch it is applied to: what a rebase on a newer Fassung checks first. */
export function idsNamedBy(ops: readonly SketchEditOp[]): string[] {
  const added = new Set(ops.flatMap((op) => (op.op === 'add' ? [op.element.id] : [])))
  const named = ops.flatMap((op): unknown[] => {
    switch (op.op) {
      case 'add': {
        const element = op.element as Record<string, unknown>
        const ends = [element.start, element.end].map((end) => (end as { id?: unknown } | undefined)?.id)
        return [...ends, ...(Array.isArray(element.children) ? element.children : [])]
      }
      case 'rebind':
        return [op.id, op.start, op.end]
      case 'place':
        return [op.id, op.referenceId]
      case 'align':
      case 'distribute':
      case 'stack':
        return op.ids
      default:
        return [op.id]
    }
  })
  return [...new Set(named.filter((id): id is string => typeof id === 'string' && !added.has(id)))]
}

class EditState {
  readonly live = new Map<string, EditElement>()
  readonly added: string[] = []
  readonly removed = new Set<string>()
  readonly moved = new Set<string>()
  /** Connectors to route again once every operation is applied. */
  readonly reroute = new Set<string>()
  readonly factory: ElementFactory
  private readonly baseIds: Set<string>
  /**
   * Labels by container, connectors by bound element and members by frame, in
   * scene order. Built on first use and dropped by {@link restructured}: a move
   * changes none of it, so sixty moves of a big frame read it once.
   */
  private index: { labels: Map<string, EditElement[]>; connectors: Map<string, EditElement[]>; members: Map<string, EditElement[]> } | null = null

  constructor(
    readonly base: SketchScene,
    options: ApplyOptions
  ) {
    this.baseIds = new Set(base.elements.map((element) => element.id))
    for (const element of base.elements) {
      if (!element.isDeleted) this.live.set(element.id, structuredClone(element) as EditElement)
    }
    this.factory = {
      nonce: options.nonce ?? randomNonce,
      now: options.now ?? Date.now(),
      taken: (id) => this.baseIds.has(id) || this.live.has(id),
    }
  }

  get(id: string, op: number): EditElement {
    const element = this.live.get(id)
    if (!element) throw new SketchEditError('unknown-id', op, id)
    return element
  }

  /** An element was added or dropped, or a binding, container or frame changed: the index is read again. */
  restructured(): void {
    this.index = null
  }

  private indexed() {
    if (this.index) return this.index
    const labels = new Map<string, EditElement[]>()
    const connectors = new Map<string, EditElement[]>()
    const members = new Map<string, EditElement[]>()
    const push = (map: Map<string, EditElement[]>, key: unknown, element: EditElement) => {
      if (typeof key !== 'string') return
      const list = map.get(key)
      if (!list) map.set(key, [element])
      else if (list.at(-1) !== element) list.push(element)
    }
    for (const element of this.live.values()) {
      if (element.type === 'text') {
        push(labels, element.containerId, element)
      } else {
        for (const id of boundIds(element, 'text')) {
          const text = this.live.get(id)
          if (text?.type === 'text' && text.containerId !== element.id) push(labels, element.id, text)
        }
      }
      if (CONNECTOR_TYPES.has(element.type)) {
        push(connectors, (element.startBinding as { elementId?: unknown } | null)?.elementId, element)
        push(connectors, (element.endBinding as { elementId?: unknown } | null)?.elementId, element)
      }
      if (!element.containerId) push(members, element.frameId, element)
    }
    this.index = { labels, connectors, members }
    return this.index
  }

  labelsOf(container: EditElement): EditElement[] {
    return [...new Set(this.indexed().labels.get(container.id) ?? [])]
  }

  connectorsAt(id: string): EditElement[] {
    return this.indexed().connectors.get(id) ?? []
  }

  /** Move an element, its labels and, for a frame, what it holds; its arrows are routed again later. */
  moveBy(element: EditElement, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return
    const members = element.type === 'frame' ? (this.indexed().members.get(element.id) ?? []) : []
    for (const target of [element, ...members]) {
      target.x += dx
      target.y += dy
      this.moved.add(target.id)
      for (const label of this.labelsOf(target)) {
        label.x += dx
        label.y += dy
      }
      for (const connector of this.connectorsAt(target.id)) this.reroute.add(connector.id)
    }
  }

  /** Drop an element and what hangs on it: its labels and the arrows bound to it (with theirs). */
  remove(element: EditElement): void {
    const gone = new Set<string>([element.id])
    for (const label of this.labelsOf(element)) gone.add(label.id)
    for (const connector of this.connectorsAt(element.id)) {
      gone.add(connector.id)
      for (const label of this.labelsOf(connector)) gone.add(label.id)
    }
    this.restructured()
    for (const id of gone) {
      this.live.delete(id)
      if (this.baseIds.has(id)) this.removed.add(id)
      const at = this.added.indexOf(id)
      if (at >= 0) this.added.splice(at, 1)
    }
    for (const other of this.live.values()) {
      dropBound(other, gone)
      if (other.frameId && gone.has(other.frameId)) other.frameId = null
      if (other.containerId && gone.has(other.containerId)) other.containerId = null
    }
  }
}

/** Elements a relative operation may move: shapes, free texts and frames. A label moves with its box, an arrow with its ends. */
function movable(state: EditState, id: string, op: number): EditElement {
  const element = state.get(id, op)
  const free = element.type === 'text' && !element.containerId
  if (!SHAPE_TYPES.has(element.type) && !free && element.type !== 'frame') throw new SketchEditError('not-movable', op, id)
  return element
}

function applyAdd(state: EditState, op: Extract<SketchEditOp, { op: 'add' }>, index: number): void {
  if (state.factory.taken(op.element.id)) throw new SketchEditError('id-taken', index, op.element.id)
  const checked = checkSketchSkeleton(op.element, new Set(state.live.keys()))
  if (!checked.ok) throw new SketchEditError(checked.refusal, index, op.element.id)
  for (const element of elementsFromSkeleton(checked.skeleton, state.live, state.factory)) {
    state.live.set(element.id, element)
    state.added.push(element.id)
  }
  state.restructured()
}

function setLabel(state: EditState, element: EditElement, text: string): void {
  if (element.type === 'frame') {
    element.name = text.trim() ? text : null
    return
  }
  const [label] = state.labelsOf(element)
  if (!text.trim()) {
    if (label) state.remove(label)
    return
  }
  if (label) {
    label.text = text
    label.originalText = text
    return
  }
  const created = textElement(freeId(`${element.id}-label`, state.factory), text, state.factory, { container: element })
  addBound(element, 'text', created.id)
  state.live.set(created.id, created)
  state.added.push(created.id)
  state.restructured()
}

function applyUpdate(state: EditState, op: Extract<SketchEditOp, { op: 'update' }>, index: number): void {
  const element = state.get(op.id, index)
  const set = op.set
  if (Object.keys(set).length === 0) throw new SketchEditError('empty-update', index, op.id)
  const refuse = (): never => {
    throw new SketchEditError('field-not-allowed', index, op.id)
  }
  const connector = CONNECTOR_TYPES.has(element.type)
  if (set.text !== undefined && element.type !== 'text') refuse()
  if (set.label !== undefined && element.type === 'text') refuse()
  if ((set.width !== undefined || set.height !== undefined) && (connector || element.type === 'text')) refuse()
  for (const field of ['strokeColor', 'backgroundColor'] as const) {
    if (set[field] !== undefined && !COLOR.test(set[field])) throw new SketchEditError('bad-color', index, op.id)
  }
  if (set.x !== undefined || set.y !== undefined) {
    if (element.type === 'text' && element.containerId) refuse()
    const box = boxOf(element)
    state.moveBy(element, (set.x ?? box.x) - box.x, (set.y ?? box.y) - box.y)
  }
  if (set.width !== undefined || set.height !== undefined) {
    if (set.width !== undefined) element.width = set.width
    if (set.height !== undefined) element.height = set.height
    for (const connectorAt of state.connectorsAt(element.id)) state.reroute.add(connectorAt.id)
    recentreLabels(state, element)
  }
  for (const field of ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeStyle'] as const) {
    if (set[field] !== undefined) element[field] = set[field]
  }
  // The link is replaced whole, never merged: half of one link and half of another points nowhere.
  if (set.customData === null) delete element.customData
  else if (set.customData !== undefined) element.customData = keptSketchLink(set.customData)
  if (set.text !== undefined) {
    element.text = set.text
    element.originalText = set.text
  }
  if (set.label !== undefined) setLabel(state, element, set.label.text)
}

function recentreLabels(state: EditState, container: EditElement): void {
  const box = boxOf(container)
  for (const label of state.labelsOf(container)) {
    label.x = box.x + box.w / 2 - (label.width as number) / 2
    label.y = box.y + box.h / 2 - (label.height as number) / 2
  }
}

function applyRebind(state: EditState, op: Extract<SketchEditOp, { op: 'rebind' }>, index: number): void {
  const connector = state.get(op.id, index)
  if (!CONNECTOR_TYPES.has(connector.type)) throw new SketchEditError('not-a-connector', index, op.id)
  if (op.start === undefined && op.end === undefined) throw new SketchEditError('empty-rebind', index, op.id)
  for (const end of ['start', 'end'] as const) {
    const id = op[end]
    if (id === undefined) continue
    const target = state.get(id, index)
    if (CONNECTOR_TYPES.has(target.type) || target.id === connector.id) throw new SketchEditError('not-movable', index, id)
    const old = state.live.get(String((connector[`${end}Binding`] as { elementId?: unknown } | null)?.elementId ?? ''))
    const other = (connector[`${end === 'start' ? 'end' : 'start'}Binding`] as { elementId?: unknown } | null)?.elementId
    if (old && old.id !== other) dropBound(old, new Set([connector.id]))
    bindEnd(connector, end, target)
  }
  state.restructured()
  state.reroute.add(connector.id)
}

/** Where `box` goes beside `reference`. */
function placed(box: Box, reference: Box, op: Extract<SketchEditOp, { op: 'place' }>): { x: number; y: number } {
  const offset = op.offset ?? DEFAULT_GAP
  const along = (start: number, length: number, size: number) =>
    op.align === 'start' ? start : op.align === 'end' ? start + length - size : start + length / 2 - size / 2
  switch (op.side) {
    case 'above':
      return { x: along(reference.x, reference.w, box.w), y: reference.y - offset - box.h }
    case 'below':
      return { x: along(reference.x, reference.w, box.w), y: reference.y + reference.h + offset }
    case 'left':
      return { x: reference.x - offset - box.w, y: along(reference.y, reference.h, box.h) }
    case 'right':
      return { x: reference.x + reference.w + offset, y: along(reference.y, reference.h, box.h) }
  }
}

function applyPlace(state: EditState, op: Extract<SketchEditOp, { op: 'place' }>, index: number): void {
  const element = movable(state, op.id, index)
  const reference = state.get(op.referenceId, index)
  if (reference.id === element.id) throw new SketchEditError('not-movable', index, op.id)
  const box = boxOf(element)
  const to = placed(box, boxOf(reference), op)
  state.moveBy(element, to.x - box.x, to.y - box.y)
}

function applyAlign(state: EditState, op: Extract<SketchEditOp, { op: 'align' }>, index: number): void {
  const elements = [...new Set(op.ids)].map((id) => movable(state, id, index))
  const boxes = elements.map(boxOf)
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.w))
  const bottom = Math.max(...boxes.map((box) => box.y + box.h))
  elements.forEach((element, at) => {
    const box = boxes[at]
    const x = { left, right: right - box.w, center: (left + right) / 2 - box.w / 2 }[op.edge as 'left'] ?? box.x
    const y = { top, bottom: bottom - box.h, middle: (top + bottom) / 2 - box.h / 2 }[op.edge as 'top'] ?? box.y
    state.moveBy(element, x - box.x, y - box.y)
  })
}

/** The axis's start and size of a box. */
const span = (box: Box, horizontal: boolean): [number, number] => (horizontal ? [box.x, box.w] : [box.y, box.h])

function applyDistribute(state: EditState, op: Extract<SketchEditOp, { op: 'distribute' }>, index: number): void {
  const horizontal = op.axis === 'horizontal'
  const items = [...new Set(op.ids)]
    .map((id) => movable(state, id, index))
    .map((element) => ({ element, box: boxOf(element) }))
    .sort((a, b) => span(a.box, horizontal)[0] + span(a.box, horizontal)[1] / 2 - (span(b.box, horizontal)[0] + span(b.box, horizontal)[1] / 2))
  if (items.length < 3) return
  const [firstStart] = span(items[0].box, horizontal)
  const [lastStart, lastSize] = span(items[items.length - 1].box, horizontal)
  const sizes = items.reduce((sum, item) => sum + span(item.box, horizontal)[1], 0)
  const gap = (lastStart + lastSize - firstStart - sizes) / (items.length - 1)
  let cursor = firstStart
  for (const { element, box } of items) {
    const [start, size] = span(box, horizontal)
    state.moveBy(element, horizontal ? cursor - start : 0, horizontal ? 0 : cursor - start)
    cursor += size + gap
  }
}

function applyStack(state: EditState, op: Extract<SketchEditOp, { op: 'stack' }>, index: number): void {
  const horizontal = op.axis === 'horizontal'
  const elements = [...new Set(op.ids)].map((id) => movable(state, id, index))
  const [start, size] = span(boxOf(elements[0]), horizontal)
  let cursor = start + size + (op.gap ?? DEFAULT_GAP)
  for (const element of elements.slice(1)) {
    const box = boxOf(element)
    const [at, length] = span(box, horizontal)
    state.moveBy(element, horizontal ? cursor - at : 0, horizontal ? 0 : cursor - at)
    cursor += length + (op.gap ?? DEFAULT_GAP)
  }
}

/** What the wire leaves to the apply, so the schema every agent reads stays short: the intent's length, coordinates in range. */
function checkBounds(op: SketchEditOp, index: number): void {
  const intent = op.intent.trim()
  if (!intent || intent.length > MAX_SKETCH_EDIT_INTENT_CHARS) throw new SketchEditError('bad-intent', index)
  if ('ids' in op && op.ids.length > MAX_SKETCH_EDIT_IDS) throw new SketchEditError('too-many-ids', index)
  if (op.op !== 'update') return
  const { x, y, width, height } = op.set
  for (const value of [x, y, width, height]) {
    if (value !== undefined && (!Number.isFinite(value) || Math.abs(value) > MAX_SKETCH_COORDINATE)) throw new SketchEditError('bad-coordinate', index, op.id)
  }
}

function applyOp(state: EditState, op: SketchEditOp, index: number): void {
  checkBounds(op, index)
  switch (op.op) {
    case 'add':
      return applyAdd(state, op, index)
    case 'update':
      return applyUpdate(state, op, index)
    case 'remove':
      return state.remove(state.get(op.id, index))
    case 'rebind':
      return applyRebind(state, op, index)
    case 'place':
      return applyPlace(state, op, index)
    case 'align':
      return applyAlign(state, op, index)
    case 'distribute':
      return applyDistribute(state, op, index)
    case 'stack':
      return applyStack(state, op, index)
  }
}

/** What a save keeps of a field: the link of `customData` in its key order (`sketch-links.ts`), every other field as it is. */
const keptField = ([key, value]: [string, unknown]): [string, unknown] => [key, key === 'customData' ? (keptSketchLink(value) ?? null) : value]

const drawn = (element: SceneElement | EditElement) =>
  JSON.stringify(
    Object.entries(element)
      .filter(([key]) => !BOOKKEEPING.has(key))
      .map(keptField)
      .filter(([key, value]) => key !== 'customData' || value !== null)
      .sort(([a], [b]) => a.localeCompare(b))
  )

/** A label is reported as its container: the person sees the box change, not a text element. */
function reported(ids: Iterable<string>, byId: (id: string) => SceneElement | EditElement | undefined): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    const element = byId(id)
    out.add(element?.type === 'text' && element.containerId ? element.containerId : id)
  }
  return [...out]
}

function diffOf(state: EditState): SketchEditDiff {
  const before = new Map(state.base.elements.map((element) => [element.id, element]))
  const isNew = new Set(state.added)
  // A label added to a box that was already drawn changes that box; one added with its box is part of the add.
  const labelOfOld = (id: string) => {
    const element = state.live.get(id)
    return element?.type === 'text' && element.containerId && !isNew.has(element.containerId) ? element.containerId : null
  }
  const added = reported(
    state.added.filter((id) => !labelOfOld(id)),
    (id) => state.live.get(id)
  )
  const removed = reported(state.removed, (id) => before.get(id)).filter((id) => !state.live.has(id))
  const changedIds = [...state.live.values()].flatMap((element) => {
    const old = before.get(element.id)
    return old !== undefined && !old.isDeleted && drawn(old) !== drawn(element) ? [element.id] : []
  })
  const relabelled = state.added.flatMap((id) => labelOfOld(id) ?? [])
  // A label removed from a box that stays changes the box.
  const unlabelled = [...state.removed].flatMap((id) => {
    const container = before.get(id)?.containerId
    return container && state.live.has(container) ? [container] : []
  })
  const changed = reported([...changedIds, ...relabelled, ...unlabelled], (id) => state.live.get(id)).filter(
    (id) => !added.includes(id) && !removed.includes(id)
  )
  return { added, removed, changed }
}

/**
 * The scene after `ops`, what changed, and the warnings. Throws
 * {@link SketchEditError} on the first operation the sketch cannot take.
 */
export function applySketchEdit(base: SketchScene, ops: readonly SketchEditOp[], options: ApplyOptions = {}): AppliedSketchScene {
  if (ops.length > MAX_SKETCH_EDIT_OPS) throw new SketchEditError('too-many-ops', MAX_SKETCH_EDIT_OPS)
  const state = new EditState(base, options)
  ops.forEach((op, index) => applyOp(state, op, index))
  for (const id of state.reroute) {
    const connector = state.live.get(id)
    if (connector && absolutePoints(connector).length >= 2) routeConnector(connector, state.live)
  }
  const elements: SceneElement[] = []
  for (const element of base.elements) {
    if (element.isDeleted) elements.push(element)
    else if (state.live.has(element.id)) elements.push(state.live.get(element.id) as SceneElement)
  }
  // Above everything that is validly indexed, in order: Excalidraw orders a scene by its fractional `index`,
  // and repairs (or chokes on) one whose array order disagrees with it.
  const top = lastIndex(base.elements)
  const keys = generateNKeysBetween(top, null, state.added.length)
  const fresh = state.added.map((id, at) => Object.assign(state.live.get(id) as EditElement, { index: keys[at] }) as SceneElement)
  // After the top element, or after the last one kept below it when the edit removed the top one; at the end when none is indexed.
  const kept = top === null ? -1 : elements.findLastIndex((element) => validKey(element.index) && element.index <= top)
  elements.splice(kept < 0 ? elements.length : kept + 1, 0, ...fresh)
  const diff = diffOf(state)
  const { warnings, more } = lintSketchEdit(state.live, {
    placed: new Set([...state.added, ...state.moved]),
    written: new Set([...diff.added, ...diff.changed]),
  })
  return { scene: { ...base, elements }, diff, warnings, moreWarnings: more }
}
