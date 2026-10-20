/**
 * The two inks of the overlay.
 *
 * Each page is repainted so its dark lines take one colour and its paper stays
 * white, then the two are multiplied. A line present in both lands on the same
 * pixels, and cyan times orange is near-black, so unchanged work reads as the
 * neutral drawing it always was. A line only the older Fassung has stays cyan; a
 * line only the newer has stays orange. The pair is chosen to be told apart by
 * the common colour-vision deficiencies (blue against orange, not red against
 * green), and the legend names them so colour is never the only carrier.
 */

export type Rgb = readonly [number, number, number]

export const OLDER_INK: Rgb = [0, 140, 255]
export const NEWER_INK: Rgb = [255, 90, 0]

export const rgbCss = ([r, g, b]: Rgb): string => `rgb(${r} ${g} ${b})`

/**
 * Recolour a painted page in place: dark pixels become `ink`, white stays white.
 *
 * `lighten` keeps the brighter of each channel, so black becomes the ink and
 * white is untouched, with the antialiasing grey in between mapped smoothly.
 * No pixel is read back, so a canvas fed from a cross-origin image does not
 * taint. Does nothing where the 2D context is unavailable.
 */
export function tintCanvas(canvas: HTMLCanvasElement, ink: Rgb): void {
  const context = canvas.getContext('2d')
  if (!context || canvas.width === 0 || canvas.height === 0) return
  context.save()
  context.globalCompositeOperation = 'lighten'
  context.fillStyle = rgbCss(ink)
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.restore()
}

/**
 * Where two inks overlap after `mix-blend-multiply`: what unchanged work turns
 * into in the overlay. The legend's swatch is THIS colour, computed rather than
 * picked, so the key cannot drift from the sheet (cyan times orange is a dark
 * green, not the black a label might promise).
 */
export const multiplyInks = (a: Rgb, b: Rgb): Rgb => [
  Math.round((a[0] * b[0]) / 255),
  Math.round((a[1] * b[1]) / 255),
  Math.round((a[2] * b[2]) / 255),
]

export const UNCHANGED_INK: Rgb = multiplyInks(OLDER_INK, NEWER_INK)

/**
 * The colours of things drawn ON the sheet, which is white paper in both
 * themes. A theme token would flip to near-white in dark mode and vanish on
 * the page (the swipe divider did), so these are fixed, and they are the one
 * place this surface names colours itself.
 *
 *  - `PAPER`: the sheet.
 *  - `PAPER_INK`: the divider and the sheet tags, the drawing's own near-black.
 *  - `MARK_INK`: the boxes Piloti draws and their numbers, the office gold at its
 *    text weight (`--source-office-text` in light mode). 4.9:1 on white, so a
 *    2 px outline clears the 3:1 non-text bar; its hue is not either overlay
 *    ink's, and in the overlay the boxes are dashed as well, so a box is never
 *    told from the orange "new" ink by colour alone.
 */
export const PAPER: Rgb = [255, 255, 255]
export const PAPER_INK: Rgb = [31, 32, 35]
export const MARK_INK: Rgb = [150, 105, 14]

/**
 * The paper palette as CSS custom properties, set once on the comparison's
 * root so its parts (the boxes, the list's badges, the divider) read one value.
 */
export function paperVariables(): Record<`--${string}`, string> {
  return {
    '--compare-paper': rgbCss(PAPER),
    '--compare-paper-ink': rgbCss(PAPER_INK),
    '--compare-mark': rgbCss(MARK_INK),
    '--compare-mark-fill': `rgb(${MARK_INK.join(' ')} / 8%)`,
    '--compare-mark-fill-active': `rgb(${MARK_INK.join(' ')} / 16%)`,
  }
}

/**
 * WCAG relative luminance contrast between two colours, for the specs that
 * hold the paper palette to its thresholds.
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const luminance = (rgb: Rgb): number => {
    const [r, g, bl] = rgb.map((channel) => {
      const c = channel / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
