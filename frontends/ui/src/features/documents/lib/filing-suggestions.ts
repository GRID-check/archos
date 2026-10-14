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

/** Every open filing suggestion of a listing, keyed by the id of each document it names. */
export function suggestionsByDocument(listed: readonly ListedProposal[]): Map<string, FilingSuggestionView> {
  const byDocument = new Map<string, FilingSuggestionView>()
  for (const { proposal, documents } of listed) {
    if (proposal.kind !== 'file_operation' || proposal.status !== 'proposed') continue
    const { payload } = proposal
    if (!payload.basis || proposal.originConversationId !== null || payload.operation !== 'move') continue
    const folder = payload.operations[0]?.target_folder ?? ''
    if (!folder) continue
    for (const document of documents) {
      if (byDocument.has(document.id)) continue
      const item = payload.operations.find((entry) => entry.document === document.name)
      byDocument.set(document.id, {
        proposalId: proposal.id,
        folder,
        reason: item?.reason ?? null,
        isNew: Boolean(payload.new_folder),
        basis: payload.basis,
        fileCount: payload.operations.length,
        canDecide: proposal.canDecide,
      })
    }
  }
  return byDocument
}
