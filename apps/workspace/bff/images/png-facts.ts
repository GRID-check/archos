/**
 * What a PNG says about itself in its first 24 bytes: that it is one (the
 * signature), and its size (the IHDR chunk). Read before a raster is cached,
 * embedded in a filed Skizze or handed to the PDF renderer, so bytes that only
 * claim to be a page's picture never get that far (S6, ADR-0150).
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR = [0x49, 0x48, 0x44, 0x52]

export interface PngFacts {
  width: number
  height: number
}

/** The PNG's size, or null when the bytes are no PNG (wrong signature, no IHDR first, a zero side). */
export function pngFacts(bytes: Uint8Array): PngFacts | null {
  if (bytes.byteLength < 24) return null
  if (SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null
  if (IHDR.some((byte, index) => bytes[12 + index] !== byte)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}
