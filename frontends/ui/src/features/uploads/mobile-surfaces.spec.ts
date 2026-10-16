/**
 * Source ratchets for the upload surfaces on a 393px phone.
 *
 * Each of these was a measured defect (the Archiv header 627px wide in a 393px
 * card, a running import row that rendered only a spinner, a file name cut at
 * its end so two Fassungen read alike). None shows in jsdom, which has no
 * layout, so the class that fixed each is held in the source: the next edit that
 * reintroduces the cause fails here instead of on somebody's phone.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blankComments } from '../../../scripts/check-static-utility-modifiers.mjs'

const FEATURES = join(__dirname, '..')
const read = (...parts: string[]): string =>
  blankComments(readFileSync(join(FEATURES, ...parts), 'utf8')) as string

describe('Archiv header', () => {
  const source = read('documents', 'components', 'archiv-workspace.tsx')

  it('lets the controls group shrink to the card instead of keeping its single-line width', () => {
    const group = source.match(/data-testid="archiv-controls"/)
    expect(group).not.toBeNull()
    const open = source.lastIndexOf('<div', group!.index)
    const classes = source.slice(open, group!.index)
    expect(classes).toContain('max-w-full')
    expect(classes).not.toMatch(/\bshrink-0\b/)
  })

  it('puts the controls on their own full-width line on a phone', () => {
    expect(source).toMatch(/max-sm:w-full/)
  })
})

describe('upload tray rows', () => {
  const source = read('documents', 'components', 'upload-tray.tsx')

  it('keeps the end of a file name', () => {
    expect(source).toContain('<MiddleTruncate text={file.fileName}')
  })

  it('draws no text under 12px; the extension chip is the shared tile, not a copy', () => {
    const small = [...source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].filter((m) => Number(m[1]) < 12)
    expect(small.map((m) => m[0])).toEqual([])
    expect(source).toContain('<FileExtChip filename={file.fileName} size="xs"')
  })
})

describe('mail import rows', () => {
  const source = read('documents', 'components', 'mail-import-dialog.tsx')

  it('wraps the actions under the text on a phone, so the name keeps its width', () => {
    expect(source).toMatch(/<Item as="li" className="flex-wrap/)
    expect(source).toMatch(/<ItemActions className="[^"]*max-sm:basis-full/)
  })
})

describe('upload history rows', () => {
  it('keeps the summary link inside the content, so the pills get the whole row', () => {
    expect(read('uploads', 'components', 'upload-history.tsx')).not.toContain('<ItemActions')
  })
})
