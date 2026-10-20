'use client'

import type { CSSProperties, JSX, ReactNode } from 'react'
import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ExclusionReason } from './default-exclusions'
import { FilingCard } from './filing-atoms'
import { folderState, type ChoiceSummary, type ChosenTree, type ExcludedFolders, type FolderNode } from './folder-tree'

export interface FolderChoiceTreeProps {
  tree: ChosenTree
  excluded: ExcludedFolders
  /** Why Piloti proposed to leave a folder out, by its path. */
  proposed: ReadonlyMap<string, ExclusionReason>
  /** Files the sensitive-data list holds back in each folder and below. */
  heldIn: ReadonlyMap<string, number>
  summary: ChoiceSummary
  onToggle: (path: string) => void
}

/**
 * The folder the card is headed by: the one project folder when the choice is
 * that (as it is when it comes from the office server), else the choice itself.
 */
function headOf(tree: ChosenTree): FolderNode | null {
  const [only] = tree.root.children
  return tree.root.children.length === 1 && only && tree.root.ownFiles === 0 ? only : null
}

/** The folders on screen, in order, with the ones inside a closed folder left out. */
function visibleRows(node: FolderNode, open: ReadonlySet<string>): FolderNode[] {
  return node.children.flatMap((child) => [child, ...(open.has(child.path) ? visibleRows(child, open) : [])])
}

/** 16px to the card's edge, 24px a level: a subfolder's chevron sits in its parent's indent. */
const indent = (level: number): CSSProperties => ({ paddingInlineStart: `${16 + level * 24}px` })

const ROW = 'border-border/60 flex min-h-11 items-center gap-2.5 border-t pr-4 text-sm md:min-h-[42px]'

/**
 * The chosen project folder as the mockup's card: a head row with what is
 * switched on of it, one row per folder below with its files and size, one
 * switch for the whole subtree, why Piloti proposes to leave it out, and how
 * many of its files the sensitive-data list keeps on the server. Files are
 * counted, never listed: a folder is confirmed whole. A folder with subfolders
 * opens with the chevron in its indent.
 */
export function FolderChoiceTree({ tree, excluded, proposed, heldIn, summary, onToggle }: FolderChoiceTreeProps): JSX.Element {
  const t = useTranslations('intakeFilingStep')
  const { locale } = useLocale()
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const flip = (path: string): void =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const head = headOf(tree)
  const top = head ?? tree.root
  const rows = visibleRows(top, open)
  const levelOf = (node: FolderNode): number => node.depth - top.depth
  const headState = head ? folderState(excluded, head.path) : null

  return (
    <FilingCard aria-label={t('tree.label')} data-testid="filing-choice">
      <div className={cn(ROW, 'bg-muted/40 rounded-t-[14px] border-t-0 font-medium')} style={indent(0)}>
        {head && headState ? (
          <Checkbox
            checked={headState === 'in' ? true : headState === 'partial' ? 'indeterminate' : false}
            onCheckedChange={() => onToggle(head.path)}
            aria-label={t('tree.include', { name: head.name })}
          />
        ) : null}
        <span className="min-w-0 truncate">{head?.name ?? t('tree.allChosen')}</span>
        <Meta>
          {t('tree.chosenOf', {
            files: summary.files,
            total: summary.totalFiles,
            size: formatBytes(summary.size, locale),
          })}
        </Meta>
      </div>
      <ul data-testid="filing-tree">
        {rows.map((node) => {
          const state = folderState(excluded, node.path)
          const reason = proposed.get(node.path)
          const held = state === 'out' ? 0 : (heldIn.get(node.path) ?? 0)
          const isOpen = open.has(node.path)
          return (
            <li
              key={node.path}
              className={cn(ROW, state === 'out' && 'text-muted-foreground')}
              style={indent(levelOf(node))}
              data-testid="filing-tree-row"
              data-path={node.path}
              data-state={state}
            >
              {node.children.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground touch-target -ml-[34px] size-6 shrink-0 pointer-coarse:size-6"
                  aria-expanded={isOpen}
                  aria-label={t(isOpen ? 'tree.collapse' : 'tree.expand', { name: node.name })}
                  onClick={() => flip(node.path)}
                >
                  {isOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                </Button>
              )}
              <Checkbox
                checked={state === 'in' ? true : state === 'partial' ? 'indeterminate' : false}
                onCheckedChange={() => onToggle(node.path)}
                aria-label={t('tree.include', { name: node.name })}
              />
              <span className="min-w-0 truncate">{node.name}</span>
              {reason && (
                <Badge variant="secondary" className="rounded-full font-normal">
                  {t(`tree.reasons.${reason}`)}
                </Badge>
              )}
              {held > 0 && (
                <Badge variant="warning" className="rounded-full">
                  {t('tree.held', { count: held })}
                </Badge>
              )}
              <Meta>{t('tree.meta', { count: node.fileCount, size: formatBytes(node.size, locale) })}</Meta>
            </li>
          )
        })}
        {tree.root.ownFiles > 0 && (
          <li className={ROW} style={indent(1)} data-testid="filing-tree-loose">
            <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{t('tree.looseFiles')}</span>
            <Meta>{tree.root.ownFiles}</Meta>
          </li>
        )}
      </ul>
    </FilingCard>
  )
}

function Meta({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="text-muted-foreground ml-auto shrink-0 pl-2 text-xs font-normal tabular-nums">{children}</span>
  )
}
