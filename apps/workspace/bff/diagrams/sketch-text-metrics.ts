/**
 * How wide a line of text is in a sketch, measured on the server the way a
 * browser's canvas measures it, from the font files themselves (ADR-0149).
 *
 * Excalidraw stores every text element's `width` and `height` from
 * `ctx.measureText` at the moment the text is set. The server has no canvas,
 * so the sketch renderer (`sketch-render-worker.ts`) hands Excalidraw this as
 * its text metrics provider (`setCustomTextMetricsProvider`, Excalidraw 0.18's
 * own seam). It is deterministic: the same woff2 files the editor loads
 * (`public/excalidraw/fonts`, staged by `scripts/copy-excalidraw-assets.mjs`),
 * read with fontkit, so a label the server lays out has the width the editor
 * would give it. Measured against Chromium 2026-10-30: equal to 0.01 px on
 * every string of `__fixtures__/sketch-text-widths.json`.
 *
 * What a browser does, and so what this does:
 *
 *   - **Helvetica** (`fontFamily: 2`, every label Piloti writes) is a local
 *     font in Excalidraw, never fetched. Each platform resolves it to a face
 *     with Helvetica's advance widths (Helvetica on macOS, Arial on Windows,
 *     Liberation Sans on Linux; the three were made metric-compatible), so it
 *     is measured with Liberation Sans, which Excalidraw ships.
 *   - **A family split into unicode-range chunks** (Excalifont, Xiaolai):
 *     each character is measured in the first chunk that has its glyph, as
 *     the browser picks the `@font-face` whose range covers it.
 *   - **Kerning within a word, none across a space**: Chromium shapes each
 *     word on its own and adds the spaces' advances, so a pair like „ A“ is
 *     not kerned while „Wo“ is.
 *   - A character no face of the stack has falls back to Liberation Sans, then
 *     to the font's `.notdef` advance. A CJK label whose Xiaolai chunk is not
 *     in `fontFiles` is therefore measured in the fallback, which is wider or
 *     narrower than the browser's; Piloti writes German.
 *
 * Pure but for the fonts it is handed: the caller reads the files.
 */

/** The slice of a fontkit `Font` this module reads. */
export interface MetricsFont {
  readonly unitsPerEm: number
  hasGlyphForCodePoint(codePoint: number): boolean
  glyphForCodePoint(codePoint: number): { readonly advanceWidth: number }
  layout(text: string): { readonly positions: readonly { readonly xAdvance: number }[] }
}

/** Excalidraw's family names (`FONT_FAMILY`) → the folder under `public/excalidraw/fonts` that holds its faces. */
export const FONT_FOLDERS: Readonly<Record<string, string>> = {
  Helvetica: 'Liberation',
  'Liberation Sans': 'Liberation',
  Excalifont: 'Excalifont',
  Virgil: 'Virgil',
  Cascadia: 'Cascadia',
  Nunito: 'Nunito',
  'Lilita One': 'Lilita',
  'Comic Shanns': 'ComicShanns',
  Xiaolai: 'Xiaolai',
}

/** Widths remembered per provider; past this the memory starts over. */
const MAX_CACHED_WIDTHS = 20_000

/** The face every stack falls back to: Helvetica's metrics. */
export const FALLBACK_FOLDER = 'Liberation'

/** A CSS font shorthand as Excalidraw writes it (`getFontString`): `20px Helvetica, Segoe UI Emoji`. */
export function parseFontString(font: string): { size: number; families: string[] } {
  const match = /^\s*(\d+(?:\.\d+)?)px\s+(.+)$/.exec(font)
  if (!match) return { size: 20, families: [] }
  const families = match[2]
    .split(',')
    .map((family) => family.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  return { size: Number(match[1]), families }
}

export interface TextMetrics {
  /** The advance width of one line, in CSS pixels, as `ctx.measureText(text).width` answers it. */
  lineWidth(text: string, font: string): number
}

/**
 * A metrics provider over the faces of each folder. `facesOf(folder)` answers
 * the faces of one folder (all its unicode-range chunks, in any order), or an
 * empty list for a folder it does not have; it is asked once per folder.
 */
export function createTextMetrics(
  facesOf: (folder: string) => readonly MetricsFont[]
): TextMetrics {
  const cache = new Map<string, readonly MetricsFont[]>()
  const faces = (folder: string) => {
    let found = cache.get(folder)
    if (!found) {
      found = facesOf(folder)
      cache.set(folder, found)
    }
    return found
  }
  /**
   * A stack is its folders, in order, each read only when a character is not
   * in the folders before it: Xiaolai's CJK chunks (13 MB) are never decoded
   * for a German label.
   */
  interface Stack {
    folders: string[]
    chosen: Map<number, MetricsFont | null>
  }
  const stacks = new Map<string, Stack>()
  const stackOf = (families: readonly string[]): Stack => {
    const key = families.join(',')
    let stack = stacks.get(key)
    if (!stack) {
      const folders = [
        ...families.map((family) => FONT_FOLDERS[family]).filter(Boolean),
        FALLBACK_FOLDER,
      ]
      stack = { folders: [...new Set(folders)], chosen: new Map() }
      stacks.set(key, stack)
    }
    return stack
  }
  // Excalidraw's wrapping asks for the same words and characters over and over.
  const widths = new Map<string, number>()

  /** The face a character is set in, or null when no face of the stack exists at all. */
  const faceFor = (stack: Stack, codePoint: number): MetricsFont | null => {
    const known = stack.chosen.get(codePoint)
    if (known !== undefined) return known
    let face: MetricsFont | null = null
    for (const folder of stack.folders) {
      face = faces(folder).find((candidate) => candidate.hasGlyphForCodePoint(codePoint)) ?? null
      if (face) break
    }
    // No face has it: the browser draws the fallback's `.notdef`, so measure that.
    face ??=
      faces(FALLBACK_FOLDER)[0] ??
      stack.folders.map((folder) => faces(folder)[0]).find(Boolean) ??
      null
    stack.chosen.set(codePoint, face)
    return face
  }

  /** One word: runs of characters set in the same face, each shaped (and kerned) on its own. */
  const wordUnits = (word: string, stack: Stack): number => {
    let total = 0
    let run = ''
    let runFace: MetricsFont | null = null
    const flush = () => {
      if (run && runFace) total += sumAdvances(runFace, run) / runFace.unitsPerEm
      run = ''
    }
    for (const char of word) {
      const face = faceFor(stack, char.codePointAt(0) ?? 0)
      if (face !== runFace) {
        flush()
        runFace = face
      }
      run += char
    }
    flush()
    return total
  }

  return {
    lineWidth(text, font) {
      const key = `${font}\u0000${text}`
      const known = widths.get(key)
      if (known !== undefined) return known
      const width = measure(text, font)
      if (widths.size >= MAX_CACHED_WIDTHS) widths.clear()
      widths.set(key, width)
      return width
    },
  }

  function measure(text: string, font: string): number {
    const { size, families } = parseFontString(font)
    const stack = stackOf(families)
    const space = faceFor(stack, 32)
    if (!space || text.length === 0) return 0
    const spaceEm = space.glyphForCodePoint(32).advanceWidth / space.unitsPerEm
    const words = text.split(' ')
    const em =
      words.reduce((sum, word) => sum + (word ? wordUnits(word, stack) : 0), 0) +
      (words.length - 1) * spaceEm
    return em * size
  }
}

function sumAdvances(face: MetricsFont, text: string): number {
  let units = 0
  for (const position of face.layout(text).positions) units += position.xAdvance
  return units
}
