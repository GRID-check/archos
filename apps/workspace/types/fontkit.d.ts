/**
 * Minimal ambient types for fontkit (the package ships no declarations).
 *
 * Only what the sketch renderer's text metrics read (`bff/diagrams/sketch-text-metrics.ts`,
 * `bff/diagrams/sketch-font-faces.ts`).
 */

declare module 'fontkit' {
  export interface Font {
    readonly unitsPerEm: number
    /** Every code point the font maps. */
    readonly characterSet: number[]
    hasGlyphForCodePoint(codePoint: number): boolean
    glyphForCodePoint(codePoint: number): { readonly advanceWidth: number }
    layout(text: string): { readonly positions: readonly { readonly xAdvance: number }[] }
  }
  export function create(buffer: Uint8Array): Font
}
