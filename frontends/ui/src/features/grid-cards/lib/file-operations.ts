/**
 * The vocabulary of a `file_operation_proposal` card, shared by the card and
 * the rows it draws.
 *
 * Executing the operations is not here. The agent proposes and never writes,
 * and a person's accept is applied by the SERVER in their session
 * (`lib/proposals/executors.ts`, ADR-0105). The browser used to run them
 * itself, through the routes the Files pane calls; that path is gone, and a
 * card without a stored proposal is read-only (`FileOperationProposalCard`).
 */

import type { GridCard } from '@/shared/cards/schemas'
import { notifyDocumentsChanged } from '@/lib/documents/document-changes'

type ProposalCard = Extract<GridCard, { type: 'file_operation_proposal' }>
export type FileOperationKind = ProposalCard['operation']
/**
 * One row of a proposal, as the card's consumers may hand it over.
 *
 * `Partial` because the WIRE shape is sparse: the backend drops nulls
 * (`model_dump(exclude_none=True)`), a row only ever carries the two or three
 * fields its verb needs, and the generated Zod fills the rest in with
 * `.default(null)`. Typing it as the parsed shape would make every fixture,
 * gallery entry and test spell out five fields that mean nothing for its
 * operation — while a card that came off the wire is assignable either way.
 */
export type FileOperationItem = Partial<ProposalCard['operations'][number]> & {
  /**
   * Why this item, one line (a filing suggestion's reason per file). Only a
   * stored proposal carries it: the agent's card has no such field, so a card
   * without a `proposal_id` never shows one.
   */
  reason?: string | null
}

/** The folder a move creates first, as a stored proposal names it. */
export interface FileOperationNewFolder {
  path: string
  description?: string | null
}

/** One operation's outcome, in the order the card listed them. */
export interface FileOperationResult {
  /** What was attempted, for the row the card prints. */
  label: string
  ok: boolean
  /** Untranslated detail for a failure — a status line or a resolution miss. */
  reason?: string
}

/** What one row of the card says it will do, for the outcome list. */
export function operationLabel(operation: FileOperationKind, item: FileOperationItem): string {
  if (operation === 'create_folder') {
    return item.parent_folder ? `${item.parent_folder}/${item.folder_name}` : (item.folder_name ?? '')
  }
  return item.document ?? ''
}

/**
 * Tell the Files list and the document caches that the estate changed, if any
 * of these results changed it, so the list refreshes after a proposal is applied
 * (by this reader or by a colleague). A listing that still shows the old folder,
 * or the old name, is the reader's proof that nothing happened. Fired once, and
 * only when something did.
 */
export function notifyIfAnyApplied(results: readonly Pick<FileOperationResult, 'ok'>[] | null | undefined): void {
  if (results?.some((result) => result.ok)) notifyDocumentsChanged()
}
