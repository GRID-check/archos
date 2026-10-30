/**
 * The picture a mark on a model keeps: what the viewer showed, downsized.
 *
 * BCF viewers expect a snapshot of at most 1500 px on the longest side, and the
 * API takes at most 1.5 MB of it (`MAX_SNAPSHOT_BYTES`). The renderer's capture
 * is a full-resolution PNG of the canvas, several megabytes on a retina screen,
 * so it is drawn smaller on a canvas and sent as a JPEG. Decoding and drawing
 * are injected: the arithmetic is tested here, the pixels in a browser.
 */

import { MAX_SNAPSHOT_BYTES, type SnapshotInput } from '@/lib/annotations/viewpoint-types'

export const SNAPSHOT_MAX_SIDE = 1500
/** JPEG qualities tried in order until the bytes fit the wire. */
export const SNAPSHOT_QUALITIES = [0.85, 0.7, 0.55] as const

/** `width` x `height` scaled down (never up) so the longest side is at most `max`. */
export function fitWithin(width: number, height: number, max: number = SNAPSHOT_MAX_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!(longest > 0)) return { width: 0, height: 0 }
  if (longest <= max) return { width: Math.round(width), height: Math.round(height) }
  const scale = max / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Decoded size of a base64 payload, without decoding it. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** A decoded image that can draw itself at a size and encode that as JPEG. */
export interface Raster {
  width: number
  height: number
  toJpeg(width: number, height: number, quality: number): string
}

export type DecodeImage = (dataUrl: string) => Promise<Raster>

const JPEG_PREFIX = 'data:image/jpeg;base64,'

/**
 * The capture as a wire snapshot, or null when it cannot be made small enough
 * (the mark is then set without a picture rather than not at all).
 */
export async function downsizeSnapshot(dataUrl: string, decode: DecodeImage = decodeInBrowser): Promise<SnapshotInput | null> {
  try {
    const raster = await decode(dataUrl)
    const size = fitWithin(raster.width, raster.height)
    if (size.width === 0) return null
    for (const quality of SNAPSHOT_QUALITIES) {
      const encoded = raster.toJpeg(size.width, size.height, quality)
      if (!encoded.startsWith(JPEG_PREFIX)) return null
      const dataBase64 = encoded.slice(JPEG_PREFIX.length)
      if (base64Bytes(dataBase64) <= MAX_SNAPSHOT_BYTES) return { contentType: 'image/jpeg', dataBase64 }
    }
    return null
  } catch {
    return null
  }
}

/** The browser's decoder: an `Image` drawn on a canvas, over white (a JPEG has no alpha). */
export const decodeInBrowser: DecodeImage = (dataUrl) =>
  new Promise<Raster>((resolve, reject) => {
    const image = new Image()
    image.onload = () =>
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
        toJpeg: (width, height, quality) => {
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          if (!context) throw new Error('no 2d context')
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, width, height)
          context.drawImage(image, 0, 0, width, height)
          return canvas.toDataURL('image/jpeg', quality)
        },
      })
    image.onerror = () => reject(new Error('snapshot could not be decoded'))
    image.src = dataUrl
  })
