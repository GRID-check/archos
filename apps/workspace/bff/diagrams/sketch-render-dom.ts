/**
 * The document Excalidraw expects, inside the sketch renderer's worker thread
 * and nowhere else (ADR-0149).
 *
 * Excalidraw's export reads `window`, `document`, `DOMParser` and
 * `XMLSerializer` at import time and creates a canvas for text metrics and
 * shape caching. happy-dom provides the document; its canvas has no 2D
 * context, so `getContext` answers a stand-in whose `measureText` is
 * {@link TextMetrics} and whose drawing calls do nothing (an SVG export draws
 * nothing on a canvas). `Path2D` is a stand-in for the freehand path cache.
 * `document.fonts` and `FontFace` are stubs: the export is asked not to inline
 * fonts (`skipInliningFonts`), so nothing is fetched.
 *
 * Imported first by `sketch-render-worker.ts`, before Excalidraw, and only in
 * a worker: setting these on the Next server's own globals would turn every
 * `typeof window` check in the server into a lie. `installSketchDom` refuses to
 * run on the main thread.
 */

import { isMainThread } from 'node:worker_threads'
import { Window } from 'happy-dom'
import type { TextMetrics } from './sketch-text-metrics'

type Globals = Record<string, unknown>

/** A 2D context that measures text and draws nothing. */
function contextStandIn(metrics: TextMetrics): unknown {
  const state: { font: string } = { font: '10px sans-serif' }
  const own: Record<string | symbol, unknown> = {
    measureText: (text: string) => {
      const width = metrics.lineWidth(String(text), state.font)
      return { width, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width }
    },
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
  }
  return new Proxy(own, {
    get: (target, key) => (key === 'font' ? state.font : key in target ? target[key] : () => undefined),
    set: (_target, key, value) => {
      if (key === 'font') state.font = String(value)
      return true
    },
  })
}

class Path2DStandIn {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
}

function fontsStandIn() {
  const faces = new Set<unknown>()
  return {
    add: (face: unknown) => faces.add(face),
    delete: (face: unknown) => faces.delete(face),
    has: (face: unknown) => faces.has(face),
    check: () => true,
    load: async () => [],
    ready: Promise.resolve(),
    addEventListener() {},
    removeEventListener() {},
    forEach: (each: (face: unknown) => void) => faces.forEach(each),
    [Symbol.iterator]: () => faces[Symbol.iterator](),
    get size() {
      return faces.size
    },
  }
}

class FontFaceStandIn {
  readonly status = 'loaded'
  constructor(
    readonly family: string,
    readonly source: unknown,
    descriptors?: Record<string, unknown>
  ) {
    Object.assign(this, descriptors ?? {})
  }
  load(): Promise<this> {
    return Promise.resolve(this)
  }
}

/** The names Excalidraw reads from the global scope, copied from happy-dom's window. */
const WINDOW_GLOBALS = [
  'document',
  'DOMParser',
  'XMLSerializer',
  'HTMLElement',
  'Element',
  'Node',
  'SVGElement',
  'HTMLCanvasElement',
  'HTMLImageElement',
  'Image',
  'getComputedStyle',
  'location',
  'MutationObserver',
  'DocumentFragment',
] as const

/**
 * The document runs nothing and loads nothing: no script evaluated or fetched,
 * no stylesheet, image or frame loaded, no navigation, on `about:blank`. No
 * path from scene content reaches any of these today (element types are
 * fenced, links dropped, files refused, the SVG never attached); this is the
 * second wall, should one ever open.
 */
export const SKETCH_DOM_OPTIONS = {
  url: 'about:blank',
  settings: {
    enableJavaScriptEvaluation: false,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
    enableImageFileLoading: false,
    disableIframePageLoading: true,
    handleDisabledFileLoadingAsSuccess: true,
    navigation: {
      disableMainFrameNavigation: true,
      disableChildFrameNavigation: true,
      disableChildPageNavigation: true,
      disableFallbackToSetURL: true,
    },
  },
} as const

/** Install the document on this worker's globals. Throws on the main thread. */
export function installSketchDom(metrics: TextMetrics): void {
  if (isMainThread) throw new Error('the sketch DOM is installed only inside its worker thread')
  const window = new Window(SKETCH_DOM_OPTIONS)
  const scope = globalThis as unknown as Globals
  const win = window as unknown as Globals
  for (const name of WINDOW_GLOBALS) scope[name] = win[name]
  scope.window = window
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
  const raf = (callback: (time: number) => void) => setTimeout(() => callback(performance.now()), 0)
  const matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
  for (const target of [scope, win]) {
    target.devicePixelRatio = 1
    target.requestAnimationFrame = raf
    target.cancelAnimationFrame = clearTimeout
    target.matchMedia = matchMedia
    target.FontFace = FontFaceStandIn
    target.Path2D = Path2DStandIn
  }
  Object.defineProperty(window.document, 'fonts', { value: fontsStandIn(), configurable: true })
  const canvas = (window as unknown as { HTMLCanvasElement: { prototype: { getContext: unknown } } }).HTMLCanvasElement
  canvas.prototype.getContext = function getContext() {
    return contextStandIn(metrics)
  }
  // Nothing is fetched: fonts are not inlined, and a sketch has no images.
  const refuse = async () => {
    throw new Error('the sketch renderer fetches nothing')
  }
  scope.fetch = refuse
  win.fetch = refuse
}
