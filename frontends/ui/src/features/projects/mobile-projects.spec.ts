// @disk-inputs: src/app/app/(shell)/projects/**, src/app/app/onboarding/**, src/app/dev/create-project/**, src/app/dev/intake/**, src/app/dev/onboarding/**, src/app/dev/project-memory-restricted/**, src/app/dev/project-setup/**, src/app/dev/projects-home/**, src/components/projects/**, src/features/onboarding/**, src/features/project-intake/**, src/features/projects/**
/**
 * Two phone defects the projects surfaces had, held in the source so a third
 * occurrence is caught by a test and not by someone holding an iPhone.
 *
 *  1. A fixed height next to the top inset. `h-14 … pt-[env(safe-area-inset-top)]`
 *     under `box-sizing: border-box` leaves a content box of 56 − 59px: nothing.
 *     The onboarding header's logo and „Abmelden“ sat on the Dynamic Island
 *     instead of below it. `min-h-14` is the form that grows with the inset (the
 *     app's own mobile bar says so in `app-sidebar.tsx`).
 *
 *  2. A grid that is wide from a breakpoint on and has no column below it. A
 *     grid's implicit column is `auto`, and `auto` grows to the widest
 *     unbreakable line in it, so one long file name or one row of buttons pushed
 *     the page 97px past a phone's edge (the project memory preview). `grid
 *     grid-cols-1 lg:grid-cols-2` is `minmax(0, 1fr)` and can shrink.
 *
 * Scoped to the projects work package's own source; the rules are cheap enough
 * to widen when the rest of the app is cleaned up.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { blankComments } from '../../../scripts/check-static-utility-modifiers.mjs'

const SRC = join(__dirname, '..', '..')

const ROOTS = [
  'features/projects',
  'features/project-intake',
  'features/onboarding',
  'components/projects',
  'app/app/onboarding',
  'app/app/(shell)/projects',
  'app/dev/projects-home',
  'app/dev/create-project',
  'app/dev/project-setup',
  'app/dev/intake',
  'app/dev/onboarding',
  'app/dev/project-memory-restricted',
]

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.tsx$/.test(entry) && !/\.(spec|test)\.tsx$/.test(entry)) out.push(path)
  }
  return out
}

const FILES = ROOTS.flatMap((root) => walk(join(SRC, root)))

/** Every string literal that looks like a class list, with comments blanked first. */
function classLists(file: string): string[] {
  const code = blankComments(readFileSync(file, 'utf8')) as string
  return [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)]
    .map((match) => match[2])
    .filter((text) => text.includes(' '))
}

const tokens = (list: string): string[] => list.split(/\s+/).filter(Boolean)

describe('projects surfaces on a phone', () => {
  it('has files to look at', () => {
    expect(FILES.length).toBeGreaterThan(20)
  })

  it('never pairs a fixed height with the top safe-area inset', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      for (const list of classLists(file)) {
        const all = tokens(list)
        const fixed = all.some((token) => /^h-(?:\d+|\[[^\]]+\])$/.test(token))
        const inset = all.some((token) => /^pt-\[.*safe-area-inset-top.*\]$/.test(token))
        if (fixed && inset) offenders.push(`${file.slice(SRC.length + 1)}: ${list}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('gives every grid that widens at a breakpoint a column below it', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      for (const list of classLists(file)) {
        const all = tokens(list)
        if (!all.includes('grid')) continue
        const widens = all.some((token) => /^(?:sm|md|lg|xl):grid-cols-\d+$/.test(token))
        const base = all.some((token) => /^grid-cols-/.test(token))
        if (widens && !base) offenders.push(`${file.slice(SRC.length + 1)}: ${list}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has no `md:`-based touch size in the intake controls', () => {
    const source = readFileSync(join(SRC, 'features/projects/components/intake-question-field.tsx'), 'utf8')
    expect(source).not.toMatch(/\bmd:min-h-\d+/)
  })
})
