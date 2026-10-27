// @disk-inputs: src/features/skills/components/markdown-editor.css
/**
 * The skill body editor's stylesheet, held to the two phone rules a desktop
 * browser can never show.
 *
 * Source text at 13px made iOS Safari zoom the page on focus and leave it
 * zoomed; the toolbar's 36px buttons were under the 44px floor and, sixteen of
 * them, wrapped into four rows. Asserted on the source because there is no
 * pointer in jsdom, and the rule is one line a retune can delete.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const css = readFileSync(join(__dirname, 'markdown-editor.css'), 'utf8')

/** The body of the first `@media (pointer: coarse)` block that mentions `needle`. */
const coarseBlockWith = (needle: string): string => {
  for (const match of css.matchAll(/@media \(pointer: coarse\) \{/g)) {
    let depth = 0
    let end = match.index + match[0].length - 1
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1
      else if (css[end] === '}' && --depth === 0) break
    }
    const block = css.slice(match.index, end + 1)
    if (block.includes(needle)) return block
  }
  return ''
}

describe('markdown-editor.css', () => {
  test('source text is 16px where a finger types', () => {
    expect(coarseBlockWith('font-size: 16px')).toMatch(/\.w-md-editor-text-pre > code/)
  })

  test('toolbar buttons reach the 44px floor and scroll in one row', () => {
    const block = coarseBlockWith('height: 44px')
    expect(block).toMatch(/min-width: 44px/)
    expect(block).toMatch(/flex-wrap: nowrap/)
    expect(block).toMatch(/overflow-x: auto/)
  })
})
