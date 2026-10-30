/**
 * Text set in a brand face, as SVG path data: the icon's initial and the share
 * card's wordmark and claim are outlines, so no font is needed where they are
 * shown (a favicon, a social preview, a raster render with sharp).
 *
 * The font is read with fontkit (borrowed from `apps/website/node_modules`, like
 * sharp), which shapes the run with the font's own kerning. Tracking is in em,
 * as CSS `letter-spacing` sets it: the wordmark's is -0.02em. Coordinates are
 * rounded to two decimals so the output is stable from one run to the next.
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

/** fontkit from the website's install; `null` when that install is missing. */
export function loadFontkit(siteRoot) {
  try {
    return createRequire(resolve(siteRoot, 'package.json'))('fontkit')
  } catch {
    return null
  }
}

const round = (n) => {
  const r = Math.round(n * 100) / 100
  return Object.is(r, -0) ? '0' : String(r)
}

/** One glyph's outline, scaled by `s` (y flipped) and moved to `(x, y)`, as path data. */
function glyphPath(glyph, s, x, y) {
  const pt = (px, py) => `${round(x + px * s)} ${round(y - py * s)}`
  return glyph.path.commands
    .map(({ command, args }) => {
      const pts = []
      for (let i = 0; i < args.length; i += 2) pts.push(pt(args[i], args[i + 1]))
      switch (command) {
        case 'moveTo': return `M${pts[0]}`
        case 'lineTo': return `L${pts[0]}`
        case 'quadraticCurveTo': return `Q${pts.join(' ')}`
        case 'bezierCurveTo': return `C${pts.join(' ')}`
        case 'closePath': return 'Z'
        default: throw new Error(`unknown path command ${command}`)
      }
    })
    .join('')
}

/**
 * `text` in `font` at `size` (the font size, in the output's units), its
 * baseline's left end at `(x, y)`. Returns the path data, the advance width the
 * run takes (without trailing tracking) and the ink box of the run's outlines.
 */
export function outline(font, text, { size, x = 0, y = 0, tracking = 0 }) {
  const s = size / font.unitsPerEm
  const run = font.layout(text)
  const track = tracking * font.unitsPerEm
  let pen = 0
  const parts = []
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i]
    const gx = pen + pos.xOffset
    parts.push(glyphPath(glyph, s, x + gx * s, y - pos.yOffset * s))
    const b = glyph.path.bbox
    if (Number.isFinite(b.minX)) {
      minX = Math.min(minX, gx + b.minX); maxX = Math.max(maxX, gx + b.maxX)
      minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY)
    }
    pen += pos.xAdvance + (i < run.glyphs.length - 1 ? track : 0)
  })
  return {
    d: parts.join(''),
    advance: pen * s,
    ink: { left: x + minX * s, right: x + maxX * s, top: y - maxY * s, bottom: y - minY * s },
  }
}
