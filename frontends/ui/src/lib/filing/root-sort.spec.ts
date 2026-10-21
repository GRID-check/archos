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

import { keepNewFolders, placementsOf } from './root-sort'
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

describe('placementsOf', () => {
  it('places an existing folder by id, whatever the spelling of its path', () => {
    expect(placementsOf([move('d1', '01 entwurf/ grundrisse')], FOLDERS)).toEqual([
      { documentId: 'd1', folderId: 'f-plans', newFolderPath: null, reason: 'Passt.', confidence: 0.9 },
    ])
  })

  it('places a convention by the path that creates it', () => {
    const convention = move('d2', '03 Fachplaner/Haustechnik', { newFolder: { description: null }, confidence: null })
    expect(placementsOf([convention], FOLDERS)).toEqual([
      { documentId: 'd2', folderId: null, newFolderPath: '03 Fachplaner/Haustechnik', reason: 'Passt.', confidence: null },
    ])
  })

  it('drops a move into a folder the sort may not file into', () => {
    expect(placementsOf([move('d3', 'Vertraulich/Honorare')], FOLDERS)).toEqual([])
  })
})

describe('keepNewFolders', () => {
  const shelf = {
    existingPaths: ['01 Entwurf', '03 Fachplaner', 'Vertraulich'],
    openPaths: ['01 Entwurf', '03 Fachplaner'],
  }
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
