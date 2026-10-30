/**
 * The sketch renderer's worker thread: a stored scene in, the SVG a Skizze
 * files out, drawn by Excalidraw's own `exportToSvg` (ADR-0149).
 *
 * Not imported by the app. `scripts/build-sketch-renderer.ts` bundles this
 * file, Excalidraw, happy-dom and fontkit into one Node module,
 * `dist-sketch-render/sketch-render-worker.mjs`, and `sketch-renderer.ts`
 * starts it as a `worker_thread`. The DOM is installed first
 * (`sketch-render-dom.ts`), then Excalidraw is imported, so its import-time
 * reads find a document.
 *
 * Each message is one render:
 *
 *   - `remeasure` names the text elements whose text or type the save
 *     changed; Excalidraw lays them out again (`restoreElements` with
 *     `refreshDimensions`, which it applies only with `repairBindings`) with
 *     the server's metrics
 *     (`sketch-text-metrics.ts`), so a label an agent wrote gets the width the
 *     editor would give it. Every other element is drawn as it came: the
 *     editor measured it.
 *   - The export is the editor's own (`sketch-canvas.tsx`, `prepare`): paper,
 *     never dark mode, padding 16, fonts not inlined; then the same cleaning
 *     and re-serialisation through the server's validator
 *     (`fileableSketchSvg`).
 *   - An underlay (S6, `sketch-underlay.ts`) is drawn by Excalidraw over a
 *     one-pixel stand-in file, so Excalidraw places it as it would on the
 *     canvas; its `<use>` and `<symbol>` are then taken out and its place
 *     answered as `underlay`. The page's bytes never reach the worker: the
 *     filing writes the server's own PNG there (`sketch-underlay-svg.ts`), and
 *     the background is left out so the page is not painted over.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import { getHeapStatistics } from 'node:v8'
import { facesFrom, type FontCoverage } from './sketch-font-faces'
import { fitContainerToLabel } from './sketch-label-fit'
import { installSketchDom } from './sketch-render-dom'
import { createTextMetrics } from './sketch-text-metrics'
import { FONT_COVERAGE_FILE, type SketchRenderRequest, type SketchRenderResponse, type UnderlayPlacement } from './sketch-render-types'

const { fontsDir } = workerData as { fontsDir: string }

/** The build's index of which file has which characters (`sketch-font-faces.ts`); without it, folders are decoded whole. */
function readCoverage(): FontCoverage | null {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), FONT_COVERAGE_FILE), 'utf8')) as FontCoverage
  } catch {
    return null
  }
}

const facesOf = facesFrom(fontsDir, readCoverage())
const metrics = createTextMetrics(facesOf)
installSketchDom(metrics)

type Excalidraw = typeof import('@excalidraw/excalidraw')
type Elements = Parameters<Excalidraw['exportToSvg']>[0]['elements']
/** An element as it travels: what this file reads of it, the rest passed through. */
type Plain = { readonly id: string; readonly containerId?: string | null; readonly [field: string]: unknown }

// After the DOM: Excalidraw reads `window` and `document` when it loads.
const loading: Promise<{ excalidraw: Excalidraw; fileable: (svg: SVGSVGElement) => string }> = Promise.all([
  import('@excalidraw/excalidraw'),
  import('./sketch-svg'),
]).then(([excalidraw, svg]) => {
  excalidraw.setCustomTextMetricsProvider({ getLineWidth: (text: string, font: string) => metrics.lineWidth(text, font) })
  return { excalidraw, fileable: svg.fileableSketchSvg }
})

/**
 * Each container grown to hold its label laid out again, and the label placed
 * in it (`sketch-label-fit.ts`): Excalidraw wraps a label to its box but grows
 * the box only in the editor. A grown container joins `remeasured`.
 */
function fitContainers(elements: readonly Plain[], remeasure: ReadonlySet<string>, remeasured: Record<string, unknown>[]): readonly Plain[] {
  const byId = new Map(elements.map((element) => [element.id, element]))
  const changes = new Map<string, Record<string, unknown>>()
  for (const element of elements) {
    if (!remeasure.has(element.id) || !element.containerId) continue
    const container = byId.get(element.containerId)
    if (!container) continue
    const fit = fitContainerToLabel(container as unknown as Parameters<typeof fitContainerToLabel>[0], element as unknown as Parameters<typeof fitContainerToLabel>[1])
    changes.set(element.id, fit.label)
    const laid = remeasured.find((entry) => entry.id === element.id)
    if (laid) Object.assign(laid, fit.label)
    if (fit.container) {
      changes.set(container.id, fit.container)
      remeasured.push(fit.container)
    }
  }
  return changes.size === 0 ? elements : elements.map((element) => (changes.has(element.id) ? { ...element, ...changes.get(element.id) } : element))
}

/** A transparent pixel: the stand-in Excalidraw draws an underlay with, never filed. */
const STAND_IN = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function underlayFileOf(elements: readonly Plain[]): string | null {
  // A tombstoned image is no underlay: Excalidraw draws no deleted element, so it would place nothing.
  const image = elements.find((element) => element.type === 'image' && !element.isDeleted && typeof element.fileId === 'string')
  return image ? (image.fileId as string) : null
}

/** Where Excalidraw put the underlay, with its `<use>` and `<symbol>` taken out of the picture. */
function liftUnderlay(svg: SVGSVGElement, fileId: string): UnderlayPlacement | undefined {
  const use = svg.querySelector(`use[href="#image-${fileId}"]`)
  const group = use?.parentElement
  const translate = /translate\(\s*(-?[\d.e+-]+)[\s,]+(-?[\d.e+-]+)\s*\)/.exec(group?.getAttribute('transform') ?? '')
  svg.querySelector(`[id="image-${fileId}"]`)?.remove()
  group?.remove()
  if (!use || !translate) return undefined
  return { x: Number(translate[1]), y: Number(translate[2]), width: Number(use.getAttribute('width')), height: Number(use.getAttribute('height')) }
}

async function render(request: SketchRenderRequest): Promise<SketchRenderResponse> {
  const started = performance.now()
  const { excalidraw, fileable } = await loading
  const remeasure = new Set(request.remeasure)
  let elements = request.elements as readonly Plain[]
  const remeasured: Record<string, unknown>[] = []
  if (remeasure.size > 0) {
    // Only the texts to lay out and the containers they wrap in: restoring the whole scene would measure every text.
    const containers = new Set(elements.flatMap((element) => (remeasure.has(element.id) && element.containerId ? [element.containerId] : [])))
    const subset = elements.filter((element) => remeasure.has(element.id) || containers.has(element.id))
    const restored = excalidraw.restoreElements(subset as unknown as Elements, null, { refreshDimensions: true, repairBindings: true })
    const byId = new Map(restored.map((element) => [element.id, element as unknown as Plain]))
    elements = elements.map((element) => {
      const fresh = remeasure.has(element.id) ? byId.get(element.id) : undefined
      if (!fresh) return element
      // Only the layout changes; every other field stays as the save sent it (`sketch-picture.ts` stores the same).
      const laid = { id: fresh.id, x: fresh.x, y: fresh.y, width: fresh.width, height: fresh.height, text: fresh.text }
      remeasured.push(laid)
      return { ...element, ...laid }
    })
    elements = fitContainers(elements, remeasure, remeasured)
  }
  const fileId = underlayFileOf(elements)
  const svg = await excalidraw.exportToSvg({
    elements: elements as unknown as Elements,
    appState: {
      ...(request.appState ?? {}),
      exportBackground: fileId === null,
      viewBackgroundColor: '#ffffff',
      exportWithDarkMode: false,
    },
    files: fileId ? { [fileId]: { id: fileId, mimeType: 'image/png', dataURL: STAND_IN, created: 0 } } as never : null,
    exportPadding: 16,
    skipInliningFonts: true,
  })
  const underlay = fileId ? liftUnderlay(svg, fileId) : undefined
  const heapMb = Math.round(getHeapStatistics().used_heap_size / 2 ** 20)
  return { id: request.id, ok: true, svg: fileable(svg), remeasured, ms: Math.round(performance.now() - started), heapMb, ...(underlay ? { underlay } : {}) }
}

parentPort?.on('message', (request: SketchRenderRequest) => {
  render(request).then(
    (response) => parentPort?.postMessage(response),
    (error: unknown) =>
      parentPort?.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      } satisfies SketchRenderResponse)
  )
})
