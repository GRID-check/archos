/**
 * @vitest-environment node
 *
 * Which collection a folder's card belongs in: computed from the folder tree as
 * it is now, never from the collection the card was written under (ADR-0088).
 */
import { describe, expect, it } from 'vitest'
import { restrictedCollectionName, type AccessFolder } from '@/lib/authz/folder-access-rule'
import {
  cardCollectionResolver,
  cardsInCollection,
  FOLDER_CARDS_LIMIT,
  isCollectionOfProject,
  projectCollectionCandidates,
  type FolderWithCard,
  type StoredCard,
} from './collection-scope'

const PROJECT = 'proj_1'
const OPEN = '11111111-1111-4111-8111-111111111111'
const PERSONAL = '22222222-2222-4222-8222-222222222222'
const INSIDE = '33333333-3333-4333-8333-333333333333'

const folder = (id: string, patch: Partial<AccessFolder> = {}): AccessFolder => ({
  id,
  parentId: null,
  accessMode: 'inherit',
  everyoneReads: false,
  ...patch,
})

const card = (abstract: string): StoredCard => ({
  abstract,
  keyFacts: [],
  inputHash: 'h',
  abstractHash: 'a',
  model: 'm',
  promptVersion: 'v1',
  status: 'fresh',
  generatedAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
})

const rows: FolderWithCard[] = [
  { folderId: OPEN, folderPath: 'Allgemein', folderDescription: 'Offen', card: card('Offene Unterlagen.') },
  { folderId: PERSONAL, folderPath: 'Personal', folderDescription: null, card: card('Gehälter der Mitarbeiter.') },
  { folderId: INSIDE, folderPath: 'Personal/Verträge', folderDescription: 'Verträge', card: null },
]

describe('cardCollectionResolver', () => {
  it('puts every card in the project collection while no folder restricts reading', () => {
    const collectionOf = cardCollectionResolver([], PROJECT)
    expect([OPEN, PERSONAL, INSIDE].map(collectionOf)).toEqual([PROJECT, PROJECT, PROJECT])
  })

  it('moves a restricted folder, and what is below it, into its own collection', () => {
    const tree = [folder(OPEN), folder(PERSONAL, { accessMode: 'custom' }), folder(INSIDE, { parentId: PERSONAL })]
    const collectionOf = cardCollectionResolver(tree, PROJECT)
    const restricted = restrictedCollectionName(PROJECT, PERSONAL)
    expect([OPEN, PERSONAL, INSIDE].map(collectionOf)).toEqual([PROJECT, restricted, restricted])
  })
})

describe('cardsInCollection', () => {
  const tree = [folder(OPEN), folder(PERSONAL, { accessMode: 'custom' }), folder(INSIDE, { parentId: PERSONAL })]
  const restricted = restrictedCollectionName(PROJECT, PERSONAL)

  it('does not serve a folder restricted after its card was written under the project collection', () => {
    const open = cardsInCollection(rows, PROJECT, cardCollectionResolver(tree, PROJECT))
    expect(open.cards.map((view) => view.folder_path)).toEqual(['Allgemein'])
    expect(JSON.stringify(open)).not.toContain('Gehälter')
    expect(open.folders.map((view) => view.folder_path)).toEqual(['Allgemein'])
  })

  it('serves that card under the restricted collection, named as such', () => {
    const own = cardsInCollection(rows, restricted, cardCollectionResolver(tree, PROJECT))
    expect(own.cards).toHaveLength(1)
    expect(own.cards[0]).toMatchObject({ folder_path: 'Personal', collection: restricted })
  })

  it('returns the description of a folder that has no card yet', () => {
    const own = cardsInCollection(rows, restricted, cardCollectionResolver(tree, PROJECT))
    expect(own.folders).toEqual([
      { folder_id: PERSONAL, folder_path: 'Personal', folder_description: null },
      { folder_id: INSIDE, folder_path: 'Personal/Verträge', folder_description: 'Verträge' },
    ])
  })

  it('bounds what one read returns', () => {
    const many = Array.from({ length: FOLDER_CARDS_LIMIT + 5 }, (_, index) => ({
      folderId: `${index}`,
      folderPath: `F${index}`,
      folderDescription: null,
      card: null,
    }))
    expect(cardsInCollection(many, PROJECT, () => PROJECT).folders).toHaveLength(FOLDER_CARDS_LIMIT)
  })
})

describe('collection names', () => {
  it('tries a restricted collection’s own name, then its project', () => {
    const restricted = restrictedCollectionName(PROJECT, PERSONAL)
    expect(projectCollectionCandidates(restricted)).toEqual([restricted, PROJECT])
    expect(projectCollectionCandidates(PROJECT)).toEqual([PROJECT])
  })

  it('accepts the project’s collection and its restricted ones only', () => {
    expect(isCollectionOfProject(PROJECT, PROJECT)).toBe(true)
    expect(isCollectionOfProject(PROJECT, restrictedCollectionName(PROJECT, PERSONAL))).toBe(true)
    expect(isCollectionOfProject(PROJECT, 'proj_2')).toBe(false)
    expect(isCollectionOfProject(PROJECT, `${PROJECT}_rnothex`)).toBe(false)
  })
})
