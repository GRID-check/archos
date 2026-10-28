/**
 * @vitest-environment node
 *
 * The root sort's two grounding rules: a judged move becomes a placement only
 * for a folder the shelf has (by id) or a convention it would create, and a
 * proposed new folder is kept only when it is new, hangs from the root or an
 * open folder, and holds at least two documents nobody else took.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./service', () => ({}))
vi.mock('./judge', () => ({}))
vi.mock('./repository', () => ({}))
vi.mock('@/lib/documents/reconcile-status', () => ({}))
vi.mock('@/lib/documents/shelf-authz', () => ({}))
vi.mock('@/lib/projects/repository', () => ({}))

import { creatablePath, keepNewFolders, placementsOf, type FolderSpace } from './root-sort'
import { folderPathKey } from '@/lib/projects/folders'
import type { FilingMove } from './types'

const move = (documentId: string, folder: string, extra: Partial<FilingMove> = {}): FilingMove => ({
  documentId,
  folder,
  reason: 'Passt.',
  newFolder: null,
  confidence: 0.9,
  ...extra,
})

const FOLDERS = [
  { id: 'f-plans', path: '01 Entwurf/Grundrisse' },
  { id: 'f-fire', path: '03 Fachplaner/Brandschutz' },
]

const spaceOf = (taken: string[], open: string[]): FolderSpace => ({
  takenKeys: new Set(taken.map(folderPathKey)),
  openKeys: new Set(open.map(folderPathKey)),
})

/** `Vertraulich` has its own access list; `Statik` is hidden from this person. */
const SPACE = spaceOf(
  ['01 Entwurf', '03 Fachplaner', 'Vertraulich', 'Statik'],
  ['01 Entwurf', '03 Fachplaner']
)

describe('placementsOf', () => {
  it('places an existing folder by id, whatever the spelling of its path', () => {
    expect(placementsOf([move('d1', '01 entwurf/ grundrisse')], FOLDERS, SPACE)).toEqual([
      { documentId: 'd1', folderId: 'f-plans', newFolderPath: null, reason: 'Passt.', confidence: 0.9 },
    ])
  })

  it('places a convention by the path that creates it', () => {
    const convention = move('d2', '03 Fachplaner/Haustechnik', { newFolder: { description: null }, confidence: null })
    expect(placementsOf([convention], FOLDERS, SPACE)).toEqual([
      { documentId: 'd2', folderId: null, newFolderPath: '03 Fachplaner/Haustechnik', reason: 'Passt.', confidence: null },
    ])
  })

  it('drops a convention whose parent is not open, or that collides with a hidden folder', () => {
    const under = move('d4', 'Vertraulich/Honorare', { newFolder: { description: null } })
    const hidden = move('d5', 'statik', { newFolder: { description: null } })
    expect(placementsOf([under, hidden], FOLDERS, SPACE)).toEqual([])
  })

  it('drops a move into a folder the sort may not file into', () => {
    expect(placementsOf([move('d3', 'Vertraulich/Honorare')], FOLDERS, SPACE)).toEqual([])
  })
})

describe('creatablePath', () => {
  it('spells the path as folder creation will', () => {
    expect(creatablePath(' 05  Fotos\\Bestand ', spaceOf([], ['05 Fotos']))).toBe('05 Fotos/Bestand')
  })

  it('refuses a name folder creation refuses', () => {
    expect(creatablePath('x'.repeat(121), SPACE)).toBeNull()
    expect(creatablePath('NUL', SPACE)).toBeNull()
    expect(creatablePath('..', SPACE)).toBeNull()
  })

  it('refuses a hidden folder, whatever its case', () => {
    expect(creatablePath('STATIK', SPACE)).toBeNull()
  })
})

describe('keepNewFolders', () => {
  const shelf = SPACE
  const ids = ['d1', 'd2', 'd3', 'd4', 'd5']

  it('keeps a new folder at the root or under an open folder', () => {
    const kept = keepNewFolders(
      [
        { path: '05 Fotos Bestand', description: ' Fotos vom Bestand. ', ids: ['d1', 'd2'], confidences: { d1: 0.9, d9: 0.5 } },
        { path: '03 Fachplaner / Haustechnik', description: null, ids: ['d3', 'd4'], confidences: {} },
      ],
      shelf,
      ids
    )
    expect(kept).toEqual([
      { path: '05 Fotos Bestand', description: 'Fotos vom Bestand.', documentIds: ['d1', 'd2'], confidences: { d1: 0.9 } },
      { path: '03 Fachplaner/Haustechnik', description: null, documentIds: ['d3', 'd4'], confidences: {} },
    ])
  })

  it('drops an existing folder, a parent nobody created, and a parent not open to every member', () => {
    const kept = keepNewFolders(
      [
        { path: '01 entwurf', description: null, ids: ['d1', 'd2'], confidences: {} },
        { path: 'Statik', description: null, ids: ['d1', 'd2'], confidences: {} },
        { path: '09 Nirgends/Neu', description: null, ids: ['d1', 'd2'], confidences: {} },
        { path: 'Vertraulich/Neu', description: null, ids: ['d1', 'd2'], confidences: {} },
      ],
      shelf,
      ids
    )
    expect(kept).toEqual([])
  })

  it('needs two documents the request sent that no earlier proposal took', () => {
    const kept = keepNewFolders(
      [
        { path: 'A', description: null, ids: ['d1', 'd2'], confidences: {} },
        { path: 'B', description: null, ids: ['d2', 'd3'], confidences: {} },
        { path: 'C', description: null, ids: ['d4', 'unknown'], confidences: {} },
      ],
      shelf,
      ids
    )
    expect(kept.map((proposal) => proposal.path)).toEqual(['A'])
  })
})
