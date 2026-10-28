/**
 * The operations a document menu can offer, as an entry list.
 *
 * Dropdown and right-click both render this. Order is fixed, not per-caller:
 * open and ask first (what you came here to do), then the file operations,
 * then the destructive one set apart. A surface that already shows one of
 * these elsewhere (the preview's own Download) passes `actions` to drop it.
 */

import {
  Check,
  CheckSquare,
  Download,
  Folder,
  FolderInput,
  FolderTree,
  MessageSquareText,
  Pencil,
  RotateCcw,
  Trash2,
  Ban,
  Eye,
} from 'lucide-react'
import type { ActionMenuEntry } from '@/components/ui/action-menu'
import { isCitableStatus, isFailedStatus, isSettlingStatus } from '../document-status'
import { sortedFolderDestinations, type FolderDestination, type PathFolder } from '../../lib/folder-path-label'
import type { ActionableDocument } from './use-document-actions'

export type DocumentActionKind =
  | 'open'
  | 'ask'
  | 'select'
  | 'download'
  | 'rename'
  | 'move'
  | 'copyOriginPath'
  | 'delete'
  | 'reingest'
  | 'cancel'

export const DEFAULT_DOCUMENT_ACTIONS: readonly DocumentActionKind[] = [
  'open',
  'ask',
  'select',
  'download',
  'rename',
  'move',
  'copyOriginPath',
  'delete',
  'reingest',
  'cancel',
]

/**
 * What a document in a folder the reader may only read offers (ADR-0088):
 * nothing that changes it. The server refuses the rest anyway.
 */
export const READ_ONLY_DOCUMENT_ACTIONS: readonly DocumentActionKind[] = ['open', 'ask', 'download', 'copyOriginPath']

export interface DocumentActionLabels {
  open: string
  ask: string
  select: string
  download: string
  rename: string
  move: string
  copyOriginPath: string
  delete: string
  reingest: string
  reingesting: string
  cancel: string
  cancelling: string
  allFiles: string
}

export interface DocumentActionEntriesInput {
  document: ActionableDocument & { originPath?: string | null }
  labels: DocumentActionLabels
  actions?: readonly DocumentActionKind[]
  canManage?: boolean
  folders?: readonly PathFolder[]
  /**
   * The move targets, labelled and sorted once by the caller
   * (`sortedFolderDestinations`). A listing with a menu per row passes this
   * instead of `folders`, so the tree is not walked and sorted again per row.
   */
  destinations?: readonly FolderDestination[]
  isDownloading?: boolean
  isReingesting?: boolean
  isCancelling?: boolean
  isMoving?: boolean
  onOpen?: () => void
  onAsk?: () => void
  /** „Auswählen": start picking several documents, this one first. Offered only where a listing can select. */
  onSelect?: () => void
  /**
   * Choose the destination in a sheet of its own instead of a submenu. A
   * submenu opens beside its item and a phone has no beside; the caller passes
   * this where the pointer is a finger or the screen is narrow.
   */
  onPickMoveTarget?: () => void
  onDownload: () => void
  onRename: () => void
  onDelete: () => void
  onReingest: () => void
  /** Stop a read that has not finished. Offered only where {@link cancelOffer} says it applies. */
  onCancel: () => void
  onMove: (folderId: string | null, folderName: string) => void
  onCopyOriginPath?: () => void
}

/**
 * Whether re-ingest applies to this row, and in which sense.
 *
 * Decided by the status PHASE (`lib/documents/document-status.ts`):
 *
 *  - `retry` — terminal and not indexed: failed, or stranded at the `uploaded`
 *    birth status.
 *  - `retry` — in flight, EXCEPT `uploading`. A `pending`/`processing` row may
 *    be busy or may be a job the backend lost (a restart wipes the registry,
 *    nothing reconciles `absent` back to failed), and the menu cannot tell the
 *    two apart; the server asks the backend at click time and answers a busy
 *    one with 409 `INGEST_RUNNING`, which the hook turns into „Wird bereits
 *    gelesen“. Hiding it here would strand every lost job again. An
 *    `uploading` row is the one in-flight row that is certainly busy: its
 *    bytes are still arriving and the server has nothing to re-read.
 *  - `reread` — indexed and written by a person: re-read an unchanged file to
 *    pick up a change in how files are read (ADR-0071). It asks first.
 *    An agent-authored row keeps its own rules: its index entry belongs to a
 *    published version, so it is never offered here.
 */
export type ReingestOffer = 'retry' | 'reread'

export function reingestOffer(
  document: Pick<ActionableDocument, 'status' | 'authoredBy'>
): ReingestOffer | null {
  const status = document.status
  if (isFailedStatus(status) || status === 'uploaded') return 'retry'
  if (isSettlingStatus(status)) return status === 'uploading' ? null : 'retry'
  if (isCitableStatus(status) && (document.authoredBy ?? 'user') === 'user') return 'reread'
  return null
}

/**
 * Whether stopping the read applies to this row: it is being read, and the read
 * has not finished.
 *
 * In flight and NOT `uploading`. An `uploading` row's bytes are still arriving
 * from the browser, so there is no ingest job to stop yet and the tray's own
 * cancel — which aborts the transport — is the action there. A `pending` row
 * waits in the durable ingest queue and a `processing` one may be read by a
 * worker or converted inside the BFF (an IFC extraction, an office rendition);
 * the menu cannot tell those apart, and the server answers `unavailable` for
 * the ones with no queue row, which the caller turns into its own sentence.
 */
export function cancelOffer(document: Pick<ActionableDocument, 'status'>): boolean {
  return isSettlingStatus(document.status) && document.status !== 'uploading'
}

export function documentActionEntries({
  document,
  labels,
  actions = DEFAULT_DOCUMENT_ACTIONS,
  canManage = true,
  folders,
  destinations: sortedDestinations,
  isDownloading = false,
  isReingesting = false,
  isCancelling = false,
  isMoving = false,
  onOpen,
  onAsk,
  onSelect,
  onPickMoveTarget,
  onDownload,
  onRename,
  onDelete,
  onReingest,
  onCancel,
  onMove,
  onCopyOriginPath,
}: DocumentActionEntriesInput): ActionMenuEntry[] {
  const destinations = sortedDestinations ?? (folders ? sortedFolderDestinations(folders) : undefined)
  const offers = (kind: DocumentActionKind): boolean => {
    if (!actions.includes(kind)) return false
    if (kind === 'download') return true
    if (kind === 'open') return Boolean(onOpen)
    if (kind === 'ask') return Boolean(onAsk)
    if (kind === 'select') return canManage && Boolean(onSelect)
    if (kind === 'copyOriginPath') {
      return Boolean(document.originPath && onCopyOriginPath)
    }
    if (kind === 'reingest') return canManage && reingestOffer(document) !== null
    if (kind === 'cancel') return canManage && cancelOffer(document)
    if (kind === 'move') return canManage && Boolean(destinations && destinations.length > 0)
    return canManage
  }

  // Both acts below work on what the file IS in the index — reading it again,
  // or stopping the read in progress — so they stand together, set apart from
  // the file operations that follow.
  const offersReadAction = offers('reingest') || offers('cancel')

  const entries: ActionMenuEntry[] = []
  const pushSep = (): void => {
    if (entries.length > 0 && entries[entries.length - 1]?.type !== 'separator') {
      entries.push({ type: 'separator' })
    }
  }

  if (offers('open') && onOpen) {
    entries.push({
      type: 'item',
      id: 'open',
      label: labels.open,
      icon: Eye,
      onSelect: onOpen,
      testId: 'document-action-open',
    })
  }
  if (offers('ask') && onAsk) {
    entries.push({
      type: 'item',
      id: 'ask',
      label: labels.ask,
      icon: MessageSquareText,
      onSelect: onAsk,
      testId: 'document-action-ask',
    })
  }

  if (offers('select') && onSelect) {
    entries.push({
      type: 'item',
      id: 'select',
      label: labels.select,
      icon: CheckSquare,
      onSelect,
      testId: 'document-action-select',
    })
  }

  if (offersReadAction) pushSep()

  if (offers('reingest')) {
    entries.push({
      type: 'item',
      id: 'reingest',
      label: isReingesting ? labels.reingesting : labels.reingest,
      icon: RotateCcw,
      disabled: isReingesting,
      onSelect: onReingest,
      testId: 'document-action-reingest',
    })
  }

  if (offers('cancel')) {
    entries.push({
      type: 'item',
      id: 'cancel',
      label: isCancelling ? labels.cancelling : labels.cancel,
      icon: Ban,
      disabled: isCancelling,
      onSelect: onCancel,
      testId: 'document-action-cancel',
    })
  }

  if (offers('download') || offers('rename') || offers('move') || offers('copyOriginPath')) {
    pushSep()
  }

  if (offers('download')) {
    entries.push({
      type: 'item',
      id: 'download',
      label: labels.download,
      icon: Download,
      disabled: isDownloading,
      onSelect: onDownload,
      testId: 'document-action-download',
    })
  }
  if (offers('rename')) {
    entries.push({
      type: 'item',
      id: 'rename',
      label: labels.rename,
      icon: Pencil,
      onSelect: onRename,
      testId: 'document-action-rename',
    })
  }
  if (offers('move') && destinations && onPickMoveTarget) {
    entries.push({
      type: 'item',
      id: 'move',
      label: labels.move,
      icon: FolderInput,
      onSelect: onPickMoveTarget,
      testId: 'document-action-move',
    })
  } else if (offers('move') && destinations) {
    const current = document.folderId ?? null
    entries.push({
      type: 'sub',
      id: 'move',
      label: labels.move,
      icon: FolderInput,
      testId: 'document-action-move',
      items: [
        {
          type: 'item',
          id: 'move-root',
          label: labels.allFiles,
          icon: current === null ? Check : Folder,
          disabled: isMoving || current === null,
          onSelect: () => onMove(null, labels.allFiles),
          testId: 'document-move-root',
        },
        ...destinations.map(({ folder, label }) => {
          const here = document.folderId === folder.id
          return {
            type: 'item' as const,
            id: `move-${folder.id}`,
            label,
            icon: here ? Check : Folder,
            disabled: isMoving || here,
            onSelect: () => onMove(folder.id, label),
          }
        }),
      ],
    })
  }
  if (offers('copyOriginPath') && onCopyOriginPath) {
    entries.push({
      type: 'item',
      id: 'copy-origin',
      label: labels.copyOriginPath,
      icon: FolderTree,
      onSelect: onCopyOriginPath,
      testId: 'document-action-copy-origin',
    })
  }

  if (offers('delete')) {
    pushSep()
    entries.push({
      type: 'item',
      id: 'delete',
      label: labels.delete,
      icon: Trash2,
      variant: 'destructive',
      onSelect: onDelete,
      testId: 'document-action-delete',
    })
  }

  return entries
}
