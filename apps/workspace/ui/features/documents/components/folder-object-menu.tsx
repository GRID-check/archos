'use client'

/**
 * A folder tile's ⋯ and right-click, sharing {@link folderActionEntries}.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { ActionMenu } from '@/components/ui/action-menu'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { folderActionEntries } from './folder-action-entries'
import { FolderPickerSheet } from './folder-picker-sheet'
import { sortedFolderDestinations, type PathFolder } from '../lib/folder-path-label'

const TriggerContext = createContext<ReactNode>(null)

export function FolderActionsTrigger(): ReactNode {
  return useContext(TriggerContext)
}

export interface FolderObjectMenuProps {
  folder: PathFolder
  folders: readonly PathFolder[]
  canAcceptMove?: (targetFolderId: string | null) => boolean
  onOpen: () => void
  onNewInside?: () => void
  onRename: () => void
  /** „Beschreibung …" (migration 0145); absent for a reader who may not write the shelf. */
  onDescribe?: () => void
  onMove?: (parentId: string | null, parentName: string) => void
  /** „Zugriff…" (ADR-0088); absent for a reader who may not manage the project. */
  onAccess?: () => void
  onDelete: () => void
  /** The reader may only read this folder: its write entries are left out (ADR-0088). */
  readOnly?: boolean
  /** „Verschieben" opens a sheet with a search field and not a submenu (`useMoveInSheet`, asked once by the listing). */
  moveInSheet?: boolean
  children: ReactNode
}

export function FolderObjectMenu({
  folder,
  folders,
  canAcceptMove,
  onOpen,
  onNewInside,
  onRename,
  onDescribe,
  onMove,
  onAccess,
  onDelete,
  readOnly = false,
  moveInSheet = false,
  children,
}: FolderObjectMenuProps): ReactNode {
  const t = useTranslations(filesCopy)
  const [moveOpen, setMoveOpen] = useState(false)
  // Labelled and sorted only for a sheet that is open: one per folder tile otherwise.
  const pickerDestinations = useMemo(
    () =>
      moveOpen ? sortedFolderDestinations(folders).filter(({ folder: dest }) => dest.id !== folder.id) : [],
    [moveOpen, folders, folder.id]
  )
  const entries = useMemo(
    () =>
      folderActionEntries({
        folder,
        labels: {
          open: t('folders.open'),
          newInside: t('folders.newInside'),
          rename: t('folders.rename'),
          move: t('folders.move'),
          delete: t('folders.delete'),
          allFiles: t('folders.allFiles'),
          access: t('folders.access.menu'),
          describe: t('folders.describe'),
          readOnly: t('folders.access.readOnlyMenu'),
        },
        folders,
        canAcceptMove,
        onOpen,
        onNewInside,
        onRename,
        onDescribe,
        onMove,
        onPickMoveTarget: moveInSheet ? () => setMoveOpen(true) : undefined,
        onAccess,
        onDelete,
        readOnly,
      }),
    [
      moveInSheet,
      readOnly,
      folder,
      folders,
      canAcceptMove,
      onOpen,
      onNewInside,
      onRename,
      onDescribe,
      onMove,
      onAccess,
      onDelete,
      t,
    ],
  )

  const trigger = (
    <ActionMenu
      mode="dropdown"
      entries={entries}
      trigger={
        <button
          type="button"
          aria-label={t('folders.actionsFor', { name: folder.name })}
          title={t('folders.actions')}
          className="hover:bg-accent focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-full transition-opacity duration-snap ease-out focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 pointer-coarse:size-11 pointer-coarse:opacity-100 motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100"
          data-testid={`folder-actions-${folder.id}`}
        >
          <MoreHorizontal className="size-3.5" aria-hidden />
        </button>
      }
    />
  )

  return (
    <TriggerContext.Provider value={trigger}>
      <ActionMenu mode="context" entries={entries}>
        {children}
      </ActionMenu>
      {moveInSheet && onMove && (
        <FolderPickerSheet
          open={moveOpen}
          onOpenChange={setMoveOpen}
          title={t('picker.titleOne', { name: folder.name })}
          // A folder is not offered itself; the rest are the caller's to refuse
          // (`canAcceptMove`: not its own descendant, not a place it already is).
          destinations={pickerDestinations}
          currentFolderId={folder.parentId ?? null}
          canPick={canAcceptMove}
          onPick={(parentId, parentName) => {
            setMoveOpen(false)
            onMove?.(parentId, parentName)
          }}
        />
      )}
    </TriggerContext.Provider>
  )
}
