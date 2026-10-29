/**
 * A Skizze read as structure: what a person or a model needs to answer "what
 * does this sketch say" without looking at it (ADR-0148).
 *
 * Derived from the stored scene alone, with no model call: Excalidraw already
 * records which text labels which shape (`containerId`), which shapes an arrow
 * joins (`startBinding`, `endBinding`) and which elements a frame holds
 * (`frameId`). The outline names things by their LABEL, because "Küche → Essen"
 * is what a reader means, and keeps each id beside it, because a later write
 * (`document-sketch-update`) addresses elements by id.
 *
 * Deleted elements are left out: Excalidraw keeps them in the scene for undo
 * and for merging, and nobody drew them.
 */

import type { SceneElement, SketchScene } from './sketch-scene'

const SHAPE_TYPES: ReadonlySet<string> = new Set(['rectangle', 'ellipse', 'diamond'])
const CONNECTOR_TYPES: ReadonlySet<string> = new Set(['arrow', 'line'])

export interface SketchOutlineText {
  id: string
  text: string
  /** The shape, arrow or frame this text labels; `null` for free text on the canvas. */
  container: { id: string; type: string } | null
}

export interface SketchOutlineShape {
  id: string
  type: string
  /** Its label's text, or `null` for an unlabelled shape. */
  label: string | null
}

export interface SketchOutlineConnection {
  id: string
  type: string
  from: { id: string; label: string | null } | null
  to: { id: string; label: string | null } | null
  /** The text on the arrow itself. */
  label: string | null
}

export interface SketchOutlineFrame {
  id: string
  name: string | null
  /** The elements inside it, by label where they have one. */
  children: { id: string; type: string; label: string | null }[]
}

export interface SketchOutline {
  texts: SketchOutlineText[]
  shapes: SketchOutlineShape[]
  connections: SketchOutlineConnection[]
  frames: SketchOutlineFrame[]
}

function clean(text: string | undefined): string | null {
  const value = text?.replace(/\s+/g, ' ').trim()
  return value ? value : null
}

/** Each element's label: its own text for a text element, its bound text's for a container. */
function labelsOf(elements: readonly SceneElement[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const element of elements) {
    if (element.type !== 'text') continue
    const text = clean(element.text)
    if (!text) continue
    labels.set(element.id, text)
    if (element.containerId) labels.set(element.containerId, text)
  }
  return labels
}

function endpoint(
  binding: { elementId: string } | null | undefined,
  labels: Map<string, string>,
): { id: string; label: string | null } | null {
  if (!binding?.elementId) return null
  return { id: binding.elementId, label: labels.get(binding.elementId) ?? null }
}

/** The outline of a scene. Pure; its size follows the scene's, which `sketch-scene.ts` bounds. */
export function outlineSketch(scene: SketchScene): SketchOutline {
  const elements = scene.elements.filter((element) => !element.isDeleted)
  const byId = new Map(elements.map((element) => [element.id, element]))
  const labels = labelsOf(elements)
  const outline: SketchOutline = { texts: [], shapes: [], connections: [], frames: [] }

  for (const element of elements) {
    if (element.type === 'text') {
      const text = clean(element.text)
      if (!text) continue
      const container = element.containerId ? byId.get(element.containerId) : undefined
      outline.texts.push({ id: element.id, text, container: container ? { id: container.id, type: container.type } : null })
    } else if (SHAPE_TYPES.has(element.type)) {
      outline.shapes.push({ id: element.id, type: element.type, label: labels.get(element.id) ?? null })
    } else if (CONNECTOR_TYPES.has(element.type)) {
      outline.connections.push({
        id: element.id,
        type: element.type,
        from: endpoint(element.startBinding, labels),
        to: endpoint(element.endBinding, labels),
        label: labels.get(element.id) ?? null,
      })
    } else if (element.type === 'frame') {
      outline.frames.push({ id: element.id, name: clean(element.name ?? undefined), children: [] })
    }
  }

  const frames = new Map(outline.frames.map((frame) => [frame.id, frame]))
  for (const element of elements) {
    const frame = element.frameId ? frames.get(element.frameId) : undefined
    // A container's label is listed once, with its container.
    if (!frame || (element.type === 'text' && element.containerId)) continue
    frame.children.push({ id: element.id, type: element.type, label: labels.get(element.id) ?? null })
  }
  return outline
}
