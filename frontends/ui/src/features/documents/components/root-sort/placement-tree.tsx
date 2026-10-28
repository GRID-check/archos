'use client'

/**
 * The proposal as a folder tree: what Piloti would file where, with a switch
 * per file and per folder, and a „Verschieben nach …“ per file that picks
 * another folder or the root.
 *
 * Drawn from the model (`../../lib/placement-tree`); it decides nothing. A
 * folder is open when the reader opened it, and an unsure-only review opens the
 * folders that hold something unsure by default. Built from the same atoms the
 * Ablage tree uses (Checkbox, Badge, Button), not a lookalike of its own.
 */

import type { CSSProperties, JSX } from 'react'
import { useMemo, useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  FileText,
  Undo2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import type { RootSortFolder } from '@/lib/filing/root-sort-types'
import { cn } from '@/lib/utils'
import {
  folderKept,
  type FileNode,
  type FolderNode,
  type PlacementTree,
  type RetargetChoice,
} from '../../lib/placement-tree'

export interface PlacementTreeViewProps {
  tree: PlacementTree
  /** Every folder of the shelf: where a file may be sent. */
  folders: readonly RootSortFolder[]
  /** Only the unsure placements are on screen: folders holding one open by default. */
  onlyUnsure: boolean
  onToggleFile: (documentId: string, kept: boolean) => void
  onToggleFolder: (node: FolderNode, kept: boolean) => void
  onRetarget: (documentId: string, choice: RetargetChoice) => void
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })

/** Room for the chevron (pulled 28px left) plus 8px to the card's edge, then 20px a level. */
const indent = (depth: number): CSSProperties => ({
  paddingInlineStart: `${36 + (depth - 1) * 20}px`,
})

const ROW = 'border-border/60 flex min-h-11 items-center gap-2 border-t pr-3 text-sm'

export function PlacementTreeView({
  tree,
  folders,
  onlyUnsure,
  onToggleFile,
  onToggleFolder,
  onRetarget,
}: PlacementTreeViewProps): JSX.Element {
  const t = useTranslations(filesCopy)
  // Open state the reader set, by folder path; absent means the default.
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const isOpen = (node: FolderNode): boolean =>
    opened.get(node.path) ?? (onlyUnsure && node.unsureBelow > 0)
  const flip = (node: FolderNode): void =>
    setOpened((current) => new Map(current).set(node.path, !isOpen(node)))
  const targets = useMemo(
    () => [...folders].sort((a, b) => collator.compare(a.path, b.path)),
    [folders]
  )

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <ul
        aria-label={t('rootSort.review.treeLabel')}
        className="max-h-[min(60dvh,32rem)] overflow-y-auto"
      >
        {tree.folders.map((node) => (
          <FolderItem
            key={node.path}
            node={node}
            open={isOpen(node)}
            onFlip={flip}
            isOpen={isOpen}
            onToggleFile={onToggleFile}
            onToggleFolder={onToggleFolder}
            onRetarget={onRetarget}
            targets={targets}
          />
        ))}
      </ul>
      {!onlyUnsure && tree.stays.length > 0 && (
        <section aria-label={t('rootSort.review.staysLabel')} className="border-border border-t">
          <h3 className="text-muted-foreground bg-muted/40 px-3 py-2 text-[10.5px] font-medium tracking-wider uppercase">
            {t('rootSort.review.staysLabel')}
          </h3>
          <ul>
            {tree.stays.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                depth={1}
                onToggleFile={onToggleFile}
                onRetarget={onRetarget}
                targets={targets}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

interface FolderItemProps {
  node: FolderNode
  open: boolean
  onFlip: (node: FolderNode) => void
  isOpen: (node: FolderNode) => boolean
  onToggleFile: (documentId: string, kept: boolean) => void
  onToggleFolder: (node: FolderNode, kept: boolean) => void
  onRetarget: (documentId: string, choice: RetargetChoice) => void
  targets: readonly RootSortFolder[]
}

function FolderItem({
  node,
  open,
  onFlip,
  isOpen,
  onToggleFile,
  onToggleFolder,
  onRetarget,
  targets,
}: FolderItemProps): JSX.Element {
  const t = useTranslations(filesCopy)
  const kept = folderKept(node)
  const hasChildren = node.children.length > 0 || node.files.length > 0
  const count = node.placedBelow
  return (
    <li data-path={node.path}>
      <div
        className={cn(ROW, node.switchedOff && 'text-muted-foreground')}
        style={indent(node.depth)}
      >
        {hasChildren ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground -ml-7 size-7 shrink-0"
            aria-expanded={open}
            aria-label={
              open
                ? t('rootSort.tree.collapse', { name: node.name })
                : t('rootSort.tree.expand', { name: node.name })
            }
            onClick={() => onFlip(node)}
          >
            {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          </Button>
        ) : null}
        <Checkbox
          checked={kept}
          onCheckedChange={() => onToggleFolder(node, kept !== true)}
          aria-label={t('rootSort.tree.keepFolder', { name: node.name })}
        />
        {node.isNew ? (
          <FolderPlus className="text-muted-foreground size-4 shrink-0" aria-hidden />
        ) : (
          <Folder className="text-muted-foreground size-4 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 truncate">{node.name}</span>
        {node.isNew && (
          <Badge variant="info">
            {t(node.switchedOff ? 'rootSort.tree.switchedOffBadge' : 'rootSort.tree.newBadge')}
          </Badge>
        )}
        {node.switchedOff && node.heldBack > 0 && (
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            {t('rootSort.tree.heldBack', { count: node.heldBack })}
          </span>
        )}
        {count > 0 && (
          <span className="text-muted-foreground ml-auto shrink-0 pl-2 text-xs tabular-nums">
            {t('rootSort.tree.fileCount', { count })}
          </span>
        )}
      </div>
      {open && (
        <ul>
          {node.children.map((child) => (
            <FolderItem
              key={child.path}
              node={child}
              open={isOpen(child)}
              onFlip={onFlip}
              isOpen={isOpen}
              onToggleFile={onToggleFile}
              onToggleFolder={onToggleFolder}
              onRetarget={onRetarget}
              targets={targets}
            />
          ))}
          {node.files.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              depth={node.depth + 1}
              onToggleFile={onToggleFile}
              onRetarget={onRetarget}
              targets={targets}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

interface FileRowProps {
  file: FileNode
  depth: number
  onToggleFile: (documentId: string, kept: boolean) => void
  onRetarget: (documentId: string, choice: RetargetChoice) => void
  targets: readonly RootSortFolder[]
}

function FileRow({ file, depth, onToggleFile, onRetarget, targets }: FileRowProps): JSX.Element {
  const t = useTranslations(filesCopy)
  const placed = file.certainty !== null
  return (
    <li
      className={cn(ROW, !file.included && 'text-muted-foreground')}
      style={indent(depth)}
      data-document-id={file.id}
    >
      {placed ? (
        <Checkbox
          checked={file.included}
          onCheckedChange={() => onToggleFile(file.id, !file.included)}
          aria-label={t('rootSort.tree.keepFile', { name: file.name })}
        />
      ) : (
        <span className="size-4 shrink-0" aria-hidden />
      )}
      <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{file.name}</span>
      {file.certainty && (
        <Badge variant={file.certainty === 'sure' ? 'success' : 'warning'}>
          {t(file.certainty === 'sure' ? 'rootSort.tree.sure' : 'rootSort.tree.unsure')}
        </Badge>
      )}
      {file.chosenByPerson && <Badge variant="outline">{t('rootSort.tree.changed')}</Badge>}
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {file.reason || (placed || file.chosenByPerson ? '' : t('rootSort.tree.noReason'))}
      </span>
      <MoveMenu file={file} targets={targets} onRetarget={onRetarget} />
    </li>
  )
}

function MoveMenu({
  file,
  targets,
  onRetarget,
}: {
  file: FileNode
  targets: readonly RootSortFolder[]
  onRetarget: (documentId: string, choice: RetargetChoice) => void
}): JSX.Element {
  const t = useTranslations(filesCopy)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          aria-label={t('rootSort.tree.moveAria', { name: file.name })}
        >
          <ArrowRight aria-hidden />
          {/* On a phone the arrow alone: the file name needs the width, and the aria-label names the action. */}
          <span className="hidden sm:inline">{t('rootSort.tree.moveTo')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(60dvh,24rem)] w-72 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onRetarget(file.id, { kind: 'root' })}>
          <Undo2 className="size-4" aria-hidden />
          {t('rootSort.tree.stayInRoot')}
        </DropdownMenuItem>
        {file.chosenByPerson && (
          <DropdownMenuItem onSelect={() => onRetarget(file.id, { kind: 'proposal' })}>
            <Undo2 className="size-4" aria-hidden />
            {t('rootSort.tree.restore')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {targets.map((target) => (
          <DropdownMenuItem
            key={target.id}
            onSelect={() => onRetarget(file.id, { kind: 'folder', folderId: target.id })}
          >
            {target.path}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
