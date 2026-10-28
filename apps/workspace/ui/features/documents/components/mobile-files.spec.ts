// @disk-inputs: src/components/ui/middle-truncate.tsx, src/features/documents/components/file-card.tsx, src/features/documents/components/file-list-view.tsx, src/features/documents/components/file-name.tsx, src/features/documents/components/file-workspace.tsx, src/features/documents/components/folder-bin-panel.tsx, src/features/documents/components/folder-navigation.tsx, src/features/documents/components/folder-object-menu.tsx
/**
 * What the Dateien library keeps on a phone, held against its SOURCE.
 *
 * Each rule is a defect this surface shipped and nothing but a phone showed:
 * the revision cut off a drawing's name, a ⋯ that only a mouse could reveal, a
 * header that owned a third of the screen. Pixels belong to the browser; these
 * are the cheap invariants that hold on every commit (the same bargain
 * `components/ui/mobile-affordances.spec.ts` makes for the primitives).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blankComments } from '../../../../scripts/check-static-utility-modifiers.mjs'

const read = (file: string): string => blankComments(readFileSync(join(__dirname, file), 'utf8')) as string

describe('a file name keeps its end', () => {
  // Revision, drawing number and extension are the END of a name, and a finger
  // has no tooltip: `truncate` + `title` loses them silently on a phone.
  it.each([
    ['file-card.tsx', 'name'],
    ['file-list-view.tsx', 'documentDisplayName\\('],
    ['folder-navigation.tsx', 'folder.name'],
  ])('%s draws the name through FileName', (file, subject) => {
    expect(read(file)).toMatch(new RegExp(`<FileName\\s+text=\\{${subject.replace('.', '\\.')}`))
  })

  it('FileName cuts in the middle and is read once', () => {
    // The read-once lives in the atom, so every name it draws is read once.
    expect(read('file-name.tsx')).toContain('<MiddleTruncate')
    const atom = read('../../../components/ui/middle-truncate.tsx')
    expect(atom).toContain('aria-hidden')
    expect(atom).toContain('sr-only')
  })

  it('does not cut a document name with a bare `truncate` and a title', () => {
    for (const file of ['file-card.tsx', 'file-list-view.tsx']) {
      expect(read(file)).not.toMatch(/truncate"\s+title=\{(?:name|documentDisplayName)/)
    }
  })
})

describe('a hover reveal has a second way in on the pointer axis', () => {
  // `md:opacity-0` alone is a WIDTH question: an iPad in portrait is narrower
  // than `md` and a half-width desktop window is not. The pointer is the axis.
  it.each(['file-card.tsx', 'folder-navigation.tsx', 'folder-object-menu.tsx'])(
    '%s shows its actions to a finger',
    (file) => {
      const source = read(file)
      const reveals = source.match(/[^"`]*md:opacity-0[^"`]*/g) ?? []
      expect(reveals.length).toBeGreaterThan(0)
      for (const reveal of reveals) expect(reveal).toContain('pointer-coarse:opacity-100')
    }
  )
})

describe('the phone header', () => {
  const workspace = read('file-workspace.tsx')

  it('does not pin its controls to their natural width', () => {
    // `shrink-0` on the controls row was why the Archiv's header measured 627px
    // in a 393px viewport: a flex-wrap row that cannot shrink never wraps.
    expect(workspace).not.toMatch(/className="flex min-w-0 shrink-0 flex-wrap/)
  })

  it('keeps one upload control, and moves it rather than copying it', () => {
    // Two instances are two hidden inputs and two owners of the pick refs.
    const uses = workspace.match(/uploader\(\{ allowFolders: true, pickFilesRef, pickFolderRef \}\)/g) ?? []
    expect(uses).toHaveLength(2)
    expect(workspace).toContain('phone && !selection.active')
  })
})

describe('the folder tile on a phone', () => {
  const folders = read('folder-navigation.tsx')

  it('spans the row, so folders read as a list ahead of the files', () => {
    expect(folders.match(/data-folder-tile=""/g)?.length).toBeGreaterThanOrEqual(2)
    expect(folders).toContain("phone:[&>*:has([data-folder-tile])]:col-span-full")
  })
})

describe('the Papierkorb', () => {
  const bin = read('folder-bin-panel.tsx')

  it('puts the permanent action at the far end of the row, away from restore', () => {
    expect(bin).toMatch(/justify-between/)
    expect(bin).toMatch(/text-destructive ml-auto|ml-auto text-destructive/)
  })
})
