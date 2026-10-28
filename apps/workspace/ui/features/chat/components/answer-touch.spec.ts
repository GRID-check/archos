// @disk-inputs: ui/features/chat/components/AnswerSourcesRow.tsx, ui/features/chat/components/CitationPeek.tsx, ui/features/chat/components/FindingsMatrix.tsx, ui/features/chat/components/PlanChecklist.tsx, ui/features/knowledge/components/ris-document-dialog.tsx
/**
 * What a finger meets in an answer's own content, held as source rules.
 *
 * The mobile pass measured every control in an answer and found the small ones
 * all in one family: a button or a link written by hand in a content component,
 * sized for a mouse, with nothing on the pointer axis. `touch-target.spec.ts`
 * guards the shared primitives and `mobile-affordances.spec.ts` the hover and
 * the 16px rules; this is the third rule, for the files the answer is made of.
 *
 * Every `<button>` and `<a href>` opening tag in these files carries a
 * `pointer-coarse:` size, or is one of the few that is already sized by the atom
 * it is built from. A new control that forgets fails here, before a phone shows
 * it as 14px.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { blankComments } from '../../../../scripts/check-static-utility-modifiers.mjs'
import { srcJoin } from '@/test-utils/source-tree'


const FILES = [
  'features/chat/components/PlanChecklist.tsx',
  'features/chat/components/FindingsMatrix.tsx',
  'features/chat/components/CitationPeek.tsx',
  'features/chat/components/AnswerSourcesRow.tsx',
  'features/knowledge/components/ris-document-dialog.tsx',
]

/** Opening tags of the hand-written controls. A `<Button>` atom is not one: it sizes itself. */
const CONTROL_TAG = /<(?:button|a)\b[^>]*>/g

/**
 * Controls that are exempt, and why. Each is sized by something other than a
 * class on its own tag, and a new entry has to say what.
 */
const SIZED_ELSEWHERE: Record<string, string[]> = {
  // The choice button wraps a 24px Chip; the button is the 44px box.
  'features/chat/components/PlanChecklist.tsx': [],
  'features/chat/components/FindingsMatrix.tsx': [],
  // Its text actions share `PEEK_ACTION_CLASSES` / `COPY_ACTION_CLASSES`, which carry `pointer-coarse:min-h-11`.
  'features/chat/components/CitationPeek.tsx': ['PEEK_ACTION_CLASSES', 'COPY_ACTION_CLASSES'],
  'features/knowledge/components/ris-document-dialog.tsx': [],
  'features/chat/components/AnswerSourcesRow.tsx': [],
}

describe('hand-written controls in answer content', () => {
  it.each(FILES)('%s sizes every button and link for a finger', (file) => {
    const source = blankComments(readFileSync(srcJoin(file), 'utf8')) as string
    const offenders: string[] = []
    for (const match of source.matchAll(CONTROL_TAG)) {
      const tag = match[0]
      if (!/className=/.test(tag)) continue
      if (/pointer-coarse:/.test(tag)) continue
      if ((SIZED_ELSEWHERE[file] ?? []).some((name) => tag.includes(name))) continue
      offenders.push(tag.replace(/\s+/g, ' ').slice(0, 110))
    }
    expect(offenders).toEqual([])
  })

  it('the plan checklist removes a point and an Unterlage with a 44px control', () => {
    const source = blankComments(readFileSync(srcJoin('features/chat/components/PlanChecklist.tsx'), 'utf8')) as string
    // Both remove buttons (the point, the chip's own) grow to 44px on a coarse pointer.
    expect(source.match(/pointer-coarse:size-11/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
