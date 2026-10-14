/**
 * Piloti's open filing suggestions, as a file row and an upload row look them
 * up (by document id) and as a filing bar lists them (by target folder). A suggestion is a `file_operation` proposal no chat made
 * (`basis` set, no conversation; `lib/filing`), one per target folder, so a row
 * names its folder, its own reason, and how many other files the same click
 * moves. Pure, so the rule is specced without a server.
 */

import type { FilingBasis, ListedProposal } from '@/lib/proposals/types'

export interface FilingSuggestionView {
  proposalId: string
  /** The folder it belongs in, as the proposal names it. */
  folder: string
  /** Why, for this file: its item's reason. */
  reason: string | null
  /** The folder does not exist yet: applying creates it. */
  isNew: boolean
  basis: FilingBasis
  /** How many files the one confirm moves, this one included. */
  fileCount: number
  /** The server says this reader may move them (`canDecide`). */
  canDecide: boolean
  /** The shelf the files are on, which names the top level a file at the root sits on. */
  shelf: 'projekt' | 'buero'
  /** Every document the one confirm moves that this reader may see, by id: what a highlight lights. */
  documentIds: readonly string[]
}

/** Whether a listed proposal is an open filing suggestion, and the folder it files into. */
function filingFolderOf(proposal: ListedProposal['proposal']): { folder: string; basis: FilingBasis } | null {
  if (proposal.kind !== 'file_operation' || proposal.status !== 'proposed') return null
  const { payload } = proposal
  if (!payload.basis || proposal.originConversationId !== null || payload.operation !== 'move') return null
  const folder = payload.operations[0]?.target_folder ?? ''
  return folder ? { folder, basis: payload.basis } : null
}

/** One open filing suggestion as one of its documents shows it: its folder, and that file's own reason. */
function viewFor({ proposal, documents }: ListedProposal, documentName: string | undefined): FilingSuggestionView | null {
  const filing = filingFolderOf(proposal)
  if (!filing || proposal.kind !== 'file_operation') return null
  const { payload } = proposal
  const item = payload.operations.find((entry) => entry.document === documentName)
  return {
    proposalId: proposal.id,
    folder: filing.folder,
    reason: item?.reason ?? null,
    isNew: Boolean(payload.new_folder),
    basis: filing.basis,
    fileCount: payload.operations.length,
    canDecide: proposal.canDecide,
    shelf: payload.operations[0]?.source === 'buero' ? 'buero' : 'projekt',
    documentIds: documents.map((document) => document.id),
  }
}

/** Every open filing suggestion of a listing, keyed by the id of each document it names. */
export function suggestionsByDocument(listed: readonly ListedProposal[]): Map<string, FilingSuggestionView> {
  const byDocument = new Map<string, FilingSuggestionView>()
  for (const entry of listed) {
    for (const document of entry.documents) {
      if (byDocument.has(document.id)) continue
      const view = viewFor(entry, document.name)
      if (view) byDocument.set(document.id, view)
    }
  }
  return byDocument
}

/** One open filing suggestion as a page without the files in view lists it: the folder, and which files go there. */
export interface FilingFolderSuggestion {
  suggestion: FilingSuggestionView
  documents: readonly { id: string; name: string }[]
}

/**
 * Every open filing suggestion of a listing, one per target folder, for a place
 * that decides per folder (the filing bar above a view, the upload tray, the
 * setup page). The reason is the first file's.
 */
export function suggestionsByFolder(listed: readonly ListedProposal[]): FilingFolderSuggestion[] {
  return listed.flatMap((entry) => {
    if (entry.documents.length === 0) return []
    const suggestion = viewFor(entry, entry.documents[0].name)
    return suggestion ? [{ suggestion, documents: entry.documents }] : []
  })
}

/**
 * The target folders a view's filing bar lists: every suggestion that moves a
 * document in view, in the listing's order, and none at all unless one of them
 * collects at least `minFiles` files. With one file per folder the chip on the
 * file decides as well as a bar line would, so the bar appears only where it
 * saves clicks; the upload tray, where filing is the job, asks with 1.
 *
 * The count is the proposal's, which is what one confirm moves.
 */
export function filingBarEntries(
  byFolder: readonly FilingFolderSuggestion[],
  documentIds: Iterable<string>,
  minFiles: number
): FilingFolderSuggestion[] {
  const inView = new Set(documentIds)
  const entries = byFolder.filter((entry) => entry.documents.some((document) => inView.has(document.id)))
  return entries.some((entry) => entry.suggestion.fileCount >= minFiles) ? entries : []
}
