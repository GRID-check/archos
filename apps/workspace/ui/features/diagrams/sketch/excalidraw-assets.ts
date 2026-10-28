/**
 * Where Excalidraw loads its fonts from: this origin, never its CDN.
 *
 * Excalidraw fetches webfonts from a public CDN unless
 * `window.EXCALIDRAW_ASSET_PATH` names another place, and falls back to that
 * CDN for any font it cannot load. `scripts/copy-excalidraw-assets.mjs` stages
 * them into `public/excalidraw/`. Both modules that import Excalidraw import
 * this first, so the path is set before Excalidraw reads it (ADR-0141).
 */

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
  }
}

if (typeof window !== 'undefined') window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'

export {}
