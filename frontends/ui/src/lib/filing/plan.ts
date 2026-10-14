/**
 * From a judgement to proposals: the gates, and one proposal per target folder.
 * Pure, so every rule is specced without a database or a model.
 *
 * The gates, in the order a move meets them:
 *
 * 1. **Restricted** (ADR-0087, ADR-0088). A document in a folder not every
 *    member may read is never moved out (that would widen who sees it), and
 *    nothing is moved into one. The caller never sends either to the model;
 *    this holds it again for an answer that names one anyway.
 * 2. **Already proposed.** A document an open proposal already names is not
 *    proposed again: no second open proposal stacks on the first, whoever made
 *    it (a chat's or Piloti's own).
 * 3. **Dismissed.** A document and a target a person said no to are never
 *    proposed together again. Another target for the same document may be.
 *
 * And one revision: when ingestion has read the batch (`basis: content`), an
 * open suggestion Piloti made from the names alone is kept only when the new
 * judgement files every document of it in the same folder. Otherwise it is
 * withdrawn, and its documents are judged afresh with the rest. A person's
 * decision is never undone this way: only open proposals are withdrawn, and
 * only Piloti's filing suggestions (no conversation, a `basis`).
 *
 * One proposal per target folder (at most eight files each), so a person
 * confirms per folder.
 */

import { folderPathKey } from '@/lib/projects/folders'
import { MAX_FILE_OPERATION_ITEMS, type FileOperationPayload, type FilingBasis } from '@/lib/proposals/types'
import type { FilingMove } from './types'

/** How a document's name is compared: the executor's own key (NFC, trimmed, case-folded). */
export const documentNameKey = (name: string): string => name.normalize('NFC').trim().toLowerCase()

/** A proposal on the shelf, as the plan reads the record. */
export interface RecordedProposal {
  id: string
  status: 'proposed' | 'dismissed' | string
  payload: FileOperationPayload
  /** Made in a chat: never Piloti's filing suggestion, never withdrawn here. */
  originConversationId: string | null
  /** Somebody is applying it right now: it cannot be withdrawn. */
  claimed: boolean
}

/** A document the judgement read. */
export interface PlannedDocument {
  id: string
  filename: string
}

export interface FilingPlanInput {
  basis: FilingBasis
  shelf: 'project' | 'archiv'
  /** The documents that were judged. */
  documents: readonly PlannedDocument[]
  /** Every document of the batch the uploader may see, judged or not (held, failed, still being read). */
  batchFilenames: readonly string[]
  /** Whether a judgement came back; without one nothing is proposed and nothing withdrawn. */
  judged: boolean
  moves: readonly FilingMove[]
  /** Documents (by id) filed in a folder not every member may read. */
  restrictedDocumentIds: ReadonlySet<string>
  /** Folder paths not every member may read; a target at or below one is refused. */
  restrictedPaths: readonly string[]
  record: readonly RecordedProposal[]
}

export interface FilingPlan {
  create: FileOperationPayload[]
  withdraw: string[]
}

const pairKey = (filename: string, path: string) => `${documentNameKey(filename)}\u0000${folderPathKey(path)}`

const isFilingSuggestion = (proposal: RecordedProposal) =>
  proposal.originConversationId === null && Boolean(proposal.payload.basis) && proposal.payload.operation === 'move'

function underRestricted(path: string, restrictedPaths: readonly string[]): boolean {
  const key = folderPathKey(path)
  return restrictedPaths.some((restricted) => {
    const root = folderPathKey(restricted)
    return root.length > 0 && (key === root || key.startsWith(`${root}/`))
  })
}

/** Which open suggestions the content judgement no longer supports, and which documents stay covered. */
function revise(input: FilingPlanInput, moveByName: ReadonlyMap<string, FilingMove>) {
  const batch = new Set(input.batchFilenames.map(documentNameKey))
  const withdraw: string[] = []
  const covered = new Set<string>()
  for (const proposal of input.record) {
    if (proposal.status !== 'proposed') continue
    const names = proposal.payload.operations.map((item) => documentNameKey(item.document ?? '')).filter(Boolean)
    const ours = names.filter((name) => batch.has(name))
    const revisable = input.basis === 'content' && input.judged && isFilingSuggestion(proposal) && !proposal.claimed
    const supported = proposal.payload.operations.every((item) => {
      const name = documentNameKey(item.document ?? '')
      if (!batch.has(name)) return true
      const move = moveByName.get(name)
      return move !== undefined && folderPathKey(move.folder) === folderPathKey(item.target_folder)
    })
    if (ours.length > 0 && revisable && !supported) {
      withdraw.push(proposal.id)
      continue
    }
    for (const name of names) covered.add(name)
  }
  return { withdraw, covered }
}

/** Group the surviving moves by target, at most eight files per proposal. */
function proposalsFor(moves: ReadonlyArray<{ move: FilingMove; filename: string }>, input: FilingPlanInput) {
  const byTarget = new Map<string, Array<{ move: FilingMove; filename: string }>>()
  for (const entry of moves) {
    const key = folderPathKey(entry.move.folder)
    byTarget.set(key, [...(byTarget.get(key) ?? []), entry])
  }
  const create: FileOperationPayload[] = []
  for (const entries of byTarget.values()) {
    for (let start = 0; start < entries.length; start += MAX_FILE_OPERATION_ITEMS) {
      const chunk = entries.slice(start, start + MAX_FILE_OPERATION_ITEMS)
      const { folder, newFolder } = chunk[0].move
      create.push({
        operation: 'move',
        operations: chunk.map(({ move, filename }) => ({
          document: filename,
          source: input.shelf === 'archiv' ? 'buero' : 'projekt',
          target_folder: folder,
          reason: move.reason,
        })),
        basis: input.basis,
        new_folder: newFolder ? { path: folder, description: newFolder.description } : null,
      })
    }
  }
  return create
}

export function planFiling(input: FilingPlanInput): FilingPlan {
  if (!input.judged) return { create: [], withdraw: [] }
  const byId = new Map(input.documents.map((document) => [document.id, document]))
  const moveByName = new Map<string, FilingMove>()
  for (const move of input.moves) {
    const document = byId.get(move.documentId)
    if (document) moveByName.set(documentNameKey(document.filename), move)
  }
  const { withdraw, covered } = revise(input, moveByName)
  const dismissed = new Set(
    input.record
      .filter((proposal) => proposal.status === 'dismissed' && proposal.payload.operation === 'move')
      .flatMap((proposal) =>
        proposal.payload.operations.map((item) => pairKey(item.document ?? '', item.target_folder ?? ''))
      )
  )
  const surviving = input.moves.flatMap((move) => {
    const document = byId.get(move.documentId)
    if (!document) return []
    if (input.restrictedDocumentIds.has(document.id)) return []
    if (underRestricted(move.folder, input.restrictedPaths)) return []
    if (covered.has(documentNameKey(document.filename))) return []
    if (dismissed.has(pairKey(document.filename, move.folder))) return []
    return [{ move, filename: document.filename }]
  })
  return { create: proposalsFor(surviving, input), withdraw }
}
