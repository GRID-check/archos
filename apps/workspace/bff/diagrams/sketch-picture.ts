/**
 * A saved scene's picture, drawn by the server (ADR-0149): which texts it lays
 * out again, and the scene with their new layout.
 *
 * The editor measured every text it set, in the person's browser. A text the
 * save added or changed may not have been measured by anyone: an agent writes
 * `width` by guess. So those, and only those, are laid out again with the
 * server's metrics (`sketch-text-metrics.ts`); the rest is drawn as it came.
 * The server's metrics equal a browser's (the ADR's table), so a person's own
 * new label keeps its width.
 */

import 'server-only'
import type { SceneElement, SketchScene } from './sketch-scene'
import { sketchRenderer, type RenderedScene } from './sketch-renderer'

/** What decides a text's layout: a change to any of these is a text nobody may have measured. */
const LAYOUT_FIELDS = ['text', 'originalText', 'fontSize', 'fontFamily', 'lineHeight', 'containerId', 'textAlign', 'autoResize'] as const

/** What a new layout changes on a text element (Excalidraw's `refreshTextDimensions`). */
const MEASURED_FIELDS = ['x', 'y', 'width', 'height', 'text'] as const

/** The ids of the text elements `next` adds, or changes in a field that decides their layout. Pure. */
export function textsToMeasure(stored: SketchScene | null, next: SketchScene): string[] {
  const before = new Map((stored?.elements ?? []).map((element) => [element.id, element]))
  const ids: string[] = []
  for (const element of next.elements) {
    if (element.type !== 'text' || element.isDeleted) continue
    const old = before.get(element.id)
    if (!old || old.isDeleted || LAYOUT_FIELDS.some((field) => old[field] !== element[field])) ids.push(element.id)
  }
  return ids
}

/** `next` with the layout the renderer gave its remeasured texts. Pure. */
export function withMeasuredTexts(next: SketchScene, remeasured: readonly Record<string, unknown>[]): SketchScene {
  if (remeasured.length === 0) return next
  const fresh = new Map(remeasured.map((element) => [String(element.id), element]))
  const elements = next.elements.map((element): SceneElement => {
    const laid = fresh.get(element.id)
    if (!laid) return element
    const measured = Object.fromEntries(MEASURED_FIELDS.filter((field) => field in laid).map((field) => [field, laid[field]]))
    return { ...element, ...measured }
  })
  return { ...next, elements }
}

export interface DrawnScene {
  scene: SketchScene
  svg: string
  render: Pick<RenderedScene, 'ms'> & { elements: number; remeasured: number }
}

/** Draw a checked scene: lay out its new texts, then export the picture from the result. */
export async function drawSketchScene(stored: SketchScene | null, next: SketchScene): Promise<DrawnScene> {
  const remeasure = textsToMeasure(stored, next)
  const drawn = next.elements.filter((element) => !element.isDeleted)
  const rendered = await sketchRenderer().render({
    elements: drawn as unknown as Record<string, unknown>[],
    appState: next.appState,
    remeasure,
  })
  return {
    scene: withMeasuredTexts(next, rendered.remeasured),
    svg: rendered.svg,
    render: { ms: rendered.ms, elements: drawn.length, remeasured: rendered.remeasured.length },
  }
}
