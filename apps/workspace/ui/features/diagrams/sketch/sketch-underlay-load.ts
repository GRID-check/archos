/**
 * The page under a Skizze, loaded into the canvas (S6, ADR-0150): its raster
 * from the same-origin route with this reader's rights, as the data URL
 * Excalidraw's `addFiles` takes under the element's own `fileId`. A reader who
 * may not open the base document gets a 404 and sees the strokes on a blank
 * sheet (`unavailable`); nothing about the base is shown instead.
 *
 * Pure of Excalidraw, so `sketch-canvas.tsx` stays its only importer.
 */

import { pageRasterUrl } from '@/adapters/api/diagrams-client'
import { underlayOf } from '@/lib/diagrams/sketch-underlay'

export type UnderlayLoadState = 'shown' | 'unavailable'

export type UnderlayLoad =
  | { state: 'none' }
  | { state: 'unavailable' }
  | { state: 'shown'; file: { id: string; mimeType: 'image/png'; dataURL: string; created: number } }

function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** The underlay's file for `addFiles`, or why there is none. Never throws. */
export async function loadUnderlay(elements: readonly object[], signal?: AbortSignal): Promise<UnderlayLoad> {
  const underlay = underlayOf(elements as Parameters<typeof underlayOf>[0])
  if (!underlay) return { state: 'none' }
  const fileId = (elements as { id: string; fileId?: string }[]).find((element) => element.id === underlay.elementId)?.fileId
  if (!fileId) return { state: 'unavailable' }
  try {
    const response = await fetch(pageRasterUrl(underlay.ref), { signal })
    if (!response.ok || response.headers.get('content-type') !== 'image/png') return { state: 'unavailable' }
    return { state: 'shown', file: { id: fileId, mimeType: 'image/png', dataURL: await dataUrlOf(await response.blob()), created: Date.now() } }
  } catch {
    return { state: 'unavailable' }
  }
}
