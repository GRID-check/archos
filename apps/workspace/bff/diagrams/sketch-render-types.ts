/** The messages between `sketch-renderer.ts` and its worker (`sketch-render-worker.ts`), ADR-0149. */

export interface SketchRenderRequest {
  id: number
  /** The scene's elements as stored, deleted ones included (Excalidraw's export leaves those out). */
  elements: readonly Record<string, unknown>[]
  appState?: Record<string, unknown>
  /** Text elements to lay out again with the server's metrics: new, or their text or type changed. */
  remeasure: readonly string[]
}

export type SketchRenderResponse =
  | {
      id: number
      ok: true
      /** The SVG, cleaned and re-serialised through the filing validator (`fileableSketchSvg`). */
      svg: string
      /** The remeasured texts: `id` and the layout fields (`x`, `y`, `width`, `height`, `text`) Excalidraw gave them again. */
      remeasured: Record<string, unknown>[]
      /** Time inside the worker. */
      ms: number
      /** The worker's heap after the render, in MB, for the renderer to recycle it. */
      heapMb?: number
    }
  | { id: number; ok: false; error: string }

/** The build's font index, beside the bundled worker (`sketch-font-faces.ts`). */
export const FONT_COVERAGE_FILE = 'font-coverage.json'
