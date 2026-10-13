'use client'

/**
 * The rows of a file-operation proposal: one line per item, „from → to“ in the
 * words of its verb, each with its verdict once the server has one. Shared by
 * the server-backed receipt and by the card of an answer older than server
 * proposals, so the two cannot draw the same proposal differently.
 */

import { Check, X } from 'lucide-react'
import { motion, useIconSwapTransition } from '@/components/motion'
import { useTranslations } from '@/i18n'
import {
  operationLabel,
  type FileOperationItem,
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
  const t = useTranslations('chat')
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
    <li
      className="card-caption text-foreground flex items-baseline gap-x-1.5"
      data-testid="file-operation-row"
    >
      <RowStatus result={result} />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 truncate font-medium" title={subject}>
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
        <span className="text-muted-foreground min-w-0 truncate" title={target}>
          {target}
        </span>
        {result && !result.ok && (
          <span className="text-destructive" data-testid="file-operation-row-error">
            {result.reason}
          </span>
        )}
      </span>
    </li>
  )
}

/** Every row of the proposal, each with its verdict once there is one. */
export function OperationList({
  operation,
  items,
  results,
}: {
  operation: FileOperationKind
  items: readonly FileOperationItem[]
  results?: readonly FileOperationResult[] | null
}) {
  return (
    <ul className="flex flex-col gap-1" data-testid="file-operation-rows">
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
