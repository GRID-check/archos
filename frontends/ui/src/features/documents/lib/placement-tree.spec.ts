import { describe, expect, it } from 'vitest'
import type {
  NewFolderProposal,
  RootSortDocument,
  RootSortFolder,
  RootSortPlacement,
} from '@/lib/filing/root-sort-types'
import {
  buildPlacementTree,
  folderIdFor,
  folderKept,
  keptMoves,
  NO_CHANGES,
  retarget,
  setFileKept,
  setFolderKept,
  unsureOnly,
  type FolderNode,
  type PlacementInput,
  type PlacementState,
} from './placement-tree'

const folder = (
  id: string,
  name: string,
  path: string,
  parentId: string | null = null
): RootSortFolder => ({
  id,
  name,
  path,
  parentId,
})
const doc = (id: string, name = `${id}.pdf`): RootSortDocument => ({ id, name })
const placed = (
  documentId: string,
  folderId: string,
  confidence: number | null = 0.9,
  reason = 'why'
): RootSortPlacement => ({
  documentId,
  folderId,
  newFolderPath: null,
  reason,
  confidence,
})
const proposal = (
  path: string,
  documentIds: string[],
  confidences: Record<string, number> = {}
): NewFolderProposal => ({
  path,
  description: null,
  documentIds,
  confidences,
})

const folders = [
  folder('f1', '01 Entwurf', '01 Entwurf'),
  folder('f2', 'Grundrisse', '01 Entwurf/Grundrisse', 'f1'),
  folder('f3', 'EG', '01 Entwurf/Grundrisse/EG', 'f2'),
  folder('f4', '02 Genehmigung', '02 Genehmigung'),
  folder('f5', 'Leer', '03 Leer'),
]

function input(overrides: Partial<PlacementInput> = {}): PlacementInput {
  return {
    folders,
    documents: [doc('d1'), doc('d2'), doc('d3'), doc('d4'), doc('d5')],
    placements: [placed('d1', 'f3', 0.9), placed('d2', 'f4', 0.3), placed('d3', 'f2', 0.7)],
    newFolders: [],
    ...overrides,
  }
}

function findFolder(nodes: readonly FolderNode[], path: string): FolderNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node
    const below = findFolder(node.children, path)
    if (below) return below
  }
  return undefined
}

describe('buildPlacementTree', () => {
  it('nests a file three folders deep and counts it at every level', () => {
    const tree = buildPlacementTree(input(), NO_CHANGES)
    const design = tree.folders.find((node) => node.path === '01 Entwurf')
    expect(design?.depth).toBe(1)
    expect(design?.placedBelow).toBe(2)
    const floorPlans = findFolder(tree.folders, '01 Entwurf/Grundrisse')
    expect(floorPlans?.depth).toBe(2)
    expect(floorPlans?.files.map((file) => file.id)).toEqual(['d3'])
    const deepest = findFolder(tree.folders, '01 Entwurf/Grundrisse/EG')
    expect(deepest?.depth).toBe(3)
    expect(deepest?.files.map((file) => file.id)).toEqual(['d1'])
    expect(floorPlans?.placedBelow).toBe(2)
  })

  it('omits folders with nothing placed below them', () => {
    const tree = buildPlacementTree(input(), NO_CHANGES)
    expect(tree.folders.map((node) => node.path)).not.toContain('03 Leer')
    expect(findFolder(tree.folders, '01 Entwurf/Grundrisse/EG')).toBeDefined()
  })

  it('puts a file with no target in the root group', () => {
    const tree = buildPlacementTree(input(), NO_CHANGES)
    expect(tree.stays.map((file) => file.id)).toEqual(['d4', 'd5'])
    expect(tree.summary.stays).toBe(2)
  })

  it('counts sure and unsure placements from their confidence', () => {
    const tree = buildPlacementTree(input(), NO_CHANGES)
    expect(tree.summary.sure).toBe(2)
    expect(tree.summary.unsure).toBe(1)
    const permit = findFolder(tree.folders, '02 Genehmigung')
    expect(permit?.unsureBelow).toBe(1)
    const design = findFolder(tree.folders, '01 Entwurf')
    expect(design?.unsureBelow).toBe(0)
  })

  it('reads a placement the decision model did not score as unsure', () => {
    const tree = buildPlacementTree(input({ placements: [placed('d1', 'f3', null)] }), NO_CHANGES)
    expect(tree.summary.unsure).toBe(1)
    expect(tree.summary.sure).toBe(0)
  })

  it('attaches a new folder under its nearest existing parent and marks it new', () => {
    const tree = buildPlacementTree(
      input({
        documents: [doc('d1'), doc('d2')],
        placements: [],
        newFolders: [proposal('01 Entwurf/Schnitte', ['d1'], { d1: 0.2 }), proposal('Neu', ['d2'])],
      }),
      NO_CHANGES
    )
    const sections = findFolder(tree.folders, '01 Entwurf/Schnitte')
    expect(sections?.isNew).toBe(true)
    expect(sections?.depth).toBe(2)
    expect(sections?.files[0]?.certainty).toBe('unsure')
    const top = tree.folders.find((node) => node.path === 'Neu')
    expect(top?.isNew).toBe(true)
    expect(top?.depth).toBe(1)
    expect(tree.summary.newFolders).toBe(2)
  })

  it('lets a retarget win over the placement and the person keeps it', () => {
    const state = retarget(NO_CHANGES, 'd1', { kind: 'folder', folderId: 'f4' })
    const tree = buildPlacementTree(input(), state)
    expect(findFolder(tree.folders, '02 Genehmigung')?.files.map((file) => file.id)).toEqual([
      'd1',
      'd2',
    ])
    expect(findFolder(tree.folders, '01 Entwurf/Grundrisse/EG')).toBeUndefined()
    const moved = keptMoves(input(), state).moves.find((move) => move.documentId === 'd1')
    expect(moved?.folderId).toBe('f4')
  })

  it('sends a file to the root when the person retargets it there, and the proposal can be restored', () => {
    const toRoot = retarget(NO_CHANGES, 'd3', { kind: 'root' })
    const tree = buildPlacementTree(input(), toRoot)
    expect(tree.stays.map((file) => file.id)).toEqual(['d3', 'd4', 'd5'])
    expect(keptMoves(input(), toRoot).moves.map((move) => move.documentId)).toEqual(['d1', 'd2'])
    const restored = retarget(toRoot, 'd3', { kind: 'proposal' })
    expect(buildPlacementTree(input(), restored).stays.map((file) => file.id)).toEqual(['d4', 'd5'])
  })

  it('counts a retargeted file as sure, and drops its reason', () => {
    const state = retarget(NO_CHANGES, 'd2', { kind: 'folder', folderId: 'f2' })
    const row = buildPlacementTree(input(), state)
      .folders.flatMap((node) => [
        node,
        ...node.children,
        ...node.children.flatMap((child) => child.children),
      ])
      .flatMap((node) => node.files)
      .find((file) => file.id === 'd2')
    expect(row?.certainty).toBe('sure')
    expect(row?.reason).toBe('')
  })
})

describe('exclusions', () => {
  it('keeps an unchecked file where it is, but not in the moves', () => {
    const state = setFileKept(NO_CHANGES, 'd1', false)
    const tree = buildPlacementTree(input(), state)
    expect(findFolder(tree.folders, '01 Entwurf/Grundrisse/EG')?.files[0]?.included).toBe(false)
    expect(keptMoves(input(), state).moves.map((move) => move.documentId)).toEqual(['d2', 'd3'])
    expect(tree.summary.included).toBe(2)
  })

  it('sends the files of a switched-off new folder to the root, and shows the folder held back', () => {
    const data = input({
      documents: [doc('d1'), doc('d2')],
      placements: [],
      newFolders: [proposal('Neu/Unter', ['d1', 'd2'])],
    })
    const state: PlacementState = { ...NO_CHANGES, excludedNewFolders: new Set(['Neu']) }
    const tree = buildPlacementTree(data, state)
    expect(tree.stays.map((file) => file.id)).toEqual(['d1', 'd2'])
    const neu = tree.folders.find((node) => node.path === 'Neu')
    expect(neu?.switchedOff).toBe(true)
    expect(neu?.heldBack).toBe(2)
    expect(neu?.placedBelow).toBe(0)
    expect(keptMoves(data, state)).toEqual({ newFolderPaths: [], moves: [] })
  })

  it('creates a new folder once, for every kept move that lands in it', () => {
    const data = input({
      documents: [doc('d1'), doc('d2')],
      placements: [
        {
          documentId: 'd1',
          folderId: null,
          newFolderPath: 'Office/Neu',
          reason: '',
          confidence: 0.8,
        },
      ],
      newFolders: [proposal('Office/Neu', ['d2'])],
    })
    const moves = keptMoves(data, NO_CHANGES)
    expect(moves.newFolderPaths).toEqual(['Office/Neu'])
    expect(moves.moves).toEqual([
      { documentId: 'd1', folderId: null, newFolderPath: 'Office/Neu' },
      { documentId: 'd2', folderId: null, newFolderPath: 'Office/Neu' },
    ])
  })

  it('unchecking a folder unchecks every file below it, and checking it again restores them', () => {
    const tree = buildPlacementTree(input(), NO_CHANGES)
    const design = tree.folders.find((node) => node.path === '01 Entwurf') as FolderNode
    expect(folderKept(design)).toBe(true)
    const off = setFolderKept(NO_CHANGES, design, false)
    expect(keptMoves(input(), off).moves.map((move) => move.documentId)).toEqual(['d2'])
    expect(
      folderKept(
        buildPlacementTree(input(), off).folders.find(
          (node) => node.path === '01 Entwurf'
        ) as FolderNode
      )
    ).toBe(false)
    const on = setFolderKept(off, design, true)
    expect(keptMoves(input(), on).moves.map((move) => move.documentId)).toEqual(['d1', 'd2', 'd3'])
  })

  it('switches a new folder off as a whole and back on', () => {
    const data = input({
      documents: [doc('d1')],
      placements: [],
      newFolders: [proposal('Neu', ['d1'])],
    })
    const tree = buildPlacementTree(data, NO_CHANGES)
    const neu = tree.folders[0] as FolderNode
    expect(folderKept(neu)).toBe(true)
    const off = setFolderKept(NO_CHANGES, neu, false)
    expect(buildPlacementTree(data, off).folders[0]?.switchedOff).toBe(true)
    const on = setFolderKept(off, buildPlacementTree(data, off).folders[0] as FolderNode, true)
    expect(keptMoves(data, on).moves).toHaveLength(1)
  })
})

describe('unsure only', () => {
  it('keeps only folders with an unsure file below and only the unsure files', () => {
    const tree = unsureOnly(buildPlacementTree(input(), NO_CHANGES))
    expect(tree.folders.map((node) => node.path)).toEqual(['02 Genehmigung'])
    expect(tree.stays).toEqual([])
    expect(findFolder(tree.folders, '02 Genehmigung')?.files.map((file) => file.id)).toEqual(['d2'])
  })
})

describe('folderIdFor', () => {
  it('finds a folder the route answered under another spelling of its path', () => {
    expect(folderIdFor(' Neu/Unter ', { 'Neu/Unter': 'x1' })).toBe('x1')
    expect(folderIdFor('neu/unter', { 'Neu/Unter': 'x1' })).toBe('x1')
    expect(folderIdFor('Fehlt', { 'Neu/Unter': 'x1' })).toBeNull()
  })
})
