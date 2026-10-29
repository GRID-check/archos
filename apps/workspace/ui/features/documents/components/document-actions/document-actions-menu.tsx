'use client'

/**
 * The file operations, as one control.
 *
 * One overflow menu, in the object's own header, is what every file manager
 * people already use does. The items themselves live in
 * {@link documentActionEntries} so a right-click on the same object cannot
 * drift from this ⋯. This file owns the dropdown trigger, the dialogs, and
 * the fetch hook.
 *
 * A surface that already shows one of the operations elsewhere (the preview's
 * own Download) passes `actions` to drop it. The workspace wraps the tile in
 * {@link DocumentObjectMenu} so the same list also opens on right-click.
 */

import { useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { cn } from '@/lib/utils'
import { DeleteDocumentDialog } from './delete-document-dialog'
import { RenameDocumentDialog } from './rename-document-dialog'
import {
  documentActionEntries,
  reingestOffer,
  type DocumentActionKind,
} from './action-entries'
import { useDocumentActions, type ActionableDocument } from './use-document-actions'
import { DOCUMENT_SCOPE_COPY, type DocumentScope } from './document-scope'
import { sortedFolderDestinations, type FolderDestination, type PathFolder } from '../../lib/folder-path-label'
import { FolderPickerSheet } from '../folder-picker-sheet'

export type { DocumentActionKind }

const NO_ENTRIES: readonly ActionMenuEntry[] = []

/** Overflow-only default: Open / Ask / Copy path belong on the tile, not here. */
const DEFAULT_ACTIONS: readonly DocumentActionKind[] = [
  'download',
  'rename',
  'move',
  'delete',
  'reingest',
]

export type MoveTargetFolder = PathFolder

/**
 * Where „Verschieben" is a sheet and not a submenu: under a finger, or on a
 * screen too narrow for a panel to open beside its item.
 */
const SHEET_MOVE_QUERY = '(pointer: coarse), (max-width: 639px)'

/**
 * Whether „Verschieben" should open the folder sheet. Asked ONCE by a listing
 * and handed to every row (`moveInSheet`): a media-query subscription per row
 * of a thousand-document folder is a thousand listeners for one answer.
 */
export function useMoveInSheet(): boolean {
  return useMediaQuery(SHEET_MOVE_QUERY)
}

export interface DocumentActionsMenuProps {
  document: ActionableDocument & { originPath?: string | null }
  scope: DocumentScope
  actions?: readonly DocumentActionKind[]
  canManage?: boolean
  onRenamed?: (documentId: string, displayName: string | null) => void
  onDeleted?: (documentId: string) => void
  onReingested?: (documentId: string, status: string) => void
  /** The read in progress was stopped; carries the row's new status. */
  onCancelled?: (documentId: string, status: string) => void
  folders?: readonly MoveTargetFolder[]
  /** The move targets, sorted once by a listing — see `documentActionEntries`. Wins over `folders`. */
  destinations?: readonly FolderDestination[]
  onMoved?: (documentId: string, folderId: string | null) => void
  onOpen?: () => void
  onAsk?: () => void
  /** „Auswählen": a listing's way into picking several documents. Absent where nothing can select. */
  onSelectMode?: () => void
  /**
   * „Verschieben" opens a sheet with a search field instead of a submenu
   * (`useMoveInSheet`). A submenu opens beside its item, and on a phone there
   * is no beside: it ran off the left edge with its folders out of reach.
   */
  moveInSheet?: boolean
  trigger?: ReactNode
  /**
   * What the default trigger sits on. `floating` (the default) lays it over a
   * thumbnail or a viewport, so it carries its own translucent ground and
   * shadow to stay legible on whatever is behind it. `toolbar` sits in a row of
   * ghost icon buttons (the preview header) and must look like its neighbours:
   * the floating ground there read as one grey square among plain glyphs.
   */
  surface?: 'floating' | 'toolbar'
  align?: 'start' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function useDocumentActionMenu({
  document,
  scope,
  actions = DEFAULT_ACTIONS,
  canManage = true,
  onRenamed,
  onDeleted,
  onReingested,
  onCancelled,
  folders,
  destinations,
  onMoved,
  onOpen,
  onAsk,
  onSelectMode,
  moveInSheet = false,
  live = true,
}: Omit<DocumentActionsMenuProps, 'trigger' | 'align' | 'side'> & {
  /**
   * Whether the menu is wanted yet. A listing mounts one of these per row and
   * passes false until the reader first opens that row's menu: the state is
   * kept, but no entries are built and no dialogs are mounted for a row
   * nobody has asked about.
   */
  live?: boolean
}) {
  const t = useTranslations(DOCUMENT_SCOPE_COPY[scope])
  const filesT = useTranslations(filesCopy)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [rereadOpen, setRereadOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const documentActions = useDocumentActions({
    document,
    scope,
    onRenamed,
    onDeleted,
    onReingested,
    onCancelled,
    onMoved,
  })

  if (!live) return { entries: NO_ENTRIES, dialogs: null, name: documentActions.name }

  const copyOriginPath = (): void => {
    const path = document.originPath
    if (!path) return
    void navigator.clipboard
      ?.writeText(path)
      .then(() => toast.success(filesT('preview.originPathCopied')))
      .catch(() => toast.error(filesT('preview.originPathCopyFailed')))
  }

  const entries = documentActionEntries({
    document,
    labels: {
      open: t('actions.open'),
      ask: t('actions.ask'),
      select: t('actions.select'),
      download: t('actions.download'),
      rename: t('actions.rename'),
      move: t('actions.move'),
      copyOriginPath: t('actions.copyOriginPath'),
      delete: t('actions.delete'),
      reingest: t('actions.reingest'),
      reingesting: t('actions.reingesting'),
      cancel: t('actions.cancel'),
      cancelling: t('actions.cancelling'),
      allFiles: filesT('folders.allFiles'),
    },
    actions,
    canManage,
    folders,
    destinations,
    isDownloading: documentActions.isDownloading,
    isReingesting: documentActions.isReingesting,
    isCancelling: documentActions.isCancelling,
    isMoving: documentActions.isMoving,
    onOpen,
    onAsk,
    onSelect: onSelectMode,
    onPickMoveTarget: moveInSheet ? () => setMoveOpen(true) : undefined,
    onDownload: () => void documentActions.download(),
    onRename: () => setRenameOpen(true),
    onDelete: () => setDeleteOpen(true),
    // A retry just runs; re-reading an indexed file asks first, because it is
    // not a repair of anything the reader can see and it costs a full read.
    onReingest: () =>
      reingestOffer(document) === 'reread'
        ? setRereadOpen(true)
        : void documentActions.reingest(),
    // Stopping a read destroys nothing, so it runs on the click: no dialog
    // stands between the person and the thing they asked for.
    onCancel: () => void documentActions.cancel(),
    onMove: (folderId, folderName) => void documentActions.move(folderId, folderName),
    onCopyOriginPath: document.originPath ? copyOriginPath : undefined,
  })

  const dialogs = (
    <>
      {moveInSheet && entries.some((entry) => entry.type === 'item' && entry.id === 'move') && (
        <FolderPickerSheet
          open={moveOpen}
          onOpenChange={setMoveOpen}
          title={filesT('picker.titleOne', { name: documentActions.name })}
          destinations={destinations ?? sortedFolderDestinations(folders ?? [])}
          currentFolderId={document.folderId ?? null}
          pending={documentActions.isMoving}
          onPick={(folderId, folderName) => {
            setMoveOpen(false)
            void documentActions.move(folderId, folderName)
          }}
        />
      )}
      {entries.some((entry) => entry.type === 'item' && entry.id === 'rename') && (
        <RenameDocumentDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          document={document}
          scope={scope}
          onRename={documentActions.rename}
          pending={documentActions.isRenaming}
        />
      )}
      {entries.some((entry) => entry.type === 'item' && entry.id === 'delete') && (
        <DeleteDocumentDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          scope={scope}
          actions={documentActions}
        />
      )}
      {entries.some((entry) => entry.type === 'item' && entry.id === 'reingest') && (
        <ConfirmDialog
          open={rereadOpen}
          onOpenChange={setRereadOpen}
          title={t('actions.reingestConfirmTitle', { name: documentActions.name })}
          description={t('actions.reingestConfirmDescription')}
          confirmLabel={
            documentActions.isReingesting ? t('actions.reingesting') : t('actions.reingestConfirmAction')
          }
          cancelLabel={t('delete.cancel')}
          pending={documentActions.isReingesting}
          tone="default"
          confirmTestId="document-reingest-confirm"
          onConfirm={async () => {
            await documentActions.reingest()
            setRereadOpen(false)
          }}
        />
      )}
    </>
  )

  return { entries, dialogs, name: documentActions.name }
}

export function DocumentActionsMenu({
  trigger,
  surface = 'floating',
  align = 'end',
  side = 'bottom',
  ...props
}: DocumentActionsMenuProps): ReactNode {
  const t = useTranslations(DOCUMENT_SCOPE_COPY[props.scope])
  const { entries, dialogs, name } = useDocumentActionMenu(props)
  if (entries.length === 0) return null
  return (
    <>
      <ActionMenu
        mode="dropdown"
        entries={entries}
        align={align}
        side={side}
        trigger={
          trigger ?? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'size-8 shrink-0',
                surface === 'floating' && 'border border-border bg-background shadow-2xs',
              )}
              aria-label={t('actions.label', { name })}
              title={t('actions.menuLabel')}
              data-testid="document-actions-trigger"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          )
        }
      />
      {dialogs}
    </>
  )
}
