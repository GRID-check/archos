'use client'

/**
 * A drawing fence in an answer: which kind it is, and the component that draws
 * it, each behind its own `next/dynamic` boundary. Split out of
 * `MarkdownRenderer.tsx`, which only asks `diagramFenceKind` and renders
 * `DiagramFence`.
 */

import dynamic from 'next/dynamic'
import { DrawingSkeleton } from '@/features/diagrams/components/drawing-skeleton'
import { sketchFenceKind } from '@/lib/diagrams/sketch-fence'
import { isMermaidFence } from './utils'

/**
 * A ```mermaid fence, drawn instead of printed.
 *
 * `dynamic` with `ssr: false` for the same reason the BIM preview uses it: the
 * component reaches for a DOM (mermaid lays out a graph by measuring text), and
 * everything behind this boundary — the renderer, the SVG validator and, one
 * `import()` further in, mermaid itself — stays out of the bundle of an answer
 * that has no diagram in it. Measured: mermaid's first flowchart render pulls
 * 214 KB gzipped, and a reader who never meets a fence pays none of it.
 *
 * The fallback while the chunk loads is the place the drawing will be drawn
 * in ({@link DiagramPlace}), not a spinner and not nothing. It was nothing,
 * and the paced reveal shows a closed fence together with the first words
 * after it: those words were drawn first, and the figure then opened 156 px
 * above the line being read when the chunk resolved (stream audit 2026-10,
 * an answer opening with a table: `dy 180` on the paragraph after it).
 */
const MermaidDiagram = dynamic(
  () =>
    import('@/features/diagrams/components/mermaid-diagram').then(
      (module) => module.MermaidDiagram
    ),
  { ssr: false, loading: () => <DiagramPlace /> }
)

/**
 * A sketch fence (```excalidraw, ADR-0146), behind the same boundary and for
 * the same reason: Excalidraw is one more `import()` further in
 * (`sketch-render.ts`), so an answer without a sketch loads none of it.
 */
const SketchFigure = dynamic(
  () => import('@/features/diagrams/components/sketch-figure').then((module) => module.SketchFigure),
  { ssr: false, loading: () => <DiagramPlace /> }
)

/**
 * The drawing's place while its component loads: the frame and skeleton
 * `MermaidDiagram` itself shows while it parses, so the swap to it changes
 * nothing on screen. The plane of the product's own views, the frame most
 * fences are drawn in; a fence mermaid draws itself has a hairline frame of
 * the same height instead.
 */
function DiagramPlace() {
  return (
    <figure data-testid="mermaid-place" className="my-4" aria-busy="true">
      <div className="bg-muted/40 rounded-surface p-3">
        <DrawingSkeleton />
      </div>
    </figure>
  )
}

export type DiagramFenceKind = 'mermaid' | 'sketch' | 'refused-sketch'

/**
 * Which drawing a code block is, if any. A sketch is known by its tag alone
 * (`excalidraw`, or `excalidraw-refused` once the server refused it); a mermaid
 * fence by its tag or its first line (`isMermaidFence`).
 */
export function diagramFenceKind(className: string | undefined, source: string): DiagramFenceKind | null {
  const sketch = sketchFenceKind(className)
  if (sketch) return sketch === 'refused' ? 'refused-sketch' : 'sketch'
  return isMermaidFence(className, source) ? 'mermaid' : null
}

export function DiagramFence({
  kind,
  source,
  isStreaming,
}: {
  kind: DiagramFenceKind
  source: string
  isStreaming: boolean
}) {
  if (kind === 'mermaid') return <MermaidDiagram source={source} isStreaming={isStreaming} />
  return <SketchFigure source={source} isStreaming={isStreaming} refused={kind === 'refused-sketch'} />
}
