/**
 * The page under a filed Skizze, in its SVG and its PDF (S6, ADR-0150).
 *
 * **The validator learns nothing.** `svg.ts` still refuses every `<image>`,
 * `<use>`, `<symbol>` and `data:` reference, whoever sent it. The underlay is
 * not admitted through it: the server writes the one image a Skizze may carry
 * itself, AFTER the vector picture passed the validator, into one fixed slot,
 * the first child of the root:
 *
 *     <svg …><image data-underlay="" data-sha256="…" x=… y=… width=… height=…
 *       preserveAspectRatio="none" href="data:image/png;base64,…"/>…
 *
 * and every reader of a stored Skizze lifts exactly that slot out
 * ({@link liftUnderlayImage}) before the rest goes through the validator again.
 * An `<image>` anywhere else, of any other form, is still the validator's
 * `unsupported-element`. That is a smaller trust surface than teaching the
 * validator an image rule or the minimal `<use href="#…">`: no client-sent
 * picture of any kind is ever parsed as one, and the PNG in the slot is always
 * the server's own raster (`documents/page-raster.ts`), checked by its signature
 * and size when it is written and again when it is read. The slot carries the
 * PNG's SHA-256: a lift refuses a slot whose bytes are not the ones hashed, and
 * a redraw compares the hash with the server's raster of the page the scene
 * names (`underlayForRendition`), so a forged slot draws nothing.
 *
 * **The PDF gets the bytes, never a URL.** `svg-to-pdf.tsx` hands the PNG to
 * @react-pdf's `<Image>` as a Buffer through `src` (spike r3: given an http
 * address it fetched it, server-side, which would be SSRF).
 *
 * **Its own budget.** The vector picture keeps the 1 MiB cap
 * (`MAX_DIAGRAM_SVG_BYTES`); the page adds at most {@link MAX_UNDERLAY_PNG_BYTES}
 * of PNG, base64 in the file.
 */

import { createHash } from 'node:crypto'
import { pngFacts } from '@/lib/images/png-facts'
import { MAX_PAGE_RASTER_BYTES, MAX_PAGE_RASTER_LONG_SIDE } from '@/lib/documents/page-raster-limits'
import type { UnderlayPlacement } from './sketch-render-types'

export const MAX_UNDERLAY_PNG_BYTES = MAX_PAGE_RASTER_BYTES
/** What the slot adds to a stored Skizze at most: the PNG in base64, and its markup. */
export const MAX_UNDERLAY_SLOT_BYTES = Math.ceil(MAX_UNDERLAY_PNG_BYTES / 3) * 4 + 256

export interface EmbeddedUnderlay extends UnderlayPlacement {
  png: Uint8Array
}

/** The hash a slot carries of its PNG. */
export const underlayPngHash = (png: Uint8Array): string => createHash('sha256').update(png).digest('hex')

export class UnderlayImageError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'UnderlayImageError'
  }
}

const NUM = '(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)'
const ROOT = /^(<\?xml[^?]*\?>)?<svg\b[^>]*>/
const SLOT = new RegExp(
  `^<image data-underlay="" data-sha256="([0-9a-f]{64})" x="${NUM}" y="${NUM}" width="${NUM}" height="${NUM}" preserveAspectRatio="none" href="data:image/png;base64,([A-Za-z0-9+/]+={0,2})"/>`
)

/** The PNG kept only when it is one, within the raster's size and bytes. */
function checked(png: Uint8Array): Uint8Array {
  const facts = pngFacts(png)
  if (!facts) throw new UnderlayImageError('the underlay is no PNG')
  if (Math.max(facts.width, facts.height) > MAX_PAGE_RASTER_LONG_SIDE) throw new UnderlayImageError('the underlay is larger than a page raster')
  if (png.byteLength > MAX_UNDERLAY_PNG_BYTES) throw new UnderlayImageError('the underlay weighs more than its budget')
  return png
}

const finite = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1_000_000

/** `svg` (the validator's own output) with the page in the slot. Throws {@link UnderlayImageError}. */
export function withUnderlayImage(svg: string, underlay: EmbeddedUnderlay): string {
  const root = ROOT.exec(svg)
  if (!root) throw new UnderlayImageError('no root to put the underlay in')
  const { x, y, width, height } = underlay
  if (![x, y, width, height].every(finite) || width <= 0 || height <= 0) throw new UnderlayImageError('the underlay has no place')
  const png = checked(underlay.png)
  const href = Buffer.from(png).toString('base64')
  const slot = `<image data-underlay="" data-sha256="${underlayPngHash(png)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" href="data:image/png;base64,${href}"/>`
  return svg.slice(0, root[0].length) + slot + svg.slice(root[0].length)
}

/**
 * A stored Skizze's SVG without its slot, and the page that was in it; the
 * SVG unchanged and `null` when there is none. A slot whose PNG is no PNG, or
 * too large, throws: those bytes were not written by this module.
 */
export function liftUnderlayImage(svg: string): { svg: string; underlay: EmbeddedUnderlay | null } {
  const root = ROOT.exec(svg)
  if (!root) return { svg, underlay: null }
  const rest = svg.slice(root[0].length)
  const slot = SLOT.exec(rest)
  if (!slot) return { svg, underlay: null }
  const [whole, sha256, x, y, width, height, base64] = slot
  const png = checked(new Uint8Array(Buffer.from(base64, 'base64')))
  if (underlayPngHash(png) !== sha256) throw new UnderlayImageError('the underlay is not the page its slot names')
  return {
    svg: root[0] + rest.slice(whole.length),
    underlay: { x: Number(x), y: Number(y), width: Number(width), height: Number(height), png },
  }
}
