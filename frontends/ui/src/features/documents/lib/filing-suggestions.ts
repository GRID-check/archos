/**
 * Piloti's open filing suggestions, as a file row and an upload row look them
 * up: by document id. A suggestion is a `file_operation` proposal no chat made
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
}

/** Whether a listed proposal is an open filing suggestion, and the folder it files into. */
function filingFolderOf(proposal: ListedProposal['proposal']): { folder: string; basis: FilingBasis } | null {
  if (proposal.kind !== 'file_operation' || proposal.status !== 'proposed') return null
  const { payload } = proposal
  if (!payload.basis || proposal.originConversationId !== null || payload.operation !== 'move') return null
  const folder = payload.operations[0]?.target_folder ?? ''
  return folder ? { folder, basis: payload.basis } : null
}

/** Every open filing suggestion of a listing, keyed by the id of each document it names. */
export function suggestionsByDocument(listed: readonly ListedProposal[]): Map<string, FilingSuggestionView> {
  const byDocument = new Map<string, FilingSuggestionView>()
  for (const { proposal, documents } of listed) {
    const filing = filingFolderOf(proposal)
    if (!filing || proposal.kind !== 'file_operation') continue
    const { payload } = proposal
    for (const document of documents) {
      if (byDocument.has(document.id)) continue
      const item = payload.operations.find((entry) => entry.document === document.name)
      byDocument.set(document.id, {
        proposalId: proposal.id,
        folder: filing.folder,
        reason: item?.reason ?? null,
        isNew: Boolean(payload.new_folder),
        basis: filing.basis,
        fileCount: payload.operations.length,
        canDecide: proposal.canDecide,
      })
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
 * that lists them rather than hanging them on file rows (the setup page). The
 * reason is the first file's; the others are counted in the line.
 */
export function suggestionsByFolder(listed: readonly ListedProposal[]): FilingFolderSuggestion[] {
  const entries: FilingFolderSuggestion[] = []
  for (const { proposal, documents } of listed) {
    const filing = filingFolderOf(proposal)
    if (!filing || proposal.kind !== 'file_operation' || documents.length === 0) continue
    const { payload } = proposal
    entries.push({
      suggestion: {
        proposalId: proposal.id,
        folder: filing.folder,
        reason: payload.operations.find((entry) => entry.document === documents[0].name)?.reason ?? null,
        isNew: Boolean(payload.new_folder),
        basis: filing.basis,
        fileCount: payload.operations.length,
        canDecide: proposal.canDecide,
      },
      documents,
    })
  }
  return entries
}
