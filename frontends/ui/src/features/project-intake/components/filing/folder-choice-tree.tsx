'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import type { ExclusionReason } from './default-exclusions'
import { folderState, type ChosenTree, type ExcludedFolders, type FolderNode } from './folder-tree'

export interface FolderChoiceTreeProps {
  tree: ChosenTree
  excluded: ExcludedFolders
  /** Why Piloti proposed to leave a folder out, by its path. */
  proposed: ReadonlyMap<string, ExclusionReason>
  /** Files the sensitive-data list holds back in each folder and below. */
  heldIn: ReadonlyMap<string, number>
  onToggle: (path: string) => void
}

/** Open at the start: the top of the choice, and the inside of a single project folder. */
function initiallyOpen(tree: ChosenTree): Set<string> {
  const open = new Set<string>()
  const [only] = tree.root.children
  if (tree.root.children.length === 1 && only) open.add(only.path)
  return open
}

/** The folders on screen, in order, with the ones inside a closed folder left out. */
function visibleRows(node: FolderNode, open: ReadonlySet<string>): FolderNode[] {
  return node.children.flatMap((child) => [child, ...(open.has(child.path) ? visibleRows(child, open) : [])])
}

/**
 * The chosen project folder as a tree: one row per folder, with its files and
 * size, one switch for the whole subtree, why Piloti proposes to leave it out,
 * and how many of its files the sensitive-data list holds back. Files are
 * counted, never listed: a folder is confirmed whole.
 */
export function FolderChoiceTree({ tree, excluded, proposed, heldIn, onToggle }: FolderChoiceTreeProps): JSX.Element {
  const t = useTranslations('intakeFilingStep')
  const { locale } = useLocale()
  const [open, setOpen] = useState<Set<string>>(() => initiallyOpen(tree))
  const flip = (path: string): void =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const rows = visibleRows(tree.root, open)
  return (
    <ItemList as="ul" aria-label={t('tree.label')} data-testid="filing-tree">
      {rows.map((node) => {
        const state = folderState(excluded, node.path)
        const reason = proposed.get(node.path)
        const held = state === 'out' ? 0 : (heldIn.get(node.path) ?? 0)
        const isOpen = open.has(node.path)
        return (
          <Item
            as="li"
            key={node.path}
            className="gap-2 py-2"
            // The one indentation the tree needs; a row is otherwise the kit's.
            style={{ paddingInlineStart: `${0.5 + (node.depth - 1) * 1.25}rem` }}
            data-testid="filing-tree-row"
            data-path={node.path}
            data-state={state}
          >
            {node.children.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-expanded={isOpen}
                aria-label={t(isOpen ? 'tree.collapse' : 'tree.expand', { name: node.name })}
                onClick={() => flip(node.path)}
              >
                {isOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
              </Button>
            ) : (
              <span className="size-7 shrink-0" aria-hidden />
            )}
            <Checkbox
              checked={state === 'in' ? true : state === 'partial' ? 'indeterminate' : false}
              onCheckedChange={() => onToggle(node.path)}
              aria-label={t('tree.include', { name: node.name })}
            />
            <ItemMedia className="size-6">
              <Folder className="text-muted-foreground size-4" aria-hidden />
            </ItemMedia>
            <ItemContent>
              <ItemTitle className={state === 'out' ? 'text-muted-foreground line-through' : undefined}>
                {node.name}
              </ItemTitle>
              <ItemDescription>
                {t('tree.files', { count: node.fileCount })} · {formatBytes(node.size, locale)}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {reason && <Badge variant="outline">{t(`tree.reasons.${reason}`)}</Badge>}
              {held > 0 && (
                <Badge variant="warning">
                  <ShieldAlert aria-hidden />
                  {t('tree.held', { count: held })}
                </Badge>
              )}
            </ItemActions>
          </Item>
        )
      })}
      {tree.root.ownFiles > 0 && (
        <Item as="li" className="gap-2 py-2 pl-2" data-testid="filing-tree-loose">
          <span className="size-7 shrink-0" aria-hidden />
          <ItemMedia className="size-6">
            <FileText className="text-muted-foreground size-4" aria-hidden />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t('tree.looseFiles')}</ItemTitle>
            <ItemDescription>{t('tree.files', { count: tree.root.ownFiles })}</ItemDescription>
          </ItemContent>
        </Item>
      )}
    </ItemList>
  )
}
