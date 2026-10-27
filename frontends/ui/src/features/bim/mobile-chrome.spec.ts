// @disk-inputs: src/features/bim/components/**
/**
 * The classes of mobile defect the viewer's chrome was found with, held as
 * source ratchets.
 *
 * Pixels belong to a browser and a device; these are the cheap invariants that
 * can fail on every commit. Each one is a defect that read as correct in a
 * desktop screenshot and in review — the markup was right, the glass was not.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { blankComments } from '../../../scripts/check-static-utility-modifiers.mjs'

const COMPONENTS = join(__dirname, 'components')

/** A file with its comment bodies blanked, so prose about a defect cannot trip its own ratchet. */
const code = (...segments: string[]): string =>
  blankComments(readFileSync(join(COMPONENTS, ...segments), 'utf8')) as string

const sources = (dir = COMPONENTS): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx$/.test(entry.name) && !/\.spec\.tsx$/.test(entry.name) ? [path] : []
  })

describe('the stage respects the notch at every width', () => {
  it('pads the dialog by the safe-area insets without a breakpoint prefix', () => {
    const stage = code('model-stage.tsx')
    // An iPhone on its side is 852 px wide — past `sm` — with the deepest inset
    // of all. `max-sm:` padding left the dock, the rail and the close pill under
    // the sensor housing in exactly that rotation.
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(stage).toContain(`env(safe-area-inset-${side})`)
      expect(stage).not.toContain(`max-sm:p${side[0]}-[env(safe-area-inset-${side})]`)
    }
  })
})

describe('a hover is never the only way to read a value', () => {
  it('no truncated value hides its full text in a title attribute', () => {
    // `title` renders nothing on iOS Safari. A GlobalId or a type name ending
    // in an ellipsis with its remainder in a `title` is unreadable on a phone.
    // An element that truncates AND titles itself must also let go of the
    // truncation under a finger.
    const offenders: string[] = []
    for (const file of sources()) {
      const source = blankComments(readFileSync(file, 'utf8')) as string
      for (const match of source.matchAll(/<(?:dd|span|p|h\d|div)\b[^>]*>/g)) {
        const tag = match[0]
        if (!/\btruncate\b/.test(tag) || !/\btitle=/.test(tag)) continue
        if (/pointer-coarse:(?:line-clamp|whitespace-normal)/.test(tag)) continue
        offenders.push(
          `${file.slice(COMPONENTS.length + 1)}: ${tag.replace(/\s+/g, ' ').slice(0, 100)}`
        )
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('an inline link in the compliance panel is a touch target', () => {
  it('every underlined link carries the 44 px treatment', () => {
    const panel = code('ifc-compliance-panel.tsx')
    // "im Modell zeigen" measured 93 x 16 and the element names 65 x 16 — the
    // one action on the panel that matters, on a line box.
    const underlined = [...panel.matchAll(/['"`][^'"`]*underline underline-offset-2[^'"`]*['"`]/g)]
    expect(underlined.length).toBeGreaterThanOrEqual(3)
    for (const match of underlined) {
      expect(match[0], match[0]).toContain('${TOUCH_LINK}')
    }
    expect(panel).toMatch(/TOUCH_LINK =\s*'[^']*pointer-coarse:min-h-11/)
  })

  it('the model health "show elements" button reaches the floor too', () => {
    expect(code('ifc-model-explorer.tsx')).toMatch(/pointer-coarse:min-h-11"/)
  })
})

describe('only a surface that owns its gesture keeps the touch action', () => {
  it('limits touch-none to the canvas and the sheet handle', () => {
    // The Touch rule: a `touch-action` that refuses the vertical pan strands
    // every finger that lands on it. The 3D canvas owns orbit and pinch; the
    // sheet handle owns a drag. Nothing else in the viewer may.
    const allowed = new Set(['ifc-viewer-canvas.tsx', join('viewer', 'viewer-sheet.tsx')])
    const offenders = sources()
      .filter((file) => /\btouch-none\b/.test(blankComments(readFileSync(file, 'utf8')) as string))
      .map((file) => file.slice(COMPONENTS.length + 1))
      .filter((file) => !allowed.has(file))
    expect(offenders).toEqual([])
  })
})

describe('the canvas tells a tap from a drag by what is pressing', () => {
  it('uses the per-pointer slop, not a constant two pixels', () => {
    const canvas = code('ifc-viewer-canvas.tsx')
    expect(canvas).toContain('dragSlopFor(')
    expect(canvas).not.toContain('DRAG_SLOP_PX')
  })

  it('recognises a double-tap itself rather than waiting for a dblclick iOS may not send', () => {
    const canvas = code('ifc-viewer-canvas.tsx')
    expect(canvas).toContain('isDoubleTap(')
  })
})

describe('the phone dock fits', () => {
  it('never scrolls sideways: the phone layouts have no overflow row', () => {
    const dock = code('viewer', 'viewer-dock.tsx')
    // The scrolling row belongs to the floating (desktop) layout only; the bar
    // and the column are handled before it is reached.
    const phoneBranch = dock.slice(
      dock.indexOf("layout !== 'floating'"),
      dock.indexOf('overflow-x-auto')
    )
    expect(phoneBranch).toContain('viewer-dock-bar')
    expect(phoneBranch).not.toContain('overflow-x-auto')
  })
})
