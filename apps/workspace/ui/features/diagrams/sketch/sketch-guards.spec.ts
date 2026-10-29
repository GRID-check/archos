// @disk-inputs: ui/features/diagrams/sketch/sketch-canvas.tsx
/**
 * The sketch editor offers no AI and no mermaid import (ADR-0141, amended).
 *
 * Excalidraw 0.18.1 defaults `aiEnabled` to true, and its extra-tools menu opens
 * the `ttd` dialog (text-to-diagram, mermaid-to-Excalidraw) whatever that prop
 * says. The canvas cannot be mounted in jsdom, so its props are held by reading
 * its source, and the guard it calls is held as a function.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { opensForbiddenDialog } from './sketch-guards'

const canvas = readFileSync(join(process.cwd(), 'ui/features/diagrams/sketch/sketch-canvas.tsx'), 'utf8')

describe('the sketch editor keeps Excalidraw’s AI off', () => {
  it('passes aiEnabled={false} to Excalidraw', () => {
    expect(canvas).toMatch(/<Excalidraw[\s\S]*\baiEnabled=\{false\}/)
  })

  it('closes the ttd dialog from its onChange, whichever menu opened it', () => {
    expect(canvas).toMatch(/opensForbiddenDialog\(appState\.openDialog\)\)\s*apiRef\.current\?\.updateScene\(\{ appState: \{ openDialog: null \} \}\)/)
  })

  it.each([
    [{ name: 'ttd' }, true],
    [{ name: 'help' }, false],
    [null, false],
    [undefined, false],
  ])('treats %j as forbidden: %s', (openDialog, forbidden) => {
    expect(opensForbiddenDialog(openDialog)).toBe(forbidden)
  })
})
