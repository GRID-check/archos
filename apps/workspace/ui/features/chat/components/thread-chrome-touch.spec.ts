// @disk-inputs: ui/features/chat/components/AnswerActions.tsx, ui/features/chat/components/AnswerFeedback.tsx, ui/features/chat/components/RetryThoroughButton.tsx, ui/features/layout/components/ChatArea.tsx, ui/features/layout/components/ChatToolbar.tsx, ui/features/layout/components/SessionsPanel.tsx, ui/features/runs/components/RunBlock.tsx
/**
 * The thread's chrome, held to the phone.
 *
 * Static source ratchets, in the style of `components/ui/mobile-affordances.spec.ts`:
 * each is a defect class a phone found by eye and nothing else would catch,
 * because every one of them renders perfectly on a desktop.
 *
 *  - Footnote buttons sit two pixels apart. A `touch-target` catchment on each
 *    overlaps its neighbour's, and the later element takes the tap: the reader
 *    presses "copy" and rates the answer. They GROW on a coarse pointer.
 *  - The footnote and the run block are the smallest text in a thread, so they
 *    are where 11px crept in. 12px is the floor.
 *  - A hover reveal needs a second way in (design language, "Touch").
 *  - The toolbar gives the title the row, and a status that exists only on a
 *    wide screen is a status a phone does not have.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { srcJoin } from '@/test-utils/source-tree'

const read = (path: string): string => readFileSync(srcJoin(path), 'utf8')

const FOOTNOTE_BUTTONS = [
  'features/chat/components/AnswerActions.tsx',
  'features/chat/components/AnswerFeedback.tsx',
  'features/chat/components/RetryThoroughButton.tsx',
]

describe('thread chrome on a phone', () => {
  it.each(FOOTNOTE_BUTTONS)('%s grows to 44px instead of borrowing a catchment', (path) => {
    const source = read(path)
    expect(source).toMatch(/pointer-coarse:(?:size|h)-11/)
    // Comments may name the utility; no class string may carry it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/['"`][^'"`]*\btouch-target\b[^'"`]*['"`]/)
  })

  it.each([
    ...FOOTNOTE_BUTTONS,
    'features/runs/components/RunBlock.tsx',
    'features/layout/components/SessionsPanel.tsx',
  ])('%s sets no text under 12px', (path) => {
    expect(read(path)).not.toMatch(/text-\[(?:9|10|10\.5|11)px\]/)
  })

  it('the history row has a visible menu on touch beside the hover overlay', () => {
    const source = read('features/layout/components/SessionsPanel.tsx')
    expect(source).toContain('pointer-coarse:inline-flex')
    expect(source).toMatch(/pointer-coarse:hidden animate-in/)
  })

  it('the toolbar title is not capped to a share of the row, and its status is not desktop-only', () => {
    const source = read('features/layout/components/ChatToolbar.tsx')
    expect(source).not.toContain('max-w-[64%]')
    expect(source).toContain('surface="phone"')
  })

  it('the scroll-to-latest button is 44px on a finger', () => {
    expect(read('features/layout/components/ChatArea.tsx')).toMatch(
      /size-9[^"]*pointer-coarse:size-11/
    )
  })
})
