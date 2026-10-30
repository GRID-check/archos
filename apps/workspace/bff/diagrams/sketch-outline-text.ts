/**
 * A Skizze compared as text: its outline, one line per thing drawn, instead of
 * its SVG markup and scene JSON (the interference audit's G5).
 *
 * „Text vergleichen“ diffs two Fassungen line by line in the browser
 * (`app/api/documents/[id]/versions/diff`). Raw SVG differs on every save in
 * coordinates, nonces and versions nobody reads; the outline
 * (`./sketch-outline.ts`) differs where the drawing does: a label renamed, a
 * room added, an arrow re-pointed. The lines carry no words of any language of
 * ours, only the labels people wrote and signs for the kind of thing, so the
 * same diff reads in German and English.
 *
 * Other markup (an SVG with no scene, XML, YAML) is compared as it is; bytes
 * that are not text are refused by name (`lib/documents/text-content.ts`).
 */

import { comparableAsText, notRevisableAsText, revisableAsText } from '@/lib/documents/text-content'
import { outlineSketch } from './sketch-outline'
import { parseStoredSketchScene, type SketchScene } from './sketch-scene'
import { storedDiagramSource } from './stored-source'

const SHAPE_SIGN: Record<string, string> = { rectangle: '▭', ellipse: '◯', diamond: '◇' }

const label = (text: string | null) => (text ? `„${text}“` : '–')

/** The outline of a scene, as lines a diff can compare: frames, shapes, connections, free text, each sorted. */
export function outlineText(scene: SketchScene): string {
  const outline = outlineSketch(scene)
  const sorted = (lines: string[]) => [...lines].sort((a, b) => a.localeCompare(b))
  const frames = outline.frames.map((frame) => `▣ ${label(frame.name)}: ${frame.children.map((child) => label(child.label)).join(', ')}`)
  const shapes = outline.shapes.map((shape) => `${SHAPE_SIGN[shape.type] ?? '□'} ${label(shape.label)}`)
  const connections = outline.connections.map(
    (connection) => `${label(connection.from?.label ?? null)} → ${label(connection.to?.label ?? null)}${connection.label ? ` (${connection.label})` : ''}`
  )
  const free = outline.texts.filter((text) => text.container === null).map((text) => `T ${label(text.text)}`)
  return [...sorted(frames), ...sorted(shapes), ...sorted(connections), ...sorted(free)].join('\n')
}

/** A version's content as the text compare shows it: text and markup as they are, a Skizze as its outline, anything else refused. */
export function comparableText(contentType: string | null, content: string): string {
  if (revisableAsText(contentType)) return content
  const stored = contentType === 'image/svg+xml' ? storedDiagramSource(content) : null
  const scene = stored?.kind === 'excalidraw' ? parseStoredSketchScene(stored.source) : null
  if (scene) return outlineText(scene)
  if (comparableAsText(contentType)) return content
  throw notRevisableAsText(contentType)
}
