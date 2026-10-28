/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { SUGGESTED_SCREENING_POLICY } from '@/lib/upload-screening/policy'
import {
  accessFolders,
  buildChosenTree,
  chosenFiles,
  folderState,
  isFolderExcluded,
  previewScreening,
  proposedExclusions,
  summarizeChoice,
  toggleFolder,
} from './folder-tree'

/** A file as a folder input hands it over: with its path in the choice. */
function file(path: string, size = 100): File {
  const name = path.split('/').pop() ?? path
  const made = new File([new Uint8Array(size)], name)
  Object.defineProperty(made, 'webkitRelativePath', { value: path, configurable: true })
  return made
}

const PROJECT = [
  file('Wohnbau Nord/01_Grundlagen/Lageplan.pdf', 1000),
  file('Wohnbau Nord/01_Grundlagen/Grundbuch.pdf', 500),
  file('Wohnbau Nord/02_Einreichung/EG.pdf', 2000),
  file('Wohnbau Nord/02_Einreichung/_alt/EG_v1.pdf', 2000),
  file('Wohnbau Nord/02_Einreichung/_alt/EG_v0.pdf', 2000),
  file('Wohnbau Nord/04_Honorare/Honorarnote_03.pdf', 300),
  file('Wohnbau Nord/04_Honorare/Statische Berechnung.pdf', 300),
  file('Wohnbau Nord/Backup/Projekt.zip', 9000),
  file('Wohnbau Nord/Backup/.DS_Store', 10),
  file('Wohnbau Nord/Baubeschreibung.docx', 50),
]

describe('buildChosenTree', () => {
  it('counts files and bytes per folder, recursively, and leaves system files out', () => {
    const tree = buildChosenTree(PROJECT)
    expect(tree.root.fileCount).toBe(9)
    const top = tree.byPath.get('Wohnbau Nord')
    expect(top?.fileCount).toBe(9)
    expect(top?.ownFiles).toBe(1)
    expect(tree.byPath.get('Wohnbau Nord/02_Einreichung')).toMatchObject({ fileCount: 3, size: 6000, ownFiles: 1 })
    expect(tree.byPath.get('Wohnbau Nord/Backup')?.fileCount).toBe(1)
  })

  it('sorts folders as a person numbers them', () => {
    const tree = buildChosenTree([file('P/10_Ausführung/a.pdf'), file('P/2_Entwurf/b.pdf'), file('P/1_Grundlagen/c.pdf')])
    expect(tree.byPath.get('P')?.children.map((node) => node.name)).toEqual(['1_Grundlagen', '2_Entwurf', '10_Ausführung'])
  })

  it('takes loose files as files at the top', () => {
    const tree = buildChosenTree([new File(['x'], 'Notiz.pdf')])
    expect(tree.root).toMatchObject({ fileCount: 1, ownFiles: 1, children: [] })
  })
})

describe('the folder switches', () => {
  const tree = buildChosenTree(PROJECT)

  it('switches a whole subtree out', () => {
    const out = toggleFolder(tree, new Set(), 'Wohnbau Nord/02_Einreichung')
    expect(isFolderExcluded(out, 'Wohnbau Nord/02_Einreichung/_alt')).toBe(true)
    expect(folderState(out, 'Wohnbau Nord/02_Einreichung')).toBe('out')
    expect(folderState(out, 'Wohnbau Nord')).toBe('partial')
    expect(folderState(out, 'Wohnbau Nord/01_Grundlagen')).toBe('in')
    expect(chosenFiles(tree, out).map((entry) => entry.file.name)).not.toContain('EG.pdf')
  })

  it('switching out a folder forgets what was out below it', () => {
    const inner = toggleFolder(tree, new Set(), 'Wohnbau Nord/02_Einreichung/_alt')
    const outer = toggleFolder(tree, inner, 'Wohnbau Nord/02_Einreichung')
    expect([...outer]).toEqual(['Wohnbau Nord/02_Einreichung'])
  })

  it('switches a folder back in inside one that is out, and only that folder', () => {
    const out = toggleFolder(tree, new Set(), 'Wohnbau Nord')
    const back = toggleFolder(tree, out, 'Wohnbau Nord/02_Einreichung/_alt')
    expect(folderState(back, 'Wohnbau Nord/02_Einreichung/_alt')).toBe('in')
    expect(folderState(back, 'Wohnbau Nord/01_Grundlagen')).toBe('out')
    expect(folderState(back, 'Wohnbau Nord/04_Honorare')).toBe('out')
    // The folders on the way are in, their own files with them: a folder is
    // confirmed whole or not at all.
    expect(chosenFiles(tree, back).map((entry) => entry.file.name).sort()).toEqual([
      'Baubeschreibung.docx',
      'EG.pdf',
      'EG_v0.pdf',
      'EG_v1.pdf',
    ])
  })

  it('a switch twice is where it started', () => {
    const once = toggleFolder(tree, new Set(), 'Wohnbau Nord/Backup')
    expect([...toggleFolder(tree, once, 'Wohnbau Nord/Backup')]).toEqual([])
  })

  it('never switches the root', () => {
    expect([...toggleFolder(tree, new Set(), '')]).toEqual([])
  })
})

describe('proposedExclusions', () => {
  it('proposes backups and old states, the outermost folder on each path', () => {
    const tree = buildChosenTree([...PROJECT, file('Wohnbau Nord/Backup/alt/x.pdf')])
    expect(Object.fromEntries(proposedExclusions(tree))).toEqual({
      'Wohnbau Nord/02_Einreichung/_alt': 'old',
      'Wohnbau Nord/Backup': 'backup',
    })
  })

  it('summarizes what the proposal keeps', () => {
    const tree = buildChosenTree(PROJECT)
    const summary = summarizeChoice(tree, new Set(proposedExclusions(tree).keys()))
    expect(summary).toEqual({ files: 6, size: 4150, totalFiles: 9, totalSize: 17150 })
  })
})

describe('previewScreening', () => {
  const tree = buildChosenTree(PROJECT)

  it('names what the office list holds back of what stays in, and why', () => {
    const preview = previewScreening(tree, new Set(), SUGGESTED_SCREENING_POLICY)
    expect(preview.held.map((entry) => entry.file.name).sort()).toEqual(['Honorarnote_03.pdf', 'Statische Berechnung.pdf'])
    expect(preview.byTerm).toEqual([
      { term: 'Honorar', files: 2, folders: ['Wohnbau Nord/04_Honorare'] },
    ])
    expect(preview.heldIn.get('Wohnbau Nord/04_Honorare')).toBe(2)
    expect(preview.heldIn.get('')).toBe(2)
  })

  it('leaves a folder switched out out of the preview', () => {
    const out = new Set(['Wohnbau Nord/04_Honorare'])
    expect(previewScreening(tree, out, SUGGESTED_SCREENING_POLICY).held).toEqual([])
  })

  it('screens with the policy it is given: a project that set the term aside holds nothing back', () => {
    const policy = { ...SUGGESTED_SCREENING_POLICY, nameTerms: SUGGESTED_SCREENING_POLICY.nameTerms.filter((t) => t !== 'Honorar') }
    expect(previewScreening(tree, new Set(), policy).held).toEqual([])
  })
})

describe('accessFolders', () => {
  it('answers the subfolders of a single project folder', () => {
    const tree = buildChosenTree(PROJECT)
    expect(accessFolders(tree).map((node) => node.path)).toEqual([
      'Wohnbau Nord/01_Grundlagen',
      'Wohnbau Nord/02_Einreichung',
      'Wohnbau Nord/04_Honorare',
      'Wohnbau Nord/Backup',
    ])
  })

  it('answers the folders themselves when several were chosen', () => {
    const tree = buildChosenTree([file('A/x.pdf'), file('B/y.pdf')])
    expect(accessFolders(tree).map((node) => node.path)).toEqual(['A', 'B'])
  })
})
