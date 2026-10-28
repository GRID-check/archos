/**
 * Which collection a folder's card belongs in (ADR-0127, ADR-0088). Pure: the
 * repository loads the folder tree and the cards, this decides.
 *
 * A card is never trusted to know its own collection. A folder that was open
 * when its card was written and later got its own access list moves to its own
 * restricted collection; the stored `collection` would still say the project's.
 * So the collection is computed from the tree as it is now, on every read and
 * every write, with the same rule that files documents
 * (`computeFolderAccess(...).collectionFor`).
 */

import {
  computeFolderAccess,
  EVERY_FOLDER,
  isRestrictedCollectionOf,
  OPEN_ACCESS,
  restrictedCollectionBase,
  type AccessFolder,
} from '@/lib/authz/folder-access-rule'
import type { FolderCardKeyFact, FolderCardView, FolderDescriptionView } from './types'

/** Cards one read returns. Past this the listing is cut, so a runaway tree cannot flood a turn. */
export const FOLDER_CARDS_LIMIT = 1_000

/**
 * The project collections `collection` may belong to, most specific first: the
 * name itself, then the project a restricted collection (`<project>_r<12 hex>`)
 * is cut from.
 */
export function projectCollectionCandidates(collection: string): string[] {
  const base = restrictedCollectionBase(collection)
  return base ? [collection, base] : [collection]
}

/** Whether `collection` is `projectCollection` or one of its restricted collections. */
export function isCollectionOfProject(projectCollection: string, collection: string): boolean {
  return collection === projectCollection || isRestrictedCollectionOf(projectCollection, collection)
}

/**
 * The collection each folder's card belongs in, by the project's folder tree
 * (tombstones included) as it is now. An empty tree is a project where no folder
 * restricts anything: every card is the project's.
 */
export function cardCollectionResolver(
  tree: readonly AccessFolder[],
  projectCollection: string,
): (folderId: string) => string {
  const access =
    tree.length > 0 ? computeFolderAccess(tree, EVERY_FOLDER, projectCollection) : OPEN_ACCESS(projectCollection)
  return (folderId) => access.collectionFor(folderId)
}

/** A stored card's columns, as the repository reads them. */
export interface StoredCard {
  abstract: string | null
  keyFacts: FolderCardKeyFact[]
  inputHash: string
  abstractHash: string | null
  model: string | null
  promptVersion: string | null
  status: FolderCardView['status']
  generatedAt: Date | string | null
  updatedAt: Date | string
}

/** One living folder with its card, when it has one. */
export interface FolderWithCard {
  folderId: string
  folderPath: string
  folderDescription: string | null
  card: StoredCard | null
}

/**
 * What `GET` answers for `collection`: the cards of the folders whose documents
 * live in it now, and every such folder's person-written description, card or
 * not (the builder reads it on a folder's first build). Folders in `rows` are
 * ordered by path; `collectionOf` is {@link cardCollectionResolver}'s answer, or
 * a constant for the office shelf.
 */
export function cardsInCollection(
  rows: readonly FolderWithCard[],
  collection: string,
  collectionOf: (folderId: string) => string,
): { cards: FolderCardView[]; folders: FolderDescriptionView[] } {
  const here = rows.filter((row) => collectionOf(row.folderId) === collection).slice(0, FOLDER_CARDS_LIMIT)
  const cards = here.flatMap((row) => (row.card ? [cardView(row, row.card, collection)] : []))
  const folders = here.map((row) => ({
    folder_id: row.folderId,
    folder_path: row.folderPath,
    folder_description: row.folderDescription,
  }))
  return { cards, folders }
}

function cardView(row: FolderWithCard, card: StoredCard, collection: string): FolderCardView {
  return {
    folder_id: row.folderId,
    folder_path: row.folderPath,
    folder_description: row.folderDescription,
    collection,
    abstract: card.abstract,
    key_facts: card.keyFacts,
    input_hash: card.inputHash,
    abstract_hash: card.abstractHash,
    model: card.model,
    prompt_version: card.promptVersion,
    status: card.status,
    generated_at: card.generatedAt ? new Date(card.generatedAt).toISOString() : null,
    updated_at: new Date(card.updatedAt).toISOString(),
  }
}
