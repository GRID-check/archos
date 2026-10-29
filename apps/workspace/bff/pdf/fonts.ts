/**
 * The PDF's one brand face: the wordmark in Switzer Semibold.
 *
 * ## Why only the wordmark
 *
 * The corporate design sets the product's name in Switzer Semibold and the
 * body in General Sans. react-pdf (fontkit) embeds Switzer's static file as it
 * is. It does not embed General Sans: the brand ships only the variable
 * WOFF2, and registering it renders every glyph blank (measured with
 * `pdftoppm` on a probe page, 2026-10-29), because the variable font's
 * instance is not subsetted into the PDF. The body therefore stays on the
 * built-in Helvetica (see `blocks-to-pdf.tsx`) until the brand package ships a
 * static General Sans Medium (TTF or OTF); then `BODY_FAMILY` is the line that
 * changes.
 *
 * The file is read from the synced brand copy (`shared/brand/fonts`, written by
 * `packages/brand/sync.mjs`), relative to the working directory the app runs
 * from. The image carries the whole tree, so it is there; if it is not (a test
 * run from elsewhere), the wordmark falls back to bold Helvetica instead of
 * failing the export.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Font } from '@react-pdf/renderer'

const WORDMARK_FILE = join(process.cwd(), 'shared', 'brand', 'fonts', 'Switzer-Semibold.woff2')

/** The registered family name; the file is Switzer Semibold (600). */
const WORDMARK_FAMILY = 'Switzer'

let wordmarkFace: { fontFamily: string; fontWeight?: 'bold' } | null = null

/** The style that sets the wordmark: Switzer Semibold when the file is there, bold Helvetica when not. */
export function wordmarkFontStyle(): { fontFamily: string; fontWeight?: 'bold' } {
  if (wordmarkFace) return wordmarkFace
  if (existsSync(WORDMARK_FILE)) {
    Font.register({ family: WORDMARK_FAMILY, src: WORDMARK_FILE })
    wordmarkFace = { fontFamily: WORDMARK_FAMILY }
  } else {
    wordmarkFace = { fontFamily: 'Helvetica', fontWeight: 'bold' }
  }
  return wordmarkFace
}
