/**
 * Measuring a text run the way pdf.js's text layer does.
 *
 * The text layer sets each run in its style's font family, measures it once on
 * a 2D canvas and stretches it (`--scale-x`) to the width the PDF gives the run.
 * So inside a run, the share of that measurement a prefix takes is where the
 * text layer's glyphs, and the page's under them, end. Measuring the same way
 * puts the end of a passage highlight on the end of its last letter, where a
 * share by character count stopped a glyph short.
 */

import { countCharacters, type MeasureText } from './passage-highlight'

/** The size measured at. Only ratios within one run are used, so any size serves. */
const MEASURE_SIZE = 100

let context: CanvasRenderingContext2D | null | undefined
/** The font last set on the shared context; `ctx.font` reads back normalised, so it is kept here. */
let fontSet = ''

const canvasContext = (): CanvasRenderingContext2D | null => {
  if (context !== undefined) return context
  try {
    context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  } catch {
    // jsdom without the canvas package throws "not implemented" rather than returning null.
    context = null
  }
  return context
}

/**
 * The canvas measure, or counting characters where there is no canvas (the
 * server, a unit test). A run with no font family is measured in the text
 * layer's own fallback, `sans-serif`.
 */
export const canvasMeasure = (): MeasureText => {
  const ctx = canvasContext()
  if (!ctx) return countCharacters
  return (text, fontFamily) => {
    const font = `${MEASURE_SIZE}px ${fontFamily || 'sans-serif'}`
    if (font !== fontSet) {
      ctx.font = font
      fontSet = font
    }
    return ctx.measureText(text).width
  }
}
