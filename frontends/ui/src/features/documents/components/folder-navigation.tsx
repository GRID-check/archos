'use client'

import type { JSX } from 'react'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CountPill } from '@/components/ui/count-pill'
import { Item } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { FileName } from './file-name'
import { Spinner } from '@/components/ui/spinner'
import { AnimatePresence, motion, motionQuick } from '@/components/motion'
import { BackControl } from '@/components/shell/back-link'
import { useTranslations } from '@/i18n'
import { useLocale } from '@/i18n'
import { folderDragProps, useFolderDropTarget, type FileDropAim } from '../hooks/use-document-drag'
import { cn } from '@/lib/utils'
import { TimeAgo } from '@/components/ui/time-ago'
import { GridTileBody, GridTileFooter, GridTileMedia, GridTileShell } from './grid-tile'
import { FolderAccessMark, FolderReadOnlyBadge, useFolderOwnAccessLabel } from './folder-access-mark'
import { FolderReadState } from './folder-read-state'
import type { KnowledgeTally } from '../lib/folder-knowledge'
import type { FolderItem } from './project-file-workspace'

/**
 * Finder-style folder navigation: the drill-down that replaced the tree pane.
 *
 * The tree drew every level at once in a side band and, outside the tree view,
 * nested folders were unreachable at all (the chip row listed top-level
 * folders only). This module makes drilling the ONE model: at each level the
 * folders render as cards (or rows) beside the files, clicking one enters it,
 * and the breadcrumb up top names the path and walks back out. Same flat
 * `FolderItem[]` data, same server API — only the presentation changed.
 */

/** The chain of ancestors from the root to `folderId`, oldest first. */
export function folderPath(folders: FolderItem[], folderId: string | null): FolderItem[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: FolderItem[] = []
  let cursor = folderId === null ? undefined : byId.get(folderId)
  // Defensive bound: a corrupt parent chain must not hang the render.
  while (cursor && path.length <= folders.length) {
    path.unshift(cursor)
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
  }
  return path
}

export interface FolderNavProps {
  folders: FolderItem[]
  currentFolderId: string | null
  onNavigate: (id: string | null) => void
  onCreateFolder: (name: string, parentId?: string) => Promise<boolean>
  onRenameFolder: (folderId: string, name: string) => Promise<boolean>
  onDeleteFolder: (folderId: string) => Promise<boolean>
}

/**
 * The path row: `All Files › Planung › Statik`, every ancestor a link, plus
 * the "New folder" control for the level the reader is standing in.
 */
export function FolderBreadcrumbRow({
  folders,
  currentFolderId,
  onNavigate,
  onCreateFolder,
  children,
  onDropDocument,
  onDropFolder,
  canAcceptFolder,
  readOnly = false,
  onDropFiles,
  onFileAim,
  mayWriteAt,
}: Pick<FolderNavProps, 'folders' | 'currentFolderId' | 'onNavigate'> & {
  /** Absent for a read-only viewer: the path is still walkable, nothing can be created. */
  onCreateFolder?: FolderNavProps['onCreateFolder']
  children?: ReactNode
  /**
   * The reader may only read the level they stand in (ADR-0088): „Nur lesen"
   * takes the place of „Neuer Ordner".
   */
  readOnly?: boolean
  /** Dropping a document on „Alle Dateien" moves it back to the project root. */
  onDropDocument?: (documentId: string, folderId: string | null) => void
  /**
   * Dropping a FOLDER there moves it out to the project root.
   *
   * This is the only way OUT. Every other target nests one folder inside
   * another, so without it a folder could be dragged deeper and never back —
   * the same half-a-gesture the document drag shipped with before the root
   * became a target for it.
   */
  onDropFolder?: (draggedFolderId: string, parentId: string | null) => void
  canAcceptFolder?: (draggedFolderId: string, targetFolderId: string | null) => boolean
  /** Desktop files dropped on a way up land at that level. */
  onDropFiles?: DropFilesInFolder
  onFileAim?: (aim: FileDropAim | null) => void
  /** Whether the reader may write at a level (ADR-0088); a level they may not is no target. Defaults to yes. */
  mayWriteAt?: (folderId: string | null) => boolean
}): JSX.Element {
  const t = useTranslations('files')
  const path = useMemo(() => folderPath(folders, currentFolderId), [folders, currentFolderId])
  /** Every way up is a drop target, offered while there is somewhere to come back FROM. */
  const crumb = (folderId: string | null, label: string, children: ReactNode) => (
    <CrumbDropTarget
      folderId={folderId}
      label={label}
      writable={mayWriteAt?.(folderId) ?? true}
      onDropDocument={onDropDocument}
      onDropFolder={onDropFolder}
      canAcceptFolder={canAcceptFolder}
      onDropFiles={onDropFiles}
      onFileAim={onFileAim}
      onSpringOpen={() => onNavigate(folderId)}
    >
      {children}
    </CrumbDropTarget>
  )

  /**
   * Where "up one level" goes: the parent folder, or the root.
   *
   * Null at the root, where there is nothing to go up to.
   */
  const parent = currentFolderId === null ? undefined : path[path.length - 2]
  const parentLabel = parent ? parent.name : t('folders.allFiles')

  return (
    <div
      // On a phone the row PINS to the top of the list. It is the list's first
      // child, so it used to scroll with the cards, and the moment the list
      // overflowed the short screen under the fixed header a swipe left it
      // half-hidden under the controls. Pinned, it is whole or gone, never cut.
      className="flex shrink-0 items-center justify-between gap-2 border-b bg-card/50 px-4 py-2.5 backdrop-blur-sm phone:sticky phone:top-0 phone:z-10 phone:bg-background phone:py-1.5"
      data-testid="folder-breadcrumb-row"
    >
      <div className="flex min-w-0 items-center gap-2">
        {/*
          Up one level, as its own control rather than as a breadcrumb segment.

          The breadcrumb says where you ARE — it is a map, and reading a map to
          find the way out is work. Three levels deep the parent is a truncated
          word in the middle of a scrolling row, which is a 90px target for the
          single most common thing anyone does in a folder. Named, so it says
          what it will do before it is pressed.

          The same control the org-wide pages use to leave, deliberately: going
          up a level and leaving a page are one idea, and drawing them twice is
          how two lookalikes drift on the first token retune.
        */}
        {currentFolderId !== null &&
          crumb(
            parent?.id ?? null,
            parentLabel,
            <BackControl
              label={t('folders.backTo', { name: parentLabel })}
              onClick={() => onNavigate(parent?.id ?? null)}
              className="shrink-0 pr-3"
              testId="folder-back"
            />
          )}
      <Breadcrumb aria-label={t('folders.breadcrumb')} className="min-w-0">
        <BreadcrumbList className="flex-nowrap overflow-x-auto">
          <BreadcrumbItem>
            {currentFolderId === null ? (
              <BreadcrumbPage className="whitespace-nowrap font-medium">{t('folders.allFiles')}</BreadcrumbPage>
            ) : (
              crumb(
                null,
                t('folders.allFiles'),
                <BreadcrumbLink asChild>
                  <button
                    type="button"
                    onClick={() => onNavigate(null)}
                    className="hover:text-foreground transition-colors rounded px-1"
                  >
                    {t('folders.allFiles')}
                  </button>
                </BreadcrumbLink>
              )
            )}
          </BreadcrumbItem>
          <AnimatePresence initial={false}>
            {path.map((folder, index) => (
              <Fragment key={folder.id}>
                <BreadcrumbSeparator>
                  <motion.span
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={motionQuick}
                  >
                    <ChevronRight className="size-3.5" aria-hidden />
                  </motion.span>
                </BreadcrumbSeparator>
                <BreadcrumbItem>
                  <motion.span
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    transition={motionQuick}
                  >
                    {index === path.length - 1 ? (
                      <BreadcrumbPage className="max-w-48 truncate font-medium">{folder.name}</BreadcrumbPage>
                    ) : (
                      crumb(
                        folder.id,
                        folder.name,
                        <BreadcrumbLink asChild>
                          <button
                            type="button"
                            className="max-w-48 truncate hover:text-foreground transition-colors px-1"
                            onClick={() => onNavigate(folder.id)}
                          >
                            {folder.name}
                          </button>
                        </BreadcrumbLink>
                      )
                    )}
                  </motion.span>
                </BreadcrumbItem>
              </Fragment>
            ))}
          </AnimatePresence>
        </BreadcrumbList>
      </Breadcrumb>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {readOnly ? (
          <FolderReadOnlyBadge testId="folder-level-read-only" />
        ) : (
          onCreateFolder && (
            <NewFolderControl currentFolderId={currentFolderId} onCreateFolder={onCreateFolder} />
          )
        )}
      </div>
    </div>
  )
}

/**
 * "New folder" as a popover form: name it where you stand, Enter creates it in
 * the CURRENT level. Failure keeps the popover open with the typed name — the
 * workspace surfaces the error toast.
 */
function NewFolderControl({
  currentFolderId,
  onCreateFolder,
}: Pick<FolderNavProps, 'currentFolderId' | 'onCreateFolder'>): JSX.Element {
  const t = useTranslations('files')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const commit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || isCreating) return
    setIsCreating(true)
    const ok = await onCreateFolder(trimmed, currentFolderId ?? undefined)
    setIsCreating(false)
    if (ok) {
      setName('')
      setOpen(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => (isCreating ? undefined : setOpen(next))}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="gap-1.5">
          <FolderPlus className="size-4" aria-hidden />
          {/* A glyph on a phone: the path row has the width for where you are or for two words, and where you are wins. */}
          <span className="phone:sr-only">{t('folders.newFolder')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <InputGroup>
          <InputGroupAddon align="start" className="left-2">
            <Folder aria-hidden />
          </InputGroupAddon>
          <Input
            autoFocus
            value={name}
            disabled={isCreating}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commit()
            }}
            placeholder={t('folders.namePlaceholder')}
            aria-label={t('folders.newFolderName')}
            aria-busy={isCreating}
            className="h-8 rounded-md pl-8 pr-8"
          />
          {isCreating && (
            <InputGroupAddon align="end">
              <Spinner size="sm" label={t('folders.creating')} />
            </InputGroupAddon>
          )}
        </InputGroup>
      </PopoverContent>
    </Popover>
  )
}

interface FolderTileProps {
  folder: FolderItem
  /** Documents + subfolders directly inside, for the count line. */
  itemCount: number
  /** Most recent child's timestamp — the "last change" for this folder, like file cards show file time. */
  lastModified?: string | null
  /**
   * Where the folder's whole subtree stands with Piloti (`subtreeTallies`): a
   * dot beside the name on a tile, the dot and its words on a list-view row.
   */
  knowledge?: KnowledgeTally
  onOpen: (id: string) => void
  onRenameFolder: FolderNavProps['onRenameFolder']
  onDeleteFolder: FolderNavProps['onDeleteFolder']
  /** Replaces the built-in ⋯ when the caller owns the menu (right-click + overflow). */
  actions?: ReactNode
  /** Controlled rename; omit to keep the in-place editor private to the tile. */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  /**
   * Move a document into this folder, when the surface supports dragging one
   * here. Absent on surfaces that do not (the Archiv has no folders at all).
   */
  onDropDocument?: (documentId: string, folderId: string | null) => void
  /**
   * Re-parent another folder into this one. Absent turns the folder drag OFF
   * for this tile in both directions: a tile that lifts under the finger where
   * nothing can receive it promises a move the surface cannot make.
   */
  onDropFolder?: (draggedFolderId: string, parentId: string | null) => void
  /** Whether this tile may receive that folder — see `useFolderDropTarget`. */
  canAcceptFolder?: (draggedFolderId: string, targetFolderId: string | null) => boolean
  /**
   * The reader may only read here (ADR-0088): „Nur lesen" beside the name, and
   * nothing can be dropped on the tile. The server refuses a write anyway.
   */
  readOnly?: boolean
  /** Files from the desktop released on this folder go into it. Absent leaves them to the surface. */
  onDropFiles?: DropFilesInFolder
  /** Told where desktop files would land while they hover the tile. */
  onFileAim?: (aim: FileDropAim | null) => void
}

/** Files dropped from the desktop into a folder; `null` is the shelf's top level. */
export type DropFilesInFolder = (
  files: File[],
  info: { truncated: boolean; unreadable: number },
  folderId: string | null
) => void

/** The ring a drop target wears: where it will land, or that it will not take it. */
function dropRing(drop: { isOver: boolean; refuses: boolean }, inset = false): string | false {
  if (drop.refuses) return cn('ring-destructive ring-2', inset && 'ring-inset')
  return drop.isOver && cn('bg-accent ring-ring ring-2', inset && 'ring-inset')
}

/**
 * One way up, as a drop target: a segment of the path, „Alle Dateien", or the
 * back control. Dropping on it moves the document or folder to that level,
 * and desktop files land there.
 *
 * Only „Alle Dateien" took a drop, so a document three levels down could go
 * to the top or deeper, never one level up, and the back control, the biggest
 * way up on screen, took nothing.
 */
function CrumbDropTarget({
  folderId,
  label,
  writable,
  onDropDocument,
  onDropFolder,
  canAcceptFolder,
  onDropFiles,
  onFileAim,
  onSpringOpen,
  children,
}: {
  folderId: string | null
  label: string
  /** Held over, the drag walks up to that level. */
  onSpringOpen?: () => void
  /** The reader may write at that level (ADR-0088): otherwise nothing lands there. */
  writable: boolean
  onDropDocument?: (documentId: string, folderId: string | null) => void
  onDropFolder?: (draggedFolderId: string, parentId: string | null) => void
  canAcceptFolder?: (draggedFolderId: string, targetFolderId: string | null) => boolean
  onDropFiles?: DropFilesInFolder
  onFileAim?: (aim: FileDropAim | null) => void
  children: ReactNode
}): JSX.Element {
  const t = useTranslations('files')
  const drop = useFolderDropTarget({
    folderId,
    onDropDocument: onDropDocument ?? (() => {}),
    onDropFolder,
    canAcceptFolder,
    disabled: !onDropDocument && !onDropFolder,
    onDropFiles,
    refusal: writable ? null : t('workspace.dropRefusedFolder', { name: label }),
    onFileAim,
    onSpringOpen,
  })
  return (
    <span
      className={cn('inline-flex rounded-md transition-colors', dropRing(drop))}
      data-drop-over={drop.isOver ? '' : undefined}
      data-testid={`crumb-drop-${folderId ?? 'root'}`}
      {...drop.dropProps}
    >
      {children}
    </span>
  )
}

/**
 * The open button's accessible name, and the lock's tooltip on a folder with
 * its own access list (ADR-0088, `folder.ownAccess`): a restricted folder says
 * so in both. Null `lockLabel` draws no lock.
 */
function useFolderLabels(folder: FolderItem): { openLabel: string; lockLabel: string | null } {
  const t = useTranslations('files')
  const ownAccessLabel = useFolderOwnAccessLabel()
  const lockLabel = folder.ownAccess ? ownAccessLabel(folder.ownAccess) : null
  return {
    lockLabel,
    openLabel: lockLabel
      ? t('folders.access.openRestricted', { name: folder.name, access: lockLabel })
      : t('folders.openFolder', { name: folder.name }),
  }
}

/** Shared inline rename field — same in-place contract the tree pane had. */
function FolderNameEditor({
  folder,
  onRenameFolder,
  onDone,
  className,
}: {
  folder: FolderItem
  onRenameFolder: FolderNavProps['onRenameFolder']
  onDone: () => void
  className?: string
}): JSX.Element {
  const t = useTranslations('files')
  const [value, setValue] = useState(folder.name)
  const [isRenaming, setIsRenaming] = useState(false)

  const commit = async (): Promise<void> => {
    const name = value.trim()
    if (isRenaming) return
    if (!name || name === folder.name) {
      onDone()
      return
    }
    setIsRenaming(true)
    const ok = await onRenameFolder(folder.id, name)
    setIsRenaming(false)
    // On failure the field stays open with the typed name intact.
    if (ok) onDone()
  }

  return (
    <InputGroup className={className}>
      <InputGroupAddon align="start" className="left-2">
        <Folder aria-hidden />
      </InputGroupAddon>
      <Input
        autoFocus
        value={value}
        disabled={isRenaming}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
          if (event.key === 'Escape') onDone()
        }}
        aria-label={t('folders.renameLabel', { name: folder.name })}
        aria-busy={isRenaming}
        className="h-8 rounded-md pl-8 pr-8 text-sm"
        data-testid={`folder-rename-input-${folder.id}`}
      />
      {isRenaming && (
        <InputGroupAddon align="end">
          <Spinner size="sm" label={t('folders.renaming')} />
        </InputGroupAddon>
      )}
    </InputGroup>
  )
}

function FolderActionsMenu({
  folder,
  onStartRename,
  onDeleteFolder,
}: {
  folder: FolderItem
  onStartRename: () => void
  onDeleteFolder: FolderNavProps['onDeleteFolder']
}): JSX.Element {
  const t = useTranslations('files')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('folders.actionsFor', { name: folder.name })}
          title={t('folders.actions')}
          className="hover:bg-accent focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-sm transition-opacity duration-snap ease-out focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 pointer-coarse:size-11 pointer-coarse:opacity-100 motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100"
          data-testid={`folder-actions-${folder.id}`}
        >
          <MoreHorizontal className="size-3.5" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={onStartRename}>
          <Pencil className="size-4" aria-hidden />
          {t('folders.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void onDeleteFolder(folder.id)}
          data-testid={`folder-delete-${folder.id}`}
        >
          <Trash2 className="size-4" aria-hidden />
          {t('folders.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Put on the grid that holds folder tiles: below `phone` each one spans the
 * row, so folders read as a list ahead of the files. The CELL is whatever the
 * context menu wraps the tile in, which this file does not own, so the grid
 * finds it by the mark the tile carries.
 */
export const FOLDER_ROWS_ON_PHONE = 'phone:[&>*:has([data-folder-tile])]:col-span-full'

/**
 * The folder glyph's well: 124px of media on a card, a 44px square beside the
 * name on a phone, where the tile is a row (see {@link FolderCard}).
 */
const FOLDER_WELL =
  'flex h-[124px] items-center justify-center bg-muted/30 phone:size-10 phone:h-10 phone:shrink-0 phone:rounded-lg phone:border-0'

/**
 * A folder as a grid tile — visually DISTINCT from {@link FileCard}.
 *
 * A file card shows the document itself: a page preview, a thumbnail, or the
 * kind sketch we draw when there is neither. A folder card shows a folder
 * filling that same well, and the difference between "a page" and "a container"
 * is the whole distinction. It used to be carried by a warm amber wash as well;
 * that wash was invisible at its own opacity in the grid and read as a warning
 * strip in the detail view, and gold is a provenance signal in this product
 * (see `grid-tile.tsx` for the argument). What is left is the thing that was
 * doing the work.
 *
 * Hover lifts the tile — the shell's own `whileHover`, and the one motion this
 * gesture gets. The glyph used to open on hover as well; see the comment on the
 * well below for why a mouse-only flourish is not one this product keeps.
 */
export function FolderCard({
  folder,
  itemCount,
  lastModified,
  knowledge,
  onOpen,
  onRenameFolder,
  onDeleteFolder,
  onDropDocument,
  onDropFolder,
  canAcceptFolder,
  actions,
  editing: editingProp,
  onEditingChange,
  readOnly = false,
  onDropFiles,
  onFileAim,
}: FolderTileProps): JSX.Element {
  const t = useTranslations('files')
  const { openLabel, lockLabel } = useFolderLabels(folder)
  const { locale } = useLocale()
  const [uncontrolledEditing, setUncontrolledEditing] = useState(false)
  const editing = editingProp ?? uncontrolledEditing
  const setEditing = onEditingChange ?? setUncontrolledEditing
  const drop = useFolderDropTarget({
    folderId: folder.id,
    onDropDocument: onDropDocument ?? (() => {}),
    onDropFolder,
    canAcceptFolder,
    disabled: !onDropDocument && !onDropFolder,
    onDropFiles,
    refusal: readOnly ? t('workspace.dropRefusedFolder', { name: folder.name }) : null,
    onFileAim,
    onSpringOpen: () => onOpen(folder.id),
  })

  return (
    <GridTileShell
      interactive
      // On a phone a folder is a row across the grid, not a 166px tile: the
      // first screen shows where the files are before it shows what holds them.
      // The grid spans it (`FOLDER_ROWS_ON_PHONE`, found by this mark).
      data-folder-tile=""
      // A drag has to say where it will land, or it is a guess with a cursor.
      className={cn('group phone:bg-card phone:[contain-intrinsic-block-size:auto_56px]', dropRing(drop))}
      data-testid={`folder-card-${folder.id}`}
      data-drop-over={drop.isOver ? '' : undefined}
      // Source as well as target: a folder is moved by dragging it onto
      // another, which is the same gesture that moves a document.
      {...(onDropFolder && !readOnly && !editing ? folderDragProps(folder.id, folder.parentId ?? null) : {})}
      {...drop.dropProps}
    >
      <div
        className="absolute right-1.5 top-1.5 z-[1] phone:top-1/2 phone:-translate-y-1/2 pointer-coarse:opacity-100 md:opacity-0 md:group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100 transition-opacity duration-quick ease-out motion-reduce:transition-none"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {actions ?? (
          <FolderActionsMenu folder={folder} onStartRename={() => setEditing(true)} onDeleteFolder={onDeleteFolder} />
        )}
      </div>
      {/*
        THE NAME FIELD IS NEVER INSIDE THE OPEN BUTTON.

        It was, and every click into the field to place the caret bubbled to
        the button and opened the folder (#1055). An <input> inside a <button>
        is invalid HTML besides. While renaming, the same body renders in a
        plain wrapper and nothing on the tile opens the folder; the list row
        swaps its whole content for the editor for the same reason.
      */}
      <FolderCardFrame
        editing={editing}
        onOpen={() => onOpen(folder.id)}
        openLabel={openLabel}
      >
        <GridTileBody className="flex-1 p-0 phone:flex phone:items-center phone:gap-3 phone:bg-transparent phone:p-2 phone:shadow-none">
          <GridTileMedia className={FOLDER_WELL}>
            {/*
              ONE GLYPH, AND NO SECOND MOTION FOR ONE GESTURE.

              This used to swap `Folder` for `FolderOpen` on hover, driven by
              `useState` through `onMouseEnter`/`onMouseLeave` — a render per
              pointer crossing on every tile in the grid, and a hard cut in the
              middle of a scale, so what a person saw was a flicker rather than
              a folder opening.

              Rebuilding it as a CSS cross-fade fixed the flicker and the
              renders and left the real problem: it was an affordance only a
              MOUSE could reach. `mobile-affordances.spec.ts` says so by name —
              an `opacity-0` revealed by `group-hover` alone, on a device that
              generates no hover — and the escapes it offers do not apply,
              because showing both stacked glyphs on a phone is not the answer.

              So the swap is gone. What says "this opens" is what already said
              it on every input: the tile lifts under the pointer (the shell's
              own `whileHover`), the cursor changes, and the label reads as a
              folder because a folder is drawn in the well.
            */}
            <Folder className="size-10 text-muted-foreground/60 phone:size-5" strokeWidth={1.4} aria-hidden />
          </GridTileMedia>
          <div className="px-3.5 pb-3 pt-[11px] phone:min-w-0 phone:flex-1 phone:p-0">
            {editing ? (
              <FolderNameEditor folder={folder} onRenameFolder={onRenameFolder} onDone={() => setEditing(false)} />
            ) : (
              <div className="flex min-w-0 items-center gap-1.5">
                {lockLabel && <FolderAccessMark label={lockLabel} testId={`folder-lock-${folder.id}`} />}
                <p className="min-w-0 text-sm font-medium leading-tight text-foreground phone:text-[15px]">
                  <FileName text={folder.name} />
                </p>
                {readOnly && <FolderReadOnlyBadge testId={`folder-read-only-${folder.id}`} />}
                {/* The dot alone, after the name: what a folder holds at a
                    glance, without a line of words on every tile. */}
                <FolderReadState tally={knowledge} dotOnly className="ml-auto" />
              </div>
            )}
            {/* What belongs in it, in the folder owner's words: one quiet line,
                whole on hover. */}
            {!editing && folder.description && (
              <p
                className="mt-1 truncate text-xs leading-tight text-muted-foreground"
                title={folder.description}
                data-testid={`folder-description-${folder.id}`}
              >
                {folder.description}
              </p>
            )}
          </div>
        </GridTileBody>
        {/* On a phone the count sits at the row's right, clear of the ⋯ (44px
            on a coarse pointer), and the age stays in the detail view: the row
            has the width for the name or for the date, and the name wins. */}
        <GridTileFooter className="min-w-0 gap-1.5 px-3.5 pb-2.5 pt-[9px] text-xs text-muted-foreground/80 phone:mt-0 phone:w-auto phone:shrink-0 phone:py-0 phone:pl-0 phone:pr-14">
          <span className="min-w-0 truncate tabular-nums">
            {t('folders.items', { count: itemCount })}
            {lastModified && (
              <span className="phone:hidden">
                <span aria-hidden className="mx-1.5 text-muted-foreground/40">
                  ·
                </span>
                <TimeAgo date={lastModified} locale={locale} className="tabular-nums" />
              </span>
            )}
          </span>
        </GridTileFooter>
      </FolderCardFrame>
    </GridTileShell>
  )
}

/** The tile's open button, or a plain box with the same layout while the name is being edited. */
function FolderCardFrame({
  editing,
  onOpen,
  openLabel,
  children,
}: {
  editing: boolean
  onOpen: () => void
  openLabel: string
  children: ReactNode
}): JSX.Element {
  if (editing) return <div className="flex h-full w-full flex-col text-left phone:flex-row phone:items-center">{children}</div>
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={openLabel}
      className="flex h-full w-full flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 phone:flex-row phone:items-center"
    >
      {children}
    </button>
  )
}

/**
 * A folder as a detail-view row — the list view's counterpart to
 * {@link FolderCard}, rendered as a block above the sortable file table (a
 * folder does not sort by size or status, so it does not sit inside it).
 */
export function FolderRow({
  folder,
  itemCount,
  lastModified,
  knowledge,
  onOpen,
  onRenameFolder,
  onDeleteFolder,
  onDropDocument,
  onDropFolder,
  canAcceptFolder,
  actions,
  editing: editingProp,
  onEditingChange,
  readOnly = false,
  onDropFiles,
  onFileAim,
}: FolderTileProps): JSX.Element {
  const t = useTranslations('files')
  const { openLabel, lockLabel } = useFolderLabels(folder)
  const { locale } = useLocale()
  const [uncontrolledEditing, setUncontrolledEditing] = useState(false)
  const editing = editingProp ?? uncontrolledEditing
  const setEditing = onEditingChange ?? setUncontrolledEditing
  const drop = useFolderDropTarget({
    folderId: folder.id,
    onDropDocument: onDropDocument ?? (() => {}),
    onDropFolder,
    canAcceptFolder,
    disabled: !onDropDocument && !onDropFolder,
    onDropFiles,
    refusal: readOnly ? t('workspace.dropRefusedFolder', { name: folder.name }) : null,
    onFileAim,
    onSpringOpen: () => onOpen(folder.id),
  })

  if (editing) {
    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-2 px-2 py-1"
      >
        <FolderNameEditor
          folder={folder}
          onRenameFolder={onRenameFolder}
          onDone={() => setEditing(false)}
          className="max-w-96 flex-1"
        />
      </motion.div>
    )
  }

  /*
   * THE ROW THAT WAS YELLOW.
   *
   * It was `bg-amber-50/40` with an amber icon well, an amber count pill and an
   * amber chevron — three tinted bands across the full width of a listing,
   * stacked above a neutral table. Two things were wrong with it, and the
   * second is the one that made it read as a warning:
   *
   *   1. Chroma in this product is the source-signal system and nothing else
   *      (`grid-design-language.md`). A folder is not a provenance.
   *   2. That gold IS a signal, and it is in the same table: `--source-office`
   *      is the tint on the `JPG` and `PNG` extension chips two rows below. One
   *      hue, two unrelated meanings, one screen.
   *
   * So the row is built out of the neutral ramp, like every other list
   * affordance, and what says "folder" is the glyph and the chevron — shape and
   * contrast, which is what the design language reaches for instead of colour.
   *
   * It also no longer animates itself in. It is rendered inside the level's own
   * keyed transition, so the row slid −6px while its container slid +16px: two
   * motions for one navigation, compounding into a wobble. The level owns the
   * entrance; a row inside it is just content.
   */
  // One row of the folder run, which `file-browser-pane` draws as an `ItemList`.
  // The list clips the outer corners and draws the hairlines, so the row carries
  // no radius, border or shadow of its own. A drop target is marked inside its
  // box (`ring-inset`): an outer ring on the first or last row would be clipped.
  return (
    <Item
      className={cn(
        'group w-full gap-2 px-3 py-2 text-sm',
        dropRing(drop, true),
      )}
      data-testid={`folder-row-${folder.id}`}
      data-drop-over={drop.isOver ? '' : undefined}
      {...(onDropFolder && !readOnly ? folderDragProps(folder.id, folder.parentId ?? null) : {})}
      {...drop.dropProps}
    >
      <button
        type="button"
        onClick={() => onOpen(folder.id)}
        aria-label={openLabel}
        className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
      >
        {/* One glyph, for the reason the card's comment gives. The row's own
            background change is the hover feedback, and a finger gets it too. */}
        <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
          <Folder className="text-muted-foreground size-3.5" aria-hidden />
        </span>
        <FileName text={folder.name} className="text-foreground shrink font-medium" />
        {folder.description && (
          <span
            className="text-muted-foreground hidden min-w-0 truncate text-xs sm:inline"
            title={folder.description}
            data-testid={`folder-description-${folder.id}`}
          >
            {folder.description}
          </span>
        )}
        {lockLabel && <FolderAccessMark label={lockLabel} testId={`folder-lock-${folder.id}`} />}
        {readOnly && <FolderReadOnlyBadge testId={`folder-read-only-${folder.id}`} />}
        {/* The kit's numeric pill, not a fourth hand-rolled one. */}
        <CountPill count={itemCount} />
        {lastModified && (
          <>
            <span aria-hidden className="text-muted-foreground/40 text-xs phone:hidden">
              ·
            </span>
            <TimeAgo date={lastModified} locale={locale} className="shrink-0 text-xs tabular-nums text-muted-foreground phone:hidden" />
          </>
        )}
        <span className="flex-1" />
        <FolderReadState tally={knowledge} />
      </button>
      {actions ?? (
        <FolderActionsMenu
          folder={folder}
          onStartRename={() => setEditing(true)}
          onDeleteFolder={onDeleteFolder}
        />
      )}
      <ChevronRight
        className="text-muted-foreground/40 group-hover:text-muted-foreground size-3.5 shrink-0 transition-colors duration-quick ease-out motion-reduce:transition-none"
        aria-hidden
      />
    </Item>
  )
}

/**
 * The three folder placeholders, kept in this file on purpose.
 *
 * A skeleton is a promise about the layout that is one frame away, and the only
 * way it keeps that promise is by being edited in the same breath as the thing
 * it stands for. The Files skeleton drifted precisely because it lived
 * somewhere else: it drew a full-width search bar the page had moved into its
 * header a release earlier, and no folder tiles at all, so the first paint
 * showed a shape that was never going to arrive.
 *
 * Each one reuses the REAL wrapper — the same shell, the same row chrome, the
 * same padding — so a change to the tile moves its placeholder with it and only
 * the ink inside is grey.
 */

/** A {@link FolderCard} before its name arrives. */
export function FolderCardSkeleton(): JSX.Element {
  return (
    <GridTileShell
      interactive={false}
      data-folder-tile=""
      className="phone:flex-row phone:items-center phone:bg-card"
      data-testid="folder-card-skeleton"
    >
      <GridTileBody className="flex-1 p-0 phone:flex phone:items-center phone:gap-3 phone:bg-transparent phone:p-2 phone:shadow-none">
        <GridTileMedia className={FOLDER_WELL}>
          <Folder className="size-10 text-muted-foreground/25 phone:size-5" strokeWidth={1.4} aria-hidden />
        </GridTileMedia>
        <div className="px-3.5 pb-3 pt-[11px] phone:p-0">
          <Skeleton className="h-4 w-24" />
        </div>
      </GridTileBody>
      <GridTileFooter className="gap-1.5 px-3.5 pb-2.5 pt-[9px] phone:mt-0 phone:w-auto phone:py-0 phone:pl-0 phone:pr-4">
        <Skeleton className="h-3 w-12" />
      </GridTileFooter>
    </GridTileShell>
  )
}

/** A {@link FolderRow} before its name arrives. */
export function FolderRowSkeleton(): JSX.Element {
  return (
    <Item className="w-full gap-2 px-3 py-2" data-testid="folder-row-skeleton">
      <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
        <Folder className="text-muted-foreground/40 size-3.5" aria-hidden />
      </span>
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="h-3.5 w-8 rounded-full" />
    </Item>
  )
}

/**
 * The path row before the tree is known.
 *
 * The same chrome as {@link FolderBreadcrumbRow} — border, tint, height — so
 * the listing below it does not shift down by a row when the real one replaces
 * it. „Alle Dateien" is drawn rather than greyed out: it is the one segment
 * that is true before anything has loaded, at every level, and a reader who
 * lands mid-load should see where they are rather than a grey pill where the
 * word will be.
 */
export function FolderBreadcrumbRowSkeleton(): JSX.Element {
  const t = useTranslations('files')
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-2 border-b bg-card/50 px-4 py-2.5 backdrop-blur-sm"
      data-testid="folder-breadcrumb-skeleton"
    >
      <span className="text-sm font-medium text-muted-foreground">{t('folders.allFiles')}</span>
      <Skeleton className="h-8 w-28 rounded-md" />
    </div>
  )
}
