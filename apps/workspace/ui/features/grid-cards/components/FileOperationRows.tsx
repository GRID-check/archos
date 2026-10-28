'use client'

/**
 * The rows of a file-operation proposal: one line per item, „from → to“ in the
 * words of its verb, each with its verdict once the server has one. Shared by
 * the server-backed receipt and by the card of an answer older than server
 * proposals, so the two cannot draw the same proposal differently.
 */

import { Check, FolderPlus, X } from 'lucide-react'
import { motion, useIconSwapTransition } from '@/components/motion'
import { Chip } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import {
  operationLabel,
  type FileOperationItem,
  type FileOperationNewFolder,
  type FileOperationKind,
  type FileOperationResult,
} from '../lib/file-operations'

/** The project root has no path to print; it has a name the reader knows. */
const folderText = (path: string | null | undefined, rootLabel: string): string =>
  path && path.trim() ? path : rootLabel

/**
 * One row: what this operation does, in the operation's own words.
 *
 * Rendered as „from → to" wherever there IS a from — the reader is deciding
 * about a change, and a change the card only states the destination of asks
 * them to remember where the file is now.
 */
function OperationRow({
  operation,
  item,
  result,
}: {
  operation: FileOperationKind
  item: FileOperationItem
  result?: FileOperationResult
}) {
  const t = useTranslations(chatCopy)
  const root = t('cards.fileOperationProposal.root')

  const subject =
    operation === 'create_folder' ? folderText(item.folder_name, root) : (item.document ?? '')
  const target =
    operation === 'move'
      ? folderText(item.target_folder, root)
      : operation === 'rename'
        ? (item.new_display_name ?? '')
        : operation === 'assign'
          ? (item.member ?? '')
          : folderText(item.parent_folder, root)
  const from = operation === 'move' ? folderText(item.current, root) : ''

  return (
    <li className="card-caption text-foreground flex flex-col gap-0.5" data-testid="file-operation-row">
      <div className="flex items-baseline gap-x-1.5">
        <RowStatus result={result} />
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
            {subject}
          </span>
          {from ? (
            <span className="text-muted-foreground">
              {from} <span aria-hidden>→</span>{' '}
            </span>
          ) : (
            <span aria-hidden className="text-muted-foreground">
              →
            </span>
          )}
          <span className="text-muted-foreground min-w-0 [overflow-wrap:anywhere]">
            {target}
          </span>
          {result && !result.ok && (
            <span className="text-destructive" data-testid="file-operation-row-error">
              {result.reason}
            </span>
          )}
        </span>
      </div>
      {/* Why this one, under its row and clear of the status slot (size-3.5 + gap-1.5). */}
      {item.reason && (
        <p className="text-muted-foreground ml-5 min-w-0 [overflow-wrap:anywhere]" data-testid="file-operation-row-reason">
          {item.reason}
        </p>
      )}
    </li>
  )
}

/**
 * The folder a move creates before its first move: the person confirms the
 * folder as well as the files, so it is named first, with what it is for.
 */
function NewFolderNote({ folder }: { folder: FileOperationNewFolder }) {
  const t = useTranslations(chatCopy)
  return (
    <li className="card-caption text-foreground flex flex-col gap-0.5" data-testid="file-operation-new-folder">
      <div className="flex items-baseline gap-x-1.5">
        <span className="inline-flex size-3.5 shrink-0 self-center" aria-hidden />
        <Chip variant="muted" size="sm" className="self-center">
          <FolderPlus aria-hidden />
          {t('cards.fileOperationProposal.newFolder')}
        </Chip>
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
          {folder.path}
        </span>
      </div>
      {folder.description && (
        <p className="text-muted-foreground ml-5 min-w-0" data-testid="file-operation-new-folder-description">
          {folder.description}
        </p>
      )}
    </li>
  )
}

/** Every row of the proposal, each with its verdict once there is one. */
export function OperationList({
  operation,
  items,
  results,
  newFolder,
}: {
  operation: FileOperationKind
  items: readonly FileOperationItem[]
  results?: readonly FileOperationResult[] | null
  /** The folder this move creates first; only a move has one. */
  newFolder?: FileOperationNewFolder | null
}) {
  return (
    <ul className="flex flex-col gap-1" data-testid="file-operation-rows">
      {operation === 'move' && newFolder && <NewFolderNote folder={newFolder} />}
      {items.map((item, index) => (
        <OperationRow
          key={`${operationLabel(operation, item)}-${index}`}
          operation={operation}
          item={item}
          result={results?.[index]}
        />
      ))}
    </ul>
  )
}

/**
 * A row's verdict, in a slot that is there before it: the check pops in as an
 * icon swap (scale on the snap spring, opacity on a tween), a failure is a quiet ✗ beside the reason the row prints.
 */
function RowStatus({ result }: { result?: FileOperationResult }) {
  const swap = useIconSwapTransition()
  const Icon = result ? (result.ok ? Check : X) : null
  return (
    <span className="inline-flex size-3.5 shrink-0 self-center" aria-hidden>
      {Icon && (
        <motion.span
          className={result?.ok ? 'text-success' : 'text-destructive'}
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1, transition: swap.enter }}
          data-testid={result?.ok ? 'file-operation-row-ok' : 'file-operation-row-failed'}
        >
          <Icon className="size-3.5" />
        </motion.span>
      )}
    </span>
  )
}
