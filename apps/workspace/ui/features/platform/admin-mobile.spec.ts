// @disk-inputs: src/app/app/(shell)/organization/**, src/app/app/(shell)/platform/**, src/app/app/(shell)/profile/**, src/components/charts/**, src/features/budgets/**, src/features/organization/**, src/features/platform/**
/**
 * What the admin surfaces (organization, platform, profile, the charts) must
 * not do on an iPhone, held against the source.
 *
 * Admin is not the phone's main job, so these are the defects that make it
 * BROKEN rather than merely dense, each of which was measured on a 393px
 * viewport before it was fixed:
 *
 *  1. A chart in a width-floored scroll box. 30 columns at `min-w-[420px]`
 *     pushed today's bar and the right-hand label off-screen; the columns now
 *     shrink to the width they have.
 *  2. A fixed-width select trigger whose value does not truncate. The select
 *     primitive's own clamp selector never matches Radix's value span, so a
 *     16px "Alle Geltungsbereiche" ran past the trigger and the screen edge.
 *  3. A table cell that relies on a plain `max-w-*` to truncate. Auto table
 *     layout ignores it, and the column stretched past the card.
 *  4. A keyboard-shortcut card on a device with no keyboard.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { blankComments } from '../../../scripts/check-static-utility-modifiers.mjs'

const SRC = join(__dirname, '..', '..')
const ADMIN_DIRS = [
  'features/organization',
  'features/platform',
  'features/budgets',
  'components/charts',
  'app/app/(shell)/organization',
  'app/app/(shell)/platform',
  'app/app/(shell)/profile',
]

const readCode = (file: string): string => blankComments(readFileSync(file, 'utf8')) as string

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.tsx$/.test(entry) && !/\.spec\.tsx$/.test(entry)) out.push(path)
  }
  return out
}

const ADMIN_FILES = ADMIN_DIRS.flatMap((dir) => walk(join(SRC, dir)))
const rel = (file: string): string => file.slice(SRC.length + 1)

describe('admin surfaces on a phone', () => {
  it('draws no chart inside a width-floored scroll box', () => {
    const offenders = ADMIN_FILES.filter((file) => file.includes('components/charts')).filter((file) =>
      /min-w-\[\d+px\]/.test(readCode(file))
    )
    expect(offenders.map(rel)).toEqual([])
  })

  it('truncates the value of every fixed-width select trigger', () => {
    const offenders: string[] = []
    for (const file of ADMIN_FILES) {
      const code = readCode(file)
      for (const match of code.matchAll(/<SelectTrigger[^>]*?className="([^"]*)"/g)) {
        const classes = match[1]
        // A width that holds on a phone: `w-44`, not `sm:w-72` (which only applies
        // from `sm`) and not `w-full`.
        const fixedWidth = /(^|\s)w-\d+(\s|$)/.test(classes)
        if (fixedWidth && !classes.includes('[&>span]:truncate')) offenders.push(`${rel(file)}: ${classes}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('makes a truncating table cell width-bound, not just max-width-bound', () => {
    const offenders: string[] = []
    for (const file of ADMIN_FILES) {
      const code = readCode(file)
      for (const match of code.matchAll(/<TableCell[^>]*?className="([^"]*max-w-\[[^"]*)"/g)) {
        if (!/max-w-0/.test(match[1])) offenders.push(`${rel(file)}: ${match[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('shows the keyboard-shortcut card only where a keyboard can be', () => {
    const code = readCode(join(SRC, 'app/app/(shell)/profile/profile-controls.tsx'))
    expect(code).toMatch(/any-pointer-fine:block[^]*?<ShortcutSettings \/>/)
  })
})
